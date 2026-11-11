const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'colourprediction_secret_2024';
const DB_FILE = path.join(__dirname, 'db.json');

// ─── Constants ─────────────────────────────────────────────────────────────────
const RULES = {
    MIN_WITHDRAW: 300,
    MIN_DEPOSITS: 200,
    MIN_REFERRALS: 3,
    MIN_BET_FOR_ACTIVE: 1,
    ROUND_DURATION: 120,      // seconds per round
    RESULT_DELAY: 10,         // seconds after result before new round starts
    INACTIVE_DAYS: 15         // days before account suspension
};

// ─── DB ────────────────────────────────────────────────────────────────────────
function loadDB() {
    if (!fs.existsSync(DB_FILE)) {
        const init = {
            users: [], rounds: [], bankAccounts: [], upiAccounts: [],
            depositRequests: [], withdrawalRequests: [],
            notifications: [], currentBankIndex: 0
        };
        fs.writeFileSync(DB_FILE, JSON.stringify(init, null, 2));
        return init;
    }
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
    if (!db.upiAccounts) db.upiAccounts = [];
    if (!db.notifications) db.notifications = [];
    return db;
}
function saveDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

function generateReferralCode(username) {
    return `CW-${username.slice(0, 3).toUpperCase()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

// ─── Eligibility ───────────────────────────────────────────────────────────────
function checkWithdrawalEligibility(user, db) {
    const reasons = [];
    const betsByUser = {};
    for (const round of db.rounds)
        for (const bet of (round.bets || []))
            betsByUser[bet.userId] = (betsByUser[bet.userId] || 0) + 1;

    const referrals = db.users.filter(u => u.referredBy === user.id);
    const activeReferrals = referrals.filter(u => (betsByUser[u.id] || 0) >= RULES.MIN_BET_FOR_ACTIVE);
    const totalDeposited = user.totalDeposited || 0;

    if ((user.balance || 0) < RULES.MIN_WITHDRAW) reasons.push(`Balance must be >= Rs.${RULES.MIN_WITHDRAW}`);
    if (totalDeposited < RULES.MIN_DEPOSITS) reasons.push(`Total deposits must be >= Rs.${RULES.MIN_DEPOSITS} (current: Rs.${totalDeposited})`);
    if (activeReferrals.length < RULES.MIN_REFERRALS) reasons.push(`Need ${RULES.MIN_REFERRALS} active referrals (have ${activeReferrals.length})`);

    return { eligible: reasons.length === 0, reasons, totalDeposited, referrals: referrals.length, activeReferrals: activeReferrals.length, balance: user.balance || 0 };
}

// ─── Inactivity Check ──────────────────────────────────────────────────────────
function isUserSuspended(user) {
    if (user.forceSuspended) return true;
    if (!user.lastActiveAt) return false;
    const diffDays = (Date.now() - new Date(user.lastActiveAt).getTime()) / (1000 * 60 * 60 * 24);
    return diffDays > RULES.INACTIVE_DAYS;
}

function touchActivity(db, userId) {
    const user = db.users.find(u => u.id === userId);
    if (user) user.lastActiveAt = new Date().toISOString();
}

// ─── Game State ────────────────────────────────────────────────────────────────
let gameState = {
    roundId: null, phase: 'waiting', timeLeft: RULES.ROUND_DURATION,
    bets: {}, result: null, bettingOpen: true
};
let timerInterval = null;
let resultHistory = [];

function startNewRound() {
    if (timerInterval) clearInterval(timerInterval);
    gameState.roundId = Date.now();
    gameState.phase = 'betting';
    gameState.timeLeft = RULES.ROUND_DURATION;
    gameState.bets = {};
    gameState.result = null;
    gameState.bettingOpen = true;

    io.emit('round:new', { roundId: gameState.roundId, timeLeft: gameState.timeLeft });
    io.emit('game:state', getPublicState());

    timerInterval = setInterval(() => {
        if (gameState.phase !== 'betting') return;
        gameState.timeLeft -= 1;
        io.emit('timer:tick', { timeLeft: gameState.timeLeft });

        if (gameState.timeLeft <= 0) {
            clearInterval(timerInterval);
            timerInterval = null;
            gameState.phase = 'closed';
            gameState.bettingOpen = false;
            io.emit('timer:expired');
            io.emit('game:state', getPublicState());
            // Admin now sees bets and can set result manually
        }
    }, 1000);
}

function getPublicState() {
    return {
        roundId: gameState.roundId, phase: gameState.phase,
        timeLeft: gameState.timeLeft, result: gameState.result,
        bettingOpen: gameState.bettingOpen
    };
}

function getLiveBets() {
    const summary = { red: { count: 0, total: 0 }, green: { count: 0, total: 0 }, violet: { count: 0, total: 0 } };
    for (const bet of Object.values(gameState.bets)) {
        if (summary[bet.color]) { summary[bet.color].count++; summary[bet.color].total += bet.amount; }
    }
    summary.totalBetters = Object.keys(gameState.bets).length;
    return summary;
}

function settleRound(result) {
    if (gameState.phase === 'result') return;
    if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    gameState.phase = 'result';
    gameState.result = result;
    gameState.bettingOpen = false;
    const db = loadDB();
    let totalBet = 0, totalPayout = 0;
    const betSummary = [];

    for (const [userId, bet] of Object.entries(gameState.bets)) {
        const user = db.users.find(u => u.id === userId);
        if (!user) continue;
        const won = bet.color === result;
        const payout = won ? bet.amount * 2 : 0;
        user.balance = (user.balance || 0) + payout;
        user.totalBet = (user.totalBet || 0) + bet.amount;
        user.totalWon = (user.totalWon || 0) + payout;
        user.totalBetsPlaced = (user.totalBetsPlaced || 0) + 1;
        touchActivity(db, userId);
        totalBet += bet.amount; totalPayout += payout;
        betSummary.push({ userId, username: user.username, color: bet.color, amount: bet.amount, won, payout });
        io.to(`user_${userId}`).emit('bet:result', { won, payout, newBalance: user.balance, color: result });
    }

    const round = {
        id: gameState.roundId, result, bets: betSummary,
        totalBet, totalPayout, profit: totalBet - totalPayout,
        timestamp: new Date().toISOString()
    };
    db.rounds.push(round);
    saveDB(db);
    resultHistory.unshift(round);
    if (resultHistory.length > 50) resultHistory.pop();

    io.emit('round:result', { result, bets: betSummary });
    io.emit('game:state', getPublicState());

    // Auto-start next round after delay
    setTimeout(() => startNewRound(), RULES.RESULT_DELAY * 1000);
}

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

function authMiddleware(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        if (req.user.role !== 'admin') {
            const db = loadDB();
            const user = db.users.find(u => u.id === req.user.id);
            if (!user) return res.status(401).json({ error: 'User not found' });
            if (isUserSuspended(user)) return res.status(403).json({ error: 'Account suspended due to inactivity. Contact support.', suspended: true });
        }
        next();
    } catch { res.status(401).json({ error: 'Invalid token' }); }
}

function adminMiddleware(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
        next();
    } catch { res.status(401).json({ error: 'Invalid token' }); }
}

// ─── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
    const { username, password, referralCode } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
    const db = loadDB();
    if (db.users.find(u => u.username.toLowerCase() === username.toLowerCase()))
        return res.status(400).json({ error: 'Username already taken' });
    let referredBy = null;
    if (referralCode) {
        const referrer = db.users.find(u => u.referralCode === referralCode.trim());
        if (referrer) referredBy = referrer.id;
    }
    const hashed = await bcrypt.hash(password, 10);
    const user = {
        id: Date.now().toString(), username, password: hashed,
        balance: 50, role: 'user',
        totalBet: 0, totalWon: 0, totalDeposited: 0, totalBetsPlaced: 0,
        referralCode: generateReferralCode(username), referredBy,
        bankAccount: null, upiId: null,
        lastActiveAt: new Date().toISOString(),
        forceSuspended: false,
        createdAt: new Date().toISOString()
    };
    db.users.push(user);
    saveDB(db);
    const token = jwt.sign({ id: user.id, username, role: 'user' }, JWT_SECRET);
    res.json({ token, user: { id: user.id, username, balance: user.balance, role: 'user', referralCode: user.referralCode } });
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
    const db = loadDB();
    const user = db.users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!user) return res.status(400).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ error: 'Invalid credentials' });
    if (isUserSuspended(user)) return res.status(403).json({ error: 'Account suspended due to inactivity. Contact support.', suspended: true });
    touchActivity(db, user.id);
    saveDB(db);
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET);
    res.json({ token, user: { id: user.id, username: user.username, balance: user.balance, role: user.role, referralCode: user.referralCode } });
});

// ─── User Routes ───────────────────────────────────────────────────────────────
app.get('/api/me', authMiddleware, (req, res) => {
    const db = loadDB();
    const user = db.users.find(u => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    touchActivity(db, user.id); saveDB(db);
    const eligibility = checkWithdrawalEligibility(user, db);
    res.json({
        id: user.id, username: user.username, balance: user.balance, role: user.role,
        bankAccount: user.bankAccount, upiId: user.upiId,
        totalBet: user.totalBet || 0, totalWon: user.totalWon || 0,
        totalDeposited: user.totalDeposited || 0, totalBetsPlaced: user.totalBetsPlaced || 0,
        referralCode: user.referralCode, referredBy: user.referredBy,
        lastActiveAt: user.lastActiveAt, withdrawalEligibility: eligibility
    });
});

app.get('/api/game-state', (req, res) => res.json(getPublicState()));

app.get('/api/notifications', authMiddleware, (req, res) => {
    const db = loadDB();
    res.json((db.notifications || []).slice().reverse().slice(0, 30));
});

app.post('/api/bet', authMiddleware, (req, res) => {
    const { color, amount } = req.body;
    if (!['red', 'green', 'violet'].includes(color)) return res.status(400).json({ error: 'Invalid color' });
    if (!amount || isNaN(amount) || amount < 10) return res.status(400).json({ error: 'Minimum bet is Rs.10' });
    if (gameState.phase !== 'betting' || !gameState.bettingOpen) return res.status(400).json({ error: 'Betting is closed' });
    if (gameState.timeLeft <= 5) return res.status(400).json({ error: 'Too late! Last 5 seconds' });
    const userId = req.user.id;
    if (gameState.bets[userId]) return res.status(400).json({ error: 'Already placed a bet this round' });
    const db = loadDB();
    const user = db.users.find(u => u.id === userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });
    user.balance -= amount;
    touchActivity(db, userId);
    saveDB(db);
    gameState.bets[userId] = { color, amount: Number(amount), locked: true };
    io.to(`user_${userId}`).emit('bet:placed', { color, amount, newBalance: user.balance });
    io.to('admin_room').emit('bets:updated', getLiveBets());
    res.json({ success: true, newBalance: user.balance });
});

app.get('/api/history', authMiddleware, (req, res) => res.json(resultHistory.slice(0, 20)));

app.post('/api/bank-account', authMiddleware, (req, res) => {
    const { accountName, accountNumber, ifscCode } = req.body;
    const db = loadDB();
    const user = db.users.find(u => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    user.bankAccount = { accountName, accountNumber, ifscCode };
    touchActivity(db, user.id); saveDB(db);
    res.json({ success: true, bankAccount: user.bankAccount });
});

app.delete('/api/bank-account', authMiddleware, (req, res) => {
    const db = loadDB();
    const user = db.users.find(u => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    user.bankAccount = null;
    saveDB(db);
    res.json({ success: true });
});

app.post('/api/upi', authMiddleware, (req, res) => {
    const { upiId } = req.body;
    if (!upiId) return res.status(400).json({ error: 'UPI ID is required' });
    const db = loadDB();
    const user = db.users.find(u => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    user.upiId = upiId.trim();
    saveDB(db);
    res.json({ success: true, upiId: user.upiId });
});

app.delete('/api/upi', authMiddleware, (req, res) => {
    const db = loadDB();
    const user = db.users.find(u => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    user.upiId = null;
    saveDB(db);
    res.json({ success: true });
});

app.get('/api/my-referrals', authMiddleware, (req, res) => {
    const db = loadDB();
    const betsByUser = {};
    for (const round of db.rounds)
        for (const bet of (round.bets || []))
            betsByUser[bet.userId] = (betsByUser[bet.userId] || 0) + 1;
    const referrals = db.users
        .filter(u => u.referredBy === req.user.id)
        .map(u => ({ id: u.id, username: u.username, betsPlaced: betsByUser[u.id] || 0, active: (betsByUser[u.id] || 0) >= RULES.MIN_BET_FOR_ACTIVE, joinedAt: u.createdAt }));
    res.json({ referrals, activeCount: referrals.filter(r => r.active).length, totalCount: referrals.length });
});

app.get('/api/deposit-bank', authMiddleware, (req, res) => {
    const db = loadDB();
    const banks = db.bankAccounts.filter(b => b.active);
    const upis = (db.upiAccounts || []).filter(u => u.active);
    const bank = banks.length > 0 ? banks[db.currentBankIndex % banks.length] : null;
    if (bank) { db.currentBankIndex = (db.currentBankIndex + 1) % Math.max(banks.length, 1); saveDB(db); }
    res.json({ bank, upis });
});

app.post('/api/deposit', authMiddleware, (req, res) => {
    const { amount, transactionId } = req.body;
    if (!amount || amount < 100) return res.status(400).json({ error: 'Minimum deposit Rs.100' });
    if (!transactionId || !transactionId.trim()) return res.status(400).json({ error: 'UTR / Transaction ID is required' });
    const db = loadDB();
    const duplicate = db.depositRequests.find(r => r.transactionId && r.transactionId.toLowerCase() === transactionId.trim().toLowerCase());
    const request = {
        id: Date.now().toString(), userId: req.user.id, username: req.user.username,
        amount: Number(amount), transactionId: transactionId.trim(),
        status: 'pending',
        isDuplicate: !!duplicate, duplicateOf: duplicate ? duplicate.id : null,
        createdAt: new Date().toISOString()
    };
    db.depositRequests.push(request);
    touchActivity(db, req.user.id);
    saveDB(db);
    res.json({ success: true, request, isDuplicate: !!duplicate });
});

app.post('/api/withdraw', authMiddleware, (req, res) => {
    const { amount } = req.body;
    if (!amount || amount < RULES.MIN_WITHDRAW) return res.status(400).json({ error: `Minimum withdrawal is Rs.${RULES.MIN_WITHDRAW}` });
    const db = loadDB();
    const user = db.users.find(u => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    if (!user.bankAccount && !user.upiId) return res.status(400).json({ error: 'Please add a bank account or UPI ID first' });
    if (user.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });
    const eligibility = checkWithdrawalEligibility(user, db);
    if (!eligibility.eligible) return res.status(400).json({ error: 'Not eligible for withdrawal', reasons: eligibility.reasons });
    const fee = Math.ceil(Number(amount) * 0.005);
    const netAmount = Number(amount) - fee;
    user.balance -= amount;
    touchActivity(db, user.id);
    const request = {
        id: Date.now().toString(), userId: user.id, username: user.username,
        amount: Number(amount), fee, netAmount,
        bankAccount: user.bankAccount, upiId: user.upiId,
        status: 'pending', eligibilitySnapshot: eligibility,
        createdAt: new Date().toISOString()
    };
    db.withdrawalRequests.push(request);
    saveDB(db);
    res.json({ success: true, newBalance: user.balance, fee, netAmount });
});

// ─── Admin Routes ──────────────────────────────────────────────────────────────
app.get('/api/admin/game-bets', adminMiddleware, (req, res) => res.json(getLiveBets()));

app.post('/api/admin/result', adminMiddleware, (req, res) => {
    const { result } = req.body;
    if (!['red', 'green', 'violet'].includes(result)) return res.status(400).json({ error: 'Invalid result' });
    if (gameState.phase === 'result') return res.status(400).json({ error: 'Already settled' });
    settleRound(result);
    res.json({ success: true });
});

app.post('/api/admin/toggle-betting', adminMiddleware, (req, res) => {
    if (gameState.phase !== 'betting') return res.status(400).json({ error: 'Not in betting phase' });
    gameState.bettingOpen = !gameState.bettingOpen;
    io.emit('game:state', getPublicState());
    res.json({ success: true, bettingOpen: gameState.bettingOpen });
});

app.get('/api/admin/users', adminMiddleware, (req, res) => {
    const db = loadDB();
    const betsByUser = {};
    for (const round of db.rounds)
        for (const bet of (round.bets || []))
            betsByUser[bet.userId] = (betsByUser[bet.userId] || 0) + 1;
    res.json(db.users.filter(u => u.role !== 'admin').map(u => {
        const daysSinceActive = u.lastActiveAt
            ? Math.floor((Date.now() - new Date(u.lastActiveAt).getTime()) / (1000 * 60 * 60 * 24))
            : null;
        return {
            id: u.id, username: u.username, balance: u.balance,
            totalBet: u.totalBet || 0, totalWon: u.totalWon || 0,
            totalDeposited: u.totalDeposited || 0, totalBetsPlaced: u.totalBetsPlaced || 0,
            referralCode: u.referralCode, bankAccount: u.bankAccount || null,
            upiId: u.upiId || null, lastActiveAt: u.lastActiveAt,
            daysSinceActive, suspended: isUserSuspended(u),
            forceSuspended: u.forceSuspended || false, createdAt: u.createdAt
        };
    }));
});

app.post('/api/admin/users/add', adminMiddleware, async (req, res) => {
    const { username, password, balance } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const db = loadDB();
    if (db.users.find(u => u.username.toLowerCase() === username.toLowerCase()))
        return res.status(400).json({ error: 'Username already taken' });
    const hashed = await bcrypt.hash(password, 10);
    const user = {
        id: Date.now().toString(), username, password: hashed,
        balance: Number(balance) || 50, role: 'user',
        totalBet: 0, totalWon: 0, totalDeposited: 0, totalBetsPlaced: 0,
        referralCode: generateReferralCode(username), referredBy: null,
        bankAccount: null, upiId: null,
        lastActiveAt: new Date().toISOString(), forceSuspended: false,
        createdAt: new Date().toISOString()
    };
    db.users.push(user);
    saveDB(db);
    res.json({ success: true, user });
});

app.delete('/api/admin/users/:id', adminMiddleware, (req, res) => {
    const db = loadDB();
    db.users = db.users.filter(u => u.id !== req.params.id || u.role === 'admin');
    saveDB(db);
    res.json({ success: true });
});

app.post('/api/admin/users/:id/reactivate', adminMiddleware, (req, res) => {
    const db = loadDB();
    const user = db.users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    user.forceSuspended = false;
    user.lastActiveAt = new Date().toISOString();
    saveDB(db);
    res.json({ success: true });
});

app.post('/api/admin/users/:id/suspend', adminMiddleware, (req, res) => {
    const db = loadDB();
    const user = db.users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    user.forceSuspended = true;
    saveDB(db);
    res.json({ success: true });
});

// Notifications
app.get('/api/admin/notifications', adminMiddleware, (req, res) => {
    const db = loadDB();
    res.json((db.notifications || []).slice().reverse());
});

app.post('/api/admin/notifications', adminMiddleware, (req, res) => {
    const { title, message } = req.body;
    if (!title || !message) return res.status(400).json({ error: 'Title and message required' });
    const db = loadDB();
    const notif = { id: Date.now().toString(), title, message, createdAt: new Date().toISOString() };
    db.notifications.push(notif);
    saveDB(db);
    io.emit('notification:new', notif);
    res.json({ success: true, notification: notif });
});

app.delete('/api/admin/notifications/:id', adminMiddleware, (req, res) => {
    const db = loadDB();
    db.notifications = db.notifications.filter(n => n.id !== req.params.id);
    saveDB(db);
    res.json({ success: true });
});

// Referrals
app.get('/api/admin/referrals', adminMiddleware, (req, res) => {
    const db = loadDB();
    const betsByUser = {};
    for (const round of db.rounds)
        for (const bet of (round.bets || []))
            betsByUser[bet.userId] = (betsByUser[bet.userId] || 0) + 1;
    res.json(db.users.filter(u => u.role !== 'admin').map(u => {
        const referred = db.users.filter(r => r.referredBy === u.id).map(r => ({
            id: r.id, username: r.username, betsPlaced: betsByUser[r.id] || 0,
            active: (betsByUser[r.id] || 0) >= RULES.MIN_BET_FOR_ACTIVE, joinedAt: r.createdAt
        }));
        return { id: u.id, username: u.username, referralCode: u.referralCode, totalReferred: referred.length, activeReferrals: referred.filter(r => r.active).length, referred };
    }));
});

app.get('/api/admin/withdrawal-eligibility', adminMiddleware, (req, res) => {
    const db = loadDB();
    res.json(db.users.filter(u => u.role !== 'admin').map(u => ({ id: u.id, username: u.username, balance: u.balance, ...checkWithdrawalEligibility(u, db) })));
});

app.get('/api/admin/stats', adminMiddleware, (req, res) => {
    const db = loadDB();
    const suspendedCount = db.users.filter(u => u.role !== 'admin' && isUserSuspended(u)).length;
    res.json({
        totalUsers: db.users.filter(u => u.role !== 'admin').length,
        totalRounds: db.rounds.length,
        totalBet: db.rounds.reduce((s, r) => s + (r.totalBet || 0), 0),
        totalPayout: db.rounds.reduce((s, r) => s + (r.totalPayout || 0), 0),
        profit: db.rounds.reduce((s, r) => s + (r.profit || 0), 0),
        pendingDeposits: db.depositRequests.filter(r => r.status === 'pending').length,
        pendingWithdrawals: db.withdrawalRequests.filter(r => r.status === 'pending').length,
        duplicateDeposits: db.depositRequests.filter(r => r.isDuplicate && r.status === 'pending').length,
        suspendedUsers: suspendedCount
    });
});

app.post('/api/admin/adjust-balance', adminMiddleware, (req, res) => {
    const { userId, amount } = req.body;
    if (isNaN(amount)) return res.status(400).json({ error: 'Invalid amount' });
    const db = loadDB();
    const user = db.users.find(u => u.id === userId);
    if (!user) return res.status(404).json({ error: 'Not found' });
    user.balance = Math.max(0, user.balance + Number(amount));
    saveDB(db);
    res.json({ success: true, newBalance: user.balance });
});

// Deposits
app.get('/api/admin/deposits', adminMiddleware, (req, res) => {
    const db = loadDB();
    res.json(db.depositRequests.slice().reverse());
});

app.post('/api/admin/deposits/:id/approve', adminMiddleware, (req, res) => {
    const db = loadDB();
    const dep = db.depositRequests.find(r => r.id === req.params.id);
    if (!dep) return res.status(404).json({ error: 'Not found' });
    if (dep.status !== 'pending') return res.status(400).json({ error: 'Already processed' });
    dep.status = 'approved';
    const user = db.users.find(u => u.id === dep.userId);
    if (user) { user.balance += dep.amount; user.totalDeposited = (user.totalDeposited || 0) + dep.amount; }
    saveDB(db);
    io.to(`user_${dep.userId}`).emit('deposit:approved', { amount: dep.amount, newBalance: user?.balance });
    res.json({ success: true });
});

app.post('/api/admin/deposits/:id/reject', adminMiddleware, (req, res) => {
    const db = loadDB();
    const dep = db.depositRequests.find(r => r.id === req.params.id);
    if (!dep) return res.status(404).json({ error: 'Not found' });
    dep.status = 'rejected';
    saveDB(db);
    res.json({ success: true });
});

// Withdrawals
app.get('/api/admin/withdrawals', adminMiddleware, (req, res) => {
    const db = loadDB();
    res.json(db.withdrawalRequests.slice().reverse());
});

app.post('/api/admin/withdrawals/:id/approve', adminMiddleware, (req, res) => {
    const db = loadDB();
    const wd = db.withdrawalRequests.find(r => r.id === req.params.id);
    if (!wd || wd.status !== 'pending') return res.status(400).json({ error: 'Invalid' });
    wd.status = 'approved';
    saveDB(db);
    io.to(`user_${wd.userId}`).emit('withdrawal:approved', { amount: wd.amount, netAmount: wd.netAmount });
    res.json({ success: true });
});

app.post('/api/admin/withdrawals/:id/reject', adminMiddleware, (req, res) => {
    const db = loadDB();
    const wd = db.withdrawalRequests.find(r => r.id === req.params.id);
    if (!wd) return res.status(404).json({ error: 'Not found' });
    if (wd.status === 'pending') {
        const user = db.users.find(u => u.id === wd.userId);
        if (user) user.balance += wd.amount;
    }
    wd.status = 'rejected';
    saveDB(db);
    res.json({ success: true });
});

// Banks & UPI
app.get('/api/admin/banks', adminMiddleware, (req, res) => {
    const db = loadDB();
    res.json({ banks: db.bankAccounts, upis: db.upiAccounts || [] });
});

app.post('/api/admin/banks', adminMiddleware, (req, res) => {
    const { name, accountNumber, ifscCode, upiId } = req.body;
    const db = loadDB();
    db.bankAccounts.push({ id: Date.now().toString(), name, accountNumber, ifscCode, upiId, active: true });
    saveDB(db);
    res.json({ success: true });
});

app.post('/api/admin/banks/:id/toggle', adminMiddleware, (req, res) => {
    const db = loadDB();
    const bank = db.bankAccounts.find(b => b.id === req.params.id);
    if (!bank) return res.status(404).json({ error: 'Not found' });
    bank.active = !bank.active;
    saveDB(db);
    res.json({ success: true, active: bank.active });
});

app.delete('/api/admin/banks/:id', adminMiddleware, (req, res) => {
    const db = loadDB();
    db.bankAccounts = db.bankAccounts.filter(b => b.id !== req.params.id);
    saveDB(db);
    res.json({ success: true });
});

app.post('/api/admin/upi', adminMiddleware, (req, res) => {
    const { name, upiId } = req.body;
    if (!upiId || !name) return res.status(400).json({ error: 'UPI ID and name required' });
    const db = loadDB();
    db.upiAccounts.push({ id: Date.now().toString(), name, upiId, active: true });
    saveDB(db);
    res.json({ success: true });
});

app.post('/api/admin/upi/:id/toggle', adminMiddleware, (req, res) => {
    const db = loadDB();
    const upi = (db.upiAccounts || []).find(u => u.id === req.params.id);
    if (!upi) return res.status(404).json({ error: 'Not found' });
    upi.active = !upi.active;
    saveDB(db);
    res.json({ success: true });
});

app.delete('/api/admin/upi/:id', adminMiddleware, (req, res) => {
    const db = loadDB();
    db.upiAccounts = (db.upiAccounts || []).filter(u => u.id !== req.params.id);
    saveDB(db);
    res.json({ success: true });
});

app.get('/api/admin/rounds', adminMiddleware, (req, res) => {
    const db = loadDB();
    res.json(db.rounds.slice(-50).reverse());
});

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
    socket.emit('game:state', getPublicState());
    socket.on('join', ({ token }) => {
        try {
            const user = jwt.verify(token, JWT_SECRET);
            socket.join(`user_${user.id}`);
            socket.userId = user.id;
            if (user.role === 'admin') socket.join('admin_room');
        } catch {}
    });
});

// ─── Bootstrap ────────────────────────────────────────────────────────────────
(async () => {
    const db = loadDB();
    if (!db.users.find(u => u.role === 'admin')) {
        const hashed = await bcrypt.hash('admin123', 10);
        db.users.push({
            id: 'admin_1', username: 'admin', password: hashed,
            balance: 0, role: 'admin', totalBet: 0, totalWon: 0,
            totalDeposited: 0, totalBetsPlaced: 0,
            referralCode: 'ADMIN', lastActiveAt: new Date().toISOString(),
            createdAt: new Date().toISOString()
        });
        saveDB(db);
        console.log('Admin created -> admin / admin123');
    }
    server.listen(PORT, () => {
        console.log(`ColorWin running at http://localhost:${PORT}`);
        console.log(`Admin panel: http://localhost:${PORT}/admin.html`);
        startNewRound();
        console.log('Auto-timer started - first round is live!');
    });
})();

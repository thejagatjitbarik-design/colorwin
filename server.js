const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'colourprediction_secret_2024';
const DB_FILE = path.join(__dirname, 'db.json');
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://colorwin:ColorWin2024Pass%21@game.xfh9tju.mongodb.net/?retryWrites=true&w=majority';

// ─── Constants & Game Rules ───────────────────────────────────────────────────
const CURRENT_SCHEMA_VERSION = '2.3.0_fresh_zero';
const RULES = {
    MIN_WITHDRAW: 300,
    MIN_DEPOSITS: 200,          // total deposits required for standard withdrawal
    MIN_DEPOSIT_SINGLE: 200,    // mandatory minimum single deposit: ₹200
    MIN_REFERRALS: 3,
    MIN_BET_FOR_ACTIVE: 1,
    ROUND_DURATION: 120,        // 2-minute round countdown
    RESULT_DELAY: 10,           // delay between result and next round
    AUTO_RESULT_DELAY: 7,       // auto-result picks lowest bet 7s after 00:00
    INACTIVE_DAYS: 15,
    REFERRAL_BONUS_WAGER: 300,  // referral must bet ₹300 cumulative
    REFERRAL_BONUS_AMOUNT: 50,  // ₹50 one-time milestone bonus to direct referrer
    LEG_COMMISSION_RATES: [
        0.0004, // Leg 1: 0.04% (Direct referral)
        0.0001, // Leg 2: 0.01% (2nd level)
        0.0001, // Leg 3: 0.01% (3rd level)
        0.0001  // Leg 4: 0.01% (4th level)
    ]
};

// ─── DB & Cloud Persistence (MongoDB Atlas + Local Fallback) ───────────────────
let inMemoryDB = null;
let mongoCollection = null;
let syncTimeout = null;

async function getFreshZeroState() {
    const adminHash = await bcrypt.hash('admin123', 10);
    return {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        users: [
            {
                id: 'admin_1',
                username: 'admin',
                password: adminHash,
                balance: 0,
                role: 'admin',
                totalBet: 0,
                totalWon: 0,
                totalDeposited: 0,
                totalBetsPlaced: 0,
                totalCommissionEarned: 0,
                referralCode: 'ADMIN',
                directWithdrawal: true,
                vipWithdrawal: true,
                lastActiveAt: new Date().toISOString(),
                createdAt: new Date().toISOString()
            }
        ],
        rounds: [],
        bankAccounts: [
            { id: 'bank_1', bankName: 'State Bank of India', accountHolder: 'ColorWin Official', accountNumber: '39482019481', ifsc: 'SBIN0001234', active: true, totalCollected: 0, lockedForAll: false },
            { id: 'bank_2', bankName: 'HDFC Bank', accountHolder: 'ColorWin Official', accountNumber: '50100481928314', ifsc: 'HDFC0000543', active: true, totalCollected: 0, lockedForAll: false }
        ],
        upiAccounts: [
            { id: 'upi_1', upiId: 'colorwin.pay@oksbi', displayName: 'ColorWin Official UPI', active: true, totalCollected: 0, lockedForAll: false },
            { id: 'upi_2', upiId: 'colorwingame@paytm', displayName: 'ColorWin Fast UPI', active: true, totalCollected: 0, lockedForAll: false }
        ],
        depositRequests: [],
        withdrawalRequests: [],
        notifications: [],
        settings: {
            depositsEnabled: true,
            support: {
                contacts: [
                    { id: 'c1', type: 'whatsapp', title: 'WhatsApp Helpline 1', value: '+91 82601 04294', link: 'https://wa.me/918260104294' },
                    { id: 'c2', type: 'whatsapp', title: 'WhatsApp Helpline 2', value: '+91 81447 17930', link: 'https://wa.me/918144717930' },
                    { id: 'c3', type: 'email', title: 'Official Email Support', value: 'blackcyberp@gmail.com', link: 'mailto:blackcyberp@gmail.com' }
                ],
                groups: [
                    { id: 'g1', title: 'Official Telegram Channel', link: 'https://t.me/colorwin_official' },
                    { id: 'g2', title: 'VIP Prediction WhatsApp Group', link: 'https://chat.whatsapp.com/' }
                ]
            }
        },
        currentBankIndex: 0
    };
}

async function initDatabase() {
    let localData = null;
    if (fs.existsSync(DB_FILE)) {
        try { localData = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8')); } catch {}
    }
    if (!localData || localData.schemaVersion !== CURRENT_SCHEMA_VERSION) {
        localData = await getFreshZeroState();
        try { fs.writeFileSync(DB_FILE, JSON.stringify(localData, null, 2)); } catch {}
    }
    inMemoryDB = localData;

    if (MONGODB_URI) {
        try {
            const client = new MongoClient(MONGODB_URI);
            await client.connect();
            const mdb = client.db('colorwin');
            mongoCollection = mdb.collection('app_state');
            console.log('✅ Connected to MongoDB Atlas permanent cloud database!');

            const cloudDoc = await mongoCollection.findOne({ _id: 'main_state' });
            if (cloudDoc && cloudDoc.data && cloudDoc.data.schemaVersion === CURRENT_SCHEMA_VERSION) {
                inMemoryDB = cloudDoc.data;
                if (!inMemoryDB.settings) inMemoryDB.settings = { depositsEnabled: true };
                console.log(`📦 Restored state from cloud: ${inMemoryDB.users.length} users, ${inMemoryDB.rounds.length} rounds.`);
            } else {
                console.log(`🔄 Performing fresh zero reset for schema version: ${CURRENT_SCHEMA_VERSION}`);
                inMemoryDB = await getFreshZeroState();
                await mongoCollection.replaceOne(
                    { _id: 'main_state' },
                    { _id: 'main_state', data: inMemoryDB },
                    { upsert: true }
                );
                try { fs.writeFileSync(DB_FILE, JSON.stringify(inMemoryDB, null, 2)); } catch {}
                console.log('☁️ Initialized fresh zero state in MongoDB Atlas.');
            }
        } catch (err) {
            console.error('⚠️ MongoDB Atlas error (using local db.json):', err.message);
        }
    }
}

function loadDB() {
    if (!inMemoryDB) {
        if (fs.existsSync(DB_FILE)) {
            try { inMemoryDB = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8')); } catch {}
        }
        if (!inMemoryDB) {
            inMemoryDB = {
                users: [], rounds: [], bankAccounts: [], upiAccounts: [],
                depositRequests: [], withdrawalRequests: [],
                notifications: [], settings: { depositsEnabled: true },
                currentBankIndex: 0
            };
        }
    }
    if (!inMemoryDB.upiAccounts) inMemoryDB.upiAccounts = [];
    if (!inMemoryDB.notifications) inMemoryDB.notifications = [];
    if (!inMemoryDB.settings) inMemoryDB.settings = { depositsEnabled: true };
    return inMemoryDB;
}

function saveDB(db) {
    inMemoryDB = db;
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    } catch {}

    if (mongoCollection) {
        if (syncTimeout) clearTimeout(syncTimeout);
        syncTimeout = setTimeout(async () => {
            try {
                await mongoCollection.replaceOne(
                    { _id: 'main_state' },
                    { _id: 'main_state', data: inMemoryDB },
                    { upsert: true }
                );
            } catch (err) {
                console.error('Mongo save error:', err.message);
            }
        }, 100);
    }
}

function generateReferralCode(username) {
    return `CW-${username.slice(0, 3).toUpperCase()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

// ─── Eligibility ───────────────────────────────────────────────────────────────
function checkWithdrawalEligibility(user, db) {
    const balance = user.balance || 0;
    const isDirect = !!(user.directWithdrawal || user.vipWithdrawal);
    // Direct Withdrawal (VIP Pass granted by Admin) bypasses standard referral & deposit thresholds
    if (isDirect) {
        const eligible = balance >= RULES.MIN_WITHDRAW;
        return {
            eligible,
            reasons: eligible ? [] : [`Balance must be ≥ ₹${RULES.MIN_WITHDRAW}`],
            isVip: true,
            directWithdrawal: true,
            totalDeposited: user.totalDeposited || 0,
            referrals: 0,
            activeReferrals: 0,
            balance
        };
    }

    const reasons = [];
    const betsByUser = {};
    for (const round of (db.rounds || []))
        for (const bet of (round.bets || []))
            betsByUser[bet.userId] = (betsByUser[bet.userId] || 0) + 1;

    const referrals = (db.users || []).filter(u => u.referredBy === user.id);
    const activeReferrals = referrals.filter(u => (betsByUser[u.id] || 0) >= RULES.MIN_BET_FOR_ACTIVE);
    const totalDeposited = user.totalDeposited || 0;

    if (balance < RULES.MIN_WITHDRAW) reasons.push(`Balance must be ≥ ₹${RULES.MIN_WITHDRAW}`);
    if (totalDeposited < RULES.MIN_DEPOSITS) reasons.push(`Total deposits must be ≥ ₹${RULES.MIN_DEPOSITS} (current: ₹${totalDeposited})`);
    if (activeReferrals.length < RULES.MIN_REFERRALS) reasons.push(`Need ${RULES.MIN_REFERRALS} active referrals (have ${activeReferrals.length})`);

    return {
        eligible: reasons.length === 0,
        reasons,
        isVip: false,
        directWithdrawal: false,
        totalDeposited,
        referrals: referrals.length,
        activeReferrals: activeReferrals.length,
        balance
    };
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

// ─── Game State & Lowest-Bet-Wins Algorithm ────────────────────────────────────
let gameState = {
    roundId: null,
    phase: 'waiting',
    timeLeft: RULES.ROUND_DURATION,
    bets: {},
    result: null,
    bettingOpen: true,
    maintenanceMode: false,
    autoResultMode: true // Admin can toggle on/off
};
let timerInterval = null;
let autoResultTimer = null;
let resultHistory = [];

// Lowest Bet Wins: Highest bet NEVER wins; lowest total wager ALWAYS wins
function calculateAutoResult() {
    const summary = getLiveBets();
    const colors = [
        { color: 'red', total: summary.red.total },
        { color: 'green', total: summary.green.total },
        { color: 'violet', total: summary.violet.total }
    ];

    // If all are equal (e.g. zero bets placed on all)
    if (colors[0].total === colors[1].total && colors[1].total === colors[2].total) {
        const pool = ['red', 'green', 'violet'];
        return pool[Math.floor(Math.random() * pool.length)];
    }

    // Sort ascending by total bet amount
    colors.sort((a, b) => a.total - b.total);

    // Lowest is at index 0. Highest is at index 2.
    // Highest NEVER wins.
    const lowestTotal = colors[0].total;
    const lowestCandidates = colors.filter(c => c.total === lowestTotal).map(c => c.color);
    return lowestCandidates[Math.floor(Math.random() * lowestCandidates.length)];
}

function startNewRound() {
    if (timerInterval) clearInterval(timerInterval);
    if (autoResultTimer) clearTimeout(autoResultTimer);
    gameState.roundId = Date.now();
    gameState.phase = 'betting';
    gameState.timeLeft = RULES.ROUND_DURATION;
    gameState.bets = {};
    gameState.result = null;
    gameState.bettingOpen = !gameState.maintenanceMode;

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

            // If Auto-Result is ON: pick lowest bet after 7s if admin doesn't manually pick
            if (gameState.autoResultMode) {
                autoResultTimer = setTimeout(() => {
                    if (gameState.phase === 'closed') {
                        const winColor = calculateAutoResult();
                        settleRound(winColor);
                    }
                }, RULES.AUTO_RESULT_DELAY * 1000);
            }
        }
    }, 1000);
}

function getPublicState() {
    return {
        roundId: gameState.roundId,
        phase: gameState.phase,
        timeLeft: gameState.timeLeft,
        result: gameState.result,
        bettingOpen: gameState.bettingOpen,
        maintenanceMode: gameState.maintenanceMode,
        autoResultMode: gameState.autoResultMode
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
    if (autoResultTimer) { clearTimeout(autoResultTimer); autoResultTimer = null; }
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
        user.balance = +(user.balance + payout).toFixed(2);
        user.totalBet = (user.totalBet || 0) + bet.amount;
        user.totalWon = (user.totalWon || 0) + payout;
        user.totalBetsPlaced = (user.totalBetsPlaced || 0) + 1;
        touchActivity(db, userId);
        totalBet += bet.amount; totalPayout += payout;
        betSummary.push({ userId, username: user.username, color: bet.color, amount: bet.amount, won, payout });
        io.to(`user_${userId}`).emit('bet:result', { won, payout, newBalance: user.balance, color: result });

        // 4-Leg Multi-Tier Referral Commission on every winning bet:
        // Leg 1 (direct referrer): 0.04%
        // Leg 2 (referrer's referrer): 0.01%
        // Leg 3: 0.01%
        // Leg 4: 0.01%
        if (won && payout > 0 && user.referredBy) {
            let currentUserId = user.id;
            const visited = new Set([user.id]);
            for (let leg = 0; leg < 4; leg++) {
                const currentUser = db.users.find(u => u.id === currentUserId);
                if (!currentUser || !currentUser.referredBy) break;
                if (visited.has(currentUser.referredBy)) break;
                const parent = db.users.find(u => u.id === currentUser.referredBy);
                if (!parent) break;
                visited.add(parent.id);

                const rate = RULES.LEG_COMMISSION_RATES[leg] || 0.0001;
                const rawCommission = payout * rate;
                let commission = +(rawCommission.toFixed(2));
                if (commission === 0 && rawCommission > 0) commission = 0.01;

                parent.balance = +(parent.balance + commission).toFixed(2);
                parent.totalCommissionEarned = +((parent.totalCommissionEarned || 0) + commission).toFixed(2);
                if (!parent.legCommissions) parent.legCommissions = { leg1: 0, leg2: 0, leg3: 0, leg4: 0 };
                parent.legCommissions[`leg${leg + 1}`] = +((parent.legCommissions[`leg${leg + 1}`] || 0) + commission).toFixed(2);

                io.to(`user_${parent.id}`).emit('commission:earned', {
                    commission,
                    leg: leg + 1,
                    ratePercent: leg === 0 ? '0.04%' : '0.01%',
                    fromUser: user.username,
                    newBalance: parent.balance,
                    totalCommissionEarned: parent.totalCommissionEarned,
                    legCommissions: parent.legCommissions
                });
                io.to(`user_${parent.id}`).emit('balance:updated', { balance: parent.balance });

                currentUserId = parent.id;
            }
        }

        // Referral Milestone: ₹50 Cash Bonus once referral bets ≥ ₹300 cumulative
        if (user.referredBy && !user.referralBonusPaid && user.totalBet >= RULES.REFERRAL_BONUS_WAGER) {
            user.referralBonusPaid = true;
            const referrer = db.users.find(u => u.id === user.referredBy);
            if (referrer) {
                referrer.balance = +(referrer.balance + RULES.REFERRAL_BONUS_AMOUNT).toFixed(2);
                const notif = {
                    id: Date.now().toString(),
                    title: '🎉 Referral Milestone Bonus Received!',
                    message: `Your referral @${user.username} placed ₹${RULES.REFERRAL_BONUS_WAGER} in bets! ₹${RULES.REFERRAL_BONUS_AMOUNT} bonus credited to your wallet.`,
                    targetUserId: referrer.id,
                    targetUsername: referrer.username,
                    createdAt: new Date().toISOString()
                };
                db.notifications.push(notif);
                io.to(`user_${referrer.id}`).emit('notification:new', notif);
                io.to(`user_${referrer.id}`).emit('balance:updated', { balance: referrer.balance });
            }
        }
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

// ─── Dynamic Account Reservation (1-to-1 User Shuffling) ──────────────────────
const userAccountSessions = {}; // userId -> { bankId, upiId, assignedAt }

function getShuffledDepositAccount(userId, db) {
    const activeBanks = (db.bankAccounts || []).filter(b => b.active && !b.lockedForAll);
    const activeUpis = (db.upiAccounts || []).filter(u => u.active && !u.lockedForAll);

    if (activeBanks.length === 0 && activeUpis.length === 0) {
        return { bank: null, upis: [] };
    }

    const now = Date.now();
    const existing = userAccountSessions[userId];
    // Keep session active for 10 minutes
    if (existing && (now - existing.assignedAt) < 10 * 60 * 1000) {
        const b = activeBanks.find(x => x.id === existing.bankId) || activeBanks[0] || null;
        const u = activeUpis.find(x => x.id === existing.upiId) || activeUpis[0] || null;
        return { bank: b, upis: u ? [u] : activeUpis };
    }

    // Assign account rotated per user
    let assignedBank = null;
    if (activeBanks.length > 0) {
        const idx = Math.abs(hashCode(userId + Math.floor(now / (5 * 60 * 1000)))) % activeBanks.length;
        assignedBank = activeBanks[idx];
    }

    let assignedUpi = null;
    if (activeUpis.length > 0) {
        const uIdx = Math.abs(hashCode(userId + 'upi' + Math.floor(now / (5 * 60 * 1000)))) % activeUpis.length;
        assignedUpi = activeUpis[uIdx];
    }

    userAccountSessions[userId] = {
        bankId: assignedBank?.id,
        upiId: assignedUpi?.id,
        assignedAt: now
    };

    return { bank: assignedBank, upis: assignedUpi ? [assignedUpi] : activeUpis };
}

function hashCode(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
    }
    return hash;
}

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    const pubPath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(pubPath)) return res.sendFile(pubPath);
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin.html', (req, res) => {
    const pubPath = path.join(__dirname, 'public', 'admin.html');
    if (fs.existsSync(pubPath)) return res.sendFile(pubPath);
    res.sendFile(path.join(__dirname, 'admin.html'));
});

function authMiddleware(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;

        if (decoded.role !== 'admin') {
            const db = loadDB();
            const user = db.users.find(u => u.id === decoded.id);
            if (!user) return res.status(401).json({ error: 'User not found' });

            // Enforce Single-Device Active Session
            if (user.sessionToken && decoded.sessionToken && user.sessionToken !== decoded.sessionToken) {
                return res.status(401).json({
                    error: 'Logged out because your account was logged in from another device.',
                    sessionReplaced: true
                });
            }

            // Check 15-day inactivity
            if (isUserSuspended(user)) {
                return res.status(403).json({
                    error: 'Account suspended due to inactivity (15+ days). Contact support.',
                    suspended: true
                });
            }
        }
        next();
    } catch {
        res.status(401).json({ error: 'Invalid or expired token' });
    }
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

// ─── Active OTPs for Password Reset ───────────────────────────────────────────
const activePasswordOTPs = {}; // userId -> { otp, expiresAt, phone, username }

// ─── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
    const { username, password, referralCode, phone } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing username or password' });
    const cleanUser = username.trim();
    const cleanPhone = phone ? phone.trim() : null;
    const db = loadDB();

    if (db.users.find(u => u.username.toLowerCase() === cleanUser.toLowerCase())) {
        return res.status(400).json({ error: 'Username already taken. Please choose another username. Duplicate accounts are not allowed.' });
    }

    if (cleanPhone && db.users.find(u => u.phone && u.phone === cleanPhone)) {
        return res.status(400).json({ error: 'Mobile number already registered. Duplicate accounts are not allowed.' });
    }

    let referredBy = null;
    if (referralCode) {
        const referrer = db.users.find(u => u.referralCode === referralCode.trim());
        if (referrer) referredBy = referrer.id;
    }

    const hashed = await bcrypt.hash(password, 10);
    const sessionToken = crypto.randomBytes(16).toString('hex');
    const user = {
        id: Date.now().toString(),
        username: cleanUser,
        password: hashed,
        phone: cleanPhone,
        balance: 50,
        role: 'user',
        totalBet: 0,
        totalWon: 0,
        totalDeposited: 0,
        totalBetsPlaced: 0,
        totalCommissionEarned: 0,
        legCommissions: { leg1: 0, leg2: 0, leg3: 0, leg4: 0 },
        referralCode: generateReferralCode(cleanUser),
        referredBy,
        referralBonusPaid: false,
        directWithdrawal: false,
        vipWithdrawal: false,
        bankAccount: null,
        upiId: null,
        sessionToken,
        lastActiveAt: new Date().toISOString(),
        forceSuspended: false,
        createdAt: new Date().toISOString()
    };
    db.users.push(user);
    saveDB(db);

    const token = jwt.sign({ id: user.id, username: user.username, role: 'user', sessionToken }, JWT_SECRET);
    res.json({ token, user: { id: user.id, username: user.username, balance: user.balance, role: 'user', referralCode: user.referralCode, phone: user.phone } });
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing username or password' });
    const db = loadDB();
    const cleanUser = username.trim().toLowerCase();
    const user = db.users.find(u => u.username.toLowerCase() === cleanUser);
    if (!user) {
        return res.status(400).json({ error: 'User not found. Please register. Duplicate accounts are not allowed.' });
    }
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
        return res.status(400).json({ error: 'Invalid password. Please check your password or reset via OTP.' });
    }
    if (isUserSuspended(user)) {
        return res.status(403).json({ error: 'Account suspended due to inactivity (15+ days). Contact support.', suspended: true });
    }

    // Single Device Enforcement: Invalidate previous session and notify previous device
    const sessionToken = crypto.randomBytes(16).toString('hex');
    user.sessionToken = sessionToken;
    touchActivity(db, user.id);
    saveDB(db);

    io.to(`user_${user.id}`).emit('session:replaced', {
        message: 'Your account was logged in from another device.'
    });

    const token = jwt.sign({ id: user.id, username: user.username, role: user.role, sessionToken }, JWT_SECRET);
    res.json({ token, user: { id: user.id, username: user.username, balance: user.balance, role: user.role, referralCode: user.referralCode, phone: user.phone } });
});

// ─── OTP Password Reset ────────────────────────────────────────────────────────
app.post('/api/forgot-password/send-otp', (req, res) => {
    const { identifier } = req.body; // Can be mobile number or username
    if (!identifier || !identifier.trim()) return res.status(400).json({ error: 'Mobile number or username is required' });
    const q = identifier.trim();
    const db = loadDB();
    const user = db.users.find(u => (u.phone && u.phone === q) || u.username.toLowerCase() === q.toLowerCase());
    if (!user) {
        return res.status(404).json({ error: 'No account found with this mobile number or username. Please check or register.' });
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    activePasswordOTPs[user.id] = {
        otp,
        userId: user.id,
        phone: user.phone,
        username: user.username,
        expiresAt: Date.now() + 10 * 60 * 1000 // 10 minutes
    };

    console.log(`📱 [OTP Verification] User @${user.username} (Phone: ${user.phone || 'N/A'}) OTP generated: ${otp}`);

    // Notify Admin Panel
    const notif = {
        id: Date.now().toString(),
        title: '🔑 Password Reset OTP Sent',
        message: `User @${user.username} (${user.phone || 'Phone: N/A'}) requested password reset OTP: ${otp}`,
        targetUserId: null,
        targetUsername: 'Admin',
        createdAt: new Date().toISOString()
    };
    db.notifications.push(notif);
    saveDB(db);
    io.to('admin_room').emit('notification:new', notif);

    res.json({
        success: true,
        userId: user.id,
        username: user.username,
        otp, // sent for instant verification and testing
        message: `OTP sent successfully! Enter the 6-digit code below to set your new password.`
    });
});

app.post('/api/forgot-password/verify-reset', async (req, res) => {
    const { userId, otp, newPassword } = req.body;
    if (!userId || !otp || !newPassword) return res.status(400).json({ error: 'All fields (User, OTP, New Password) are required' });
    if (newPassword.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });

    const record = activePasswordOTPs[userId];
    if (!record || Date.now() > record.expiresAt) {
        return res.status(400).json({ error: 'OTP has expired or is invalid. Please request a new OTP.' });
    }
    if (record.otp !== otp.trim()) {
        return res.status(400).json({ error: 'Incorrect 6-digit OTP. Please enter the valid code.' });
    }

    const db = loadDB();
    const user = db.users.find(u => u.id === userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.password = await bcrypt.hash(newPassword, 10);
    delete activePasswordOTPs[userId];
    saveDB(db);

    res.json({ success: true, message: 'Password reset successful! You can now login with your new password.' });
});

// Legacy backward-compatibility for forgot password
app.post('/api/forgot-password', (req, res) => {
    const { username, phone } = req.body;
    if (!username) return res.status(400).json({ error: 'Username is required' });
    const db = loadDB();
    const user = db.users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (!user) return res.status(404).json({ error: 'User not found' });

    const notif = {
        id: Date.now().toString(),
        title: '🔑 Password Reset Requested',
        message: `User @${user.username} (Phone: ${phone || user.phone || 'N/A'}) requested a password reset.`,
        targetUserId: null,
        targetUsername: 'Admin',
        createdAt: new Date().toISOString()
    };
    db.notifications.push(notif);
    saveDB(db);
    io.to('admin_room').emit('notification:new', notif);
    res.json({ success: true, message: 'Reset request received. You can also reach support on WhatsApp for instant assistance.' });
});

// ─── Public Support & Color History Routes ─────────────────────────────────────
app.get('/api/support-info', (req, res) => {
    const db = loadDB();
    const support = (db.settings && db.settings.support) || {
        contacts: [
            { id: 'c1', type: 'whatsapp', title: 'WhatsApp Helpline 1', value: '+91 82601 04294', link: 'https://wa.me/918260104294' },
            { id: 'c2', type: 'whatsapp', title: 'WhatsApp Helpline 2', value: '+91 81447 17930', link: 'https://wa.me/918144717930' },
            { id: 'c3', type: 'email', title: 'Official Email Support', value: 'blackcyberp@gmail.com', link: 'mailto:blackcyberp@gmail.com' }
        ],
        groups: [
            { id: 'g1', title: 'Official Telegram Channel', link: 'https://t.me/colorwin_official' },
            { id: 'g2', title: 'VIP Prediction WhatsApp Group', link: 'https://chat.whatsapp.com/' }
        ]
    };
    res.json(support);
});

// Public Winning Color History (Last 50 rounds)
app.get('/api/color-history', (req, res) => {
    const db = loadDB();
    const history = (db.rounds || []).slice(-50).reverse().map(r => ({
        id: r.id,
        result: r.result,
        totalBet: r.totalBet || 0,
        totalPayout: r.totalPayout || 0,
        betsCount: (r.bets || []).length,
        timestamp: r.timestamp
    }));
    res.json(history);
});

// ─── Admin Support Management ──────────────────────────────────────────────────
app.post('/api/admin/support/contact', adminMiddleware, (req, res) => {
    const { title, value, type, link } = req.body;
    if (!title || !value) return res.status(400).json({ error: 'Title and value required' });
    const db = loadDB();
    if (!db.settings) db.settings = {};
    if (!db.settings.support) db.settings.support = { contacts: [], groups: [] };
    if (!db.settings.support.contacts) db.settings.support.contacts = [];

    const newContact = {
        id: Date.now().toString(),
        type: type || 'whatsapp',
        title: title.trim(),
        value: value.trim(),
        link: link ? link.trim() : (type === 'email' ? `mailto:${value.trim()}` : `https://wa.me/${value.replace(/\D/g, '')}`)
    };
    db.settings.support.contacts.push(newContact);
    saveDB(db);
    res.json({ success: true, contact: newContact });
});

app.delete('/api/admin/support/contact/:id', adminMiddleware, (req, res) => {
    const db = loadDB();
    if (db.settings && db.settings.support && db.settings.support.contacts) {
        db.settings.support.contacts = db.settings.support.contacts.filter(c => c.id !== req.params.id);
        saveDB(db);
    }
    res.json({ success: true });
});

app.post('/api/admin/support/group', adminMiddleware, (req, res) => {
    const { title, link } = req.body;
    if (!title || !link) return res.status(400).json({ error: 'Title and link required' });
    const db = loadDB();
    if (!db.settings) db.settings = {};
    if (!db.settings.support) db.settings.support = { contacts: [], groups: [] };
    if (!db.settings.support.groups) db.settings.support.groups = [];

    const newGroup = {
        id: Date.now().toString(),
        title: title.trim(),
        link: link.trim()
    };
    db.settings.support.groups.push(newGroup);
    saveDB(db);
    res.json({ success: true, group: newGroup });
});

app.delete('/api/admin/support/group/:id', adminMiddleware, (req, res) => {
    const db = loadDB();
    if (db.settings && db.settings.support && db.settings.support.groups) {
        db.settings.support.groups = db.settings.support.groups.filter(g => g.id !== req.params.id);
        saveDB(db);
    }
    res.json({ success: true });
});

// ─── User Routes ───────────────────────────────────────────────────────────────
app.get('/api/me', authMiddleware, (req, res) => {
    const db = loadDB();
    const user = db.users.find(u => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    touchActivity(db, user.id); saveDB(db);
    const eligibility = checkWithdrawalEligibility(user, db);
    res.json({
        id: user.id, username: user.username, phone: user.phone,
        balance: user.balance, role: user.role,
        bankAccount: user.bankAccount, upiId: user.upiId,
        totalBet: user.totalBet || 0, totalWon: user.totalWon || 0,
        totalDeposited: user.totalDeposited || 0, totalBetsPlaced: user.totalBetsPlaced || 0,
        totalCommissionEarned: user.totalCommissionEarned || 0,
        legCommissions: user.legCommissions || { leg1: 0, leg2: 0, leg3: 0, leg4: 0 },
        vipWithdrawal: !!(user.directWithdrawal || user.vipWithdrawal),
        directWithdrawal: !!(user.directWithdrawal || user.vipWithdrawal),
        referralCode: user.referralCode, referredBy: user.referredBy,
        lastActiveAt: user.lastActiveAt, withdrawalEligibility: eligibility
    });
});

app.get('/api/game-state', (req, res) => res.json(getPublicState()));

app.get('/api/notifications', authMiddleware, (req, res) => {
    const db = loadDB();
    const userNotifs = (db.notifications || []).filter(n => !n.targetUserId || n.targetUserId === req.user.id);
    res.json(userNotifs.slice().reverse().slice(0, 30));
});

app.post('/api/bet', authMiddleware, (req, res) => {
    const { color, amount } = req.body;
    if (!['red', 'green', 'violet'].includes(color)) return res.status(400).json({ error: 'Invalid color' });
    if (!amount || isNaN(amount) || amount < 10) return res.status(400).json({ error: 'Minimum bet is ₹10' });
    if (gameState.maintenanceMode) return res.status(400).json({ error: 'Game is currently in Maintenance Mode. Please check back shortly.' });
    if (gameState.phase !== 'betting' || !gameState.bettingOpen) return res.status(400).json({ error: 'Betting is closed' });
    if (gameState.timeLeft <= 5) return res.status(400).json({ error: 'Too late! Last 5 seconds' });

    const userId = req.user.id;
    if (gameState.bets[userId]) return res.status(400).json({ error: 'Already placed a bet this round' });
    const db = loadDB();
    const user = db.users.find(u => u.id === userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });

    user.balance = +(user.balance - amount).toFixed(2);
    touchActivity(db, userId);
    saveDB(db);
    gameState.bets[userId] = { color, amount: Number(amount), locked: true };
    io.to(`user_${userId}`).emit('bet:placed', { color, amount, newBalance: user.balance });
    io.to('admin_room').emit('bets:updated', getLiveBets());
    res.json({ success: true, newBalance: user.balance });
});

app.get('/api/history', authMiddleware, (req, res) => res.json(resultHistory.slice(0, 20)));

// Bank & UPI management by User
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

// Referrals (4 Legs)
app.get('/api/my-referrals', authMiddleware, (req, res) => {
    const db = loadDB();
    const user = db.users.find(u => u.id === req.user.id) || req.user;
    const betsByUser = {};
    for (const round of (db.rounds || []))
        for (const bet of (round.bets || []))
            betsByUser[bet.userId] = (betsByUser[bet.userId] || 0) + 1;

    const formatUser = (u) => ({
        id: u.id,
        username: u.username,
        totalBet: u.totalBet || 0,
        betsPlaced: betsByUser[u.id] || 0,
        active: (u.totalBet || 0) >= RULES.REFERRAL_BONUS_WAGER,
        bonusPaid: u.referralBonusPaid || false,
        joinedAt: u.createdAt
    });

    const leg1Users = (db.users || []).filter(u => u.referredBy === req.user.id);
    const leg1Ids = new Set(leg1Users.map(u => u.id));

    const leg2Users = (db.users || []).filter(u => u.referredBy && leg1Ids.has(u.referredBy));
    const leg2Ids = new Set(leg2Users.map(u => u.id));

    const leg3Users = (db.users || []).filter(u => u.referredBy && leg2Ids.has(u.referredBy));
    const leg3Ids = new Set(leg3Users.map(u => u.id));

    const leg4Users = (db.users || []).filter(u => u.referredBy && leg3Ids.has(u.referredBy));

    const legCommissions = user.legCommissions || { leg1: 0, leg2: 0, leg3: 0, leg4: 0 };

    res.json({
        referrals: leg1Users.map(formatUser),
        legs: {
            leg1: { count: leg1Users.length, rate: '0.04%', earned: +(legCommissions.leg1 || 0).toFixed(2), members: leg1Users.map(formatUser) },
            leg2: { count: leg2Users.length, rate: '0.01%', earned: +(legCommissions.leg2 || 0).toFixed(2), members: leg2Users.map(formatUser) },
            leg3: { count: leg3Users.length, rate: '0.01%', earned: +(legCommissions.leg3 || 0).toFixed(2), members: leg3Users.map(formatUser) },
            leg4: { count: leg4Users.length, rate: '0.01%', earned: +(legCommissions.leg4 || 0).toFixed(2), members: leg4Users.map(formatUser) }
        },
        activeCount: leg1Users.filter(u => (u.totalBet || 0) >= RULES.REFERRAL_BONUS_WAGER).length,
        totalCount: leg1Users.length + leg2Users.length + leg3Users.length + leg4Users.length,
        leg1Count: leg1Users.length,
        totalCommissionEarned: +(user.totalCommissionEarned || 0).toFixed(2),
        legCommissions
    });
});

// Dynamic Deposit Account Shuffling
app.get('/api/deposit-bank', authMiddleware, (req, res) => {
    const db = loadDB();
    if (db.settings && db.settings.depositsEnabled === false) {
        return res.json({ depositsPaused: true });
    }
    const accounts = getShuffledDepositAccount(req.user.id, db);
    res.json(accounts);
});

// Submit Deposit (Mandatory Screenshot + Min ₹200)
app.post('/api/deposit', authMiddleware, (req, res) => {
    const { amount, transactionId, screenshot, targetAccountName } = req.body;
    if (!amount || Number(amount) < RULES.MIN_DEPOSIT_SINGLE) {
        return res.status(400).json({ error: `Minimum deposit is ₹${RULES.MIN_DEPOSIT_SINGLE}` });
    }
    if (!transactionId || !transactionId.trim()) {
        return res.status(400).json({ error: 'UTR / Transaction ID is required' });
    }
    if (!screenshot || !screenshot.startsWith('data:image/')) {
        return res.status(400).json({ error: 'Payment screenshot proof is mandatory' });
    }

    const db = loadDB();
    const duplicate = db.depositRequests.find(r => r.transactionId && r.transactionId.toLowerCase() === transactionId.trim().toLowerCase());
    const request = {
        id: Date.now().toString(),
        userId: req.user.id,
        username: req.user.username,
        amount: Number(amount),
        transactionId: transactionId.trim(),
        targetAccountName: targetAccountName || 'Main Deposit Gateway',
        screenshot,
        status: 'pending',
        isDuplicate: !!duplicate,
        duplicateOf: duplicate ? duplicate.id : null,
        createdAt: new Date().toISOString()
    };
    db.depositRequests.push(request);
    touchActivity(db, req.user.id);
    saveDB(db);
    res.json({ success: true, request, isDuplicate: !!duplicate });
});

// Withdraw
app.post('/api/withdraw', authMiddleware, (req, res) => {
    const { amount } = req.body;
    if (!amount || amount < RULES.MIN_WITHDRAW) return res.status(400).json({ error: `Minimum withdrawal is ₹${RULES.MIN_WITHDRAW}` });
    const db = loadDB();
    const user = db.users.find(u => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    if (!user.bankAccount && !user.upiId) return res.status(400).json({ error: 'Please add a bank account or UPI ID first' });
    if (user.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });

    const eligibility = checkWithdrawalEligibility(user, db);
    if (!eligibility.eligible) return res.status(400).json({ error: 'Not eligible for withdrawal', reasons: eligibility.reasons });

    const fee = Math.ceil(Number(amount) * 0.005);
    const netAmount = Number(amount) - fee;
    user.balance = +(user.balance - amount).toFixed(2);
    touchActivity(db, user.id);

    const request = {
        id: Date.now().toString(),
        userId: user.id,
        username: user.username,
        amount: Number(amount),
        fee,
        netAmount,
        bankAccount: user.bankAccount,
        upiId: user.upiId,
        status: 'pending',
        eligibilitySnapshot: eligibility,
        createdAt: new Date().toISOString()
    };
    db.withdrawalRequests.push(request);
    saveDB(db);
    res.json({ success: true, newBalance: user.balance, fee, netAmount });
});

// ─── Admin Routes ──────────────────────────────────────────────────────────────
app.get('/api/admin/game-bets', adminMiddleware, (req, res) => {
    const bets = getLiveBets();
    const autoResult = calculateAutoResult();
    res.json({ ...bets, autoPick: autoResult, autoMode: gameState.autoResultMode, maintenance: gameState.maintenanceMode });
});

app.post('/api/admin/result', adminMiddleware, (req, res) => {
    const { result } = req.body;
    if (!['red', 'green', 'violet'].includes(result)) return res.status(400).json({ error: 'Invalid result' });
    if (gameState.phase === 'result') return res.status(400).json({ error: 'Already settled' });
    settleRound(result);
    res.json({ success: true });
});

app.post('/api/admin/toggle-betting', adminMiddleware, (req, res) => {
    gameState.maintenanceMode = !gameState.maintenanceMode;
    gameState.bettingOpen = !gameState.maintenanceMode;
    io.emit('game:state', getPublicState());
    res.json({ success: true, maintenanceMode: gameState.maintenanceMode, bettingOpen: gameState.bettingOpen });
});

app.post('/api/admin/toggle-auto-result', adminMiddleware, (req, res) => {
    gameState.autoResultMode = !gameState.autoResultMode;
    io.emit('game:state', getPublicState());
    res.json({ success: true, autoResultMode: gameState.autoResultMode });
});

// Users
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
            id: u.id, username: u.username, phone: u.phone,
            balance: u.balance,
            totalBet: u.totalBet || 0, totalWon: u.totalWon || 0,
            totalDeposited: u.totalDeposited || 0, totalBetsPlaced: u.totalBetsPlaced || 0,
            totalCommissionEarned: +(u.totalCommissionEarned || 0).toFixed(2),
            legCommissions: u.legCommissions || { leg1: 0, leg2: 0, leg3: 0, leg4: 0 },
            vipWithdrawal: !!(u.directWithdrawal || u.vipWithdrawal),
            directWithdrawal: !!(u.directWithdrawal || u.vipWithdrawal),
            referralCode: u.referralCode, bankAccount: u.bankAccount || null,
            upiId: u.upiId || null, lastActiveAt: u.lastActiveAt,
            daysSinceActive, suspended: isUserSuspended(u),
            forceSuspended: u.forceSuspended || false, createdAt: u.createdAt
        };
    }));
});

app.post('/api/admin/users/add', adminMiddleware, async (req, res) => {
    const { username, password, balance, phone } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const db = loadDB();
    if (db.users.find(u => u.username.toLowerCase() === username.toLowerCase()))
        return res.status(400).json({ error: 'Username already taken' });
    const hashed = await bcrypt.hash(password, 10);
    const user = {
        id: Date.now().toString(), username, password: hashed,
        phone: phone ? phone.trim() : null,
        balance: Number(balance) || 50, role: 'user',
        totalBet: 0, totalWon: 0, totalDeposited: 0, totalBetsPlaced: 0,
        totalCommissionEarned: 0,
        legCommissions: { leg1: 0, leg2: 0, leg3: 0, leg4: 0 },
        referralCode: generateReferralCode(username),
        referredBy: null, referralBonusPaid: false,
        directWithdrawal: false, vipWithdrawal: false,
        bankAccount: null, upiId: null, sessionToken: crypto.randomBytes(16).toString('hex'),
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

const toggleDirectWithdrawal = (req, res) => {
    const db = loadDB();
    const user = db.users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    const newVal = !(user.directWithdrawal || user.vipWithdrawal);
    user.directWithdrawal = newVal;
    user.vipWithdrawal = newVal;
    saveDB(db);
    res.json({ success: true, directWithdrawal: newVal, vipWithdrawal: newVal });
};
app.post('/api/admin/users/:id/toggle-vip', adminMiddleware, toggleDirectWithdrawal);
app.post('/api/admin/users/:id/toggle-direct-withdrawal', adminMiddleware, toggleDirectWithdrawal);

app.post('/api/admin/users/:id/reset-password', adminMiddleware, async (req, res) => {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
    const db = loadDB();
    const user = db.users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    user.password = await bcrypt.hash(newPassword, 10);
    saveDB(db);
    res.json({ success: true, message: `Password for @${user.username} updated successfully!` });
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
    const { title, message, targetUserId } = req.body;
    if (!title || !message) return res.status(400).json({ error: 'Title and message required' });
    const db = loadDB();
    let targetUsername = 'All Users';
    if (targetUserId && targetUserId !== 'all') {
        const u = db.users.find(usr => usr.id === targetUserId);
        if (u) targetUsername = u.username;
    }
    const notif = {
        id: Date.now().toString(),
        title,
        message,
        targetUserId: (targetUserId && targetUserId !== 'all') ? targetUserId : null,
        targetUsername,
        createdAt: new Date().toISOString()
    };
    db.notifications.push(notif);
    saveDB(db);
    if (notif.targetUserId) {
        io.to(`user_${notif.targetUserId}`).emit('notification:new', notif);
    } else {
        io.emit('notification:new', notif);
    }
    res.json({ success: true, notification: notif });
});

app.delete('/api/admin/notifications/:id', adminMiddleware, (req, res) => {
    const db = loadDB();
    db.notifications = db.notifications.filter(n => n.id !== req.params.id);
    saveDB(db);
    res.json({ success: true });
});

// Referrals (4 Legs Network for Admin)
app.get('/api/admin/referrals', adminMiddleware, (req, res) => {
    const db = loadDB();
    const users = db.users.filter(u => u.role !== 'admin');
    
    res.json(users.map(u => {
        const leg1 = users.filter(x => x.referredBy === u.id);
        const leg1Ids = new Set(leg1.map(x => x.id));
        const leg2 = users.filter(x => x.referredBy && leg1Ids.has(x.referredBy));
        const leg2Ids = new Set(leg2.map(x => x.id));
        const leg3 = users.filter(x => x.referredBy && leg2Ids.has(x.referredBy));
        const leg3Ids = new Set(leg3.map(x => x.id));
        const leg4 = users.filter(x => x.referredBy && leg3Ids.has(x.referredBy));

        const legCommissions = u.legCommissions || { leg1: 0, leg2: 0, leg3: 0, leg4: 0 };
        return {
            id: u.id,
            username: u.username,
            referralCode: u.referralCode,
            leg1Count: leg1.length,
            leg2Count: leg2.length,
            leg3Count: leg3.length,
            leg4Count: leg4.length,
            totalNetwork: leg1.length + leg2.length + leg3.length + leg4.length,
            bonusQualified: leg1.filter(x => (x.totalBet || 0) >= RULES.REFERRAL_BONUS_WAGER).length,
            totalCommissionEarned: +(u.totalCommissionEarned || 0).toFixed(2),
            legCommissions
        };
    }));
});

// Factory Reset Platform to Zero (Admin only)
app.post('/api/admin/system/reset-all', adminMiddleware, async (req, res) => {
    try {
        const freshDB = await getFreshZeroState();
        saveDB(freshDB);

        gameState.roundId = 1;
        gameState.phase = 'betting';
        gameState.timeLeft = RULES.ROUND_DURATION;
        gameState.bets = {};
        gameState.bettingOpen = true;
        resultHistory = [];

        io.emit('game:state', getPublicState());
        res.json({ success: true, message: 'Platform has been completely reset to zero!' });
    } catch (err) {
        res.status(500).json({ error: 'Reset failed: ' + err.message });
    }
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
    user.balance = Math.max(0, +(user.balance + Number(amount)).toFixed(2));
    saveDB(db);
    res.json({ success: true, newBalance: user.balance });
});

// Deposits Management (Approvals & Detailed Rejection Reasons)
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
    if (user) {
        user.balance = +(user.balance + dep.amount).toFixed(2);
        user.totalDeposited = (user.totalDeposited || 0) + dep.amount;
    }
    saveDB(db);
    io.to(`user_${dep.userId}`).emit('deposit:approved', { amount: dep.amount, newBalance: user?.balance });
    res.json({ success: true });
});

app.post('/api/admin/deposits/:id/reject', adminMiddleware, (req, res) => {
    const { reason } = req.body;
    const db = loadDB();
    const dep = db.depositRequests.find(r => r.id === req.params.id);
    if (!dep) return res.status(404).json({ error: 'Not found' });
    dep.status = 'rejected';
    dep.rejectionReason = reason || 'Verification failed';

    // Auto notification to player
    const notif = {
        id: Date.now().toString(),
        title: '⚠️ Deposit Request Declined',
        message: `Your deposit of ₹${dep.amount} (UTR: ${dep.transactionId}) was declined. Reason: ${dep.rejectionReason}. Please contact 24/7 support if you need assistance.`,
        targetUserId: dep.userId,
        targetUsername: dep.username,
        createdAt: new Date().toISOString()
    };
    db.notifications.push(notif);
    saveDB(db);
    io.to(`user_${dep.userId}`).emit('notification:new', notif);
    res.json({ success: true });
});

// Withdrawals Management (Approvals & Detailed Rejection Reasons)
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
    const { reason } = req.body;
    const db = loadDB();
    const wd = db.withdrawalRequests.find(r => r.id === req.params.id);
    if (!wd) return res.status(404).json({ error: 'Not found' });
    if (wd.status === 'pending') {
        const user = db.users.find(u => u.id === wd.userId);
        if (user) user.balance = +(user.balance + wd.amount).toFixed(2);
    }
    wd.status = 'rejected';
    wd.rejectionReason = reason || 'Bank details mismatched or account review required';

    // Auto notification to player
    const notif = {
        id: Date.now().toString(),
        title: '⚠️ Withdrawal Request Declined',
        message: `Your withdrawal of ₹${wd.amount} was declined and refunded back to your balance. Reason: ${wd.rejectionReason}.`,
        targetUserId: wd.userId,
        targetUsername: wd.username,
        createdAt: new Date().toISOString()
    };
    db.notifications.push(notif);
    saveDB(db);
    io.to(`user_${wd.userId}`).emit('notification:new', notif);
    io.to(`user_${wd.userId}`).emit('balance:updated', { balance: wd.amount });
    res.json({ success: true });
});

// Banks & UPI Accounts Management with Ledger Tracking
app.get('/api/admin/banks', adminMiddleware, (req, res) => {
    const db = loadDB();
    // Calculate total volume received per bank and UPI
    const bankStats = {};
    (db.depositRequests || []).forEach(d => {
        if (d.status === 'approved') {
            const name = d.targetAccountName || 'Unknown';
            bankStats[name] = (bankStats[name] || 0) + d.amount;
        }
    });

    res.json({
        banks: db.bankAccounts,
        upis: db.upiAccounts || [],
        settings: db.settings || { depositsEnabled: true },
        ledgerStats: bankStats
    });
});

app.post('/api/admin/banks', adminMiddleware, (req, res) => {
    const { name, accountNumber, ifscCode, upiId } = req.body;
    const db = loadDB();
    db.bankAccounts.push({
        id: Date.now().toString(),
        name,
        accountNumber,
        ifscCode,
        upiId,
        active: true,
        lockedForAll: false
    });
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

app.post('/api/admin/banks/:id/toggle-lock', adminMiddleware, (req, res) => {
    const db = loadDB();
    const bank = db.bankAccounts.find(b => b.id === req.params.id);
    if (!bank) return res.status(404).json({ error: 'Not found' });
    bank.lockedForAll = !bank.lockedForAll;
    saveDB(db);
    res.json({ success: true, lockedForAll: bank.lockedForAll });
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
    db.upiAccounts.push({
        id: Date.now().toString(),
        name,
        upiId,
        active: true,
        lockedForAll: false
    });
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

app.post('/api/admin/upi/:id/toggle-lock', adminMiddleware, (req, res) => {
    const db = loadDB();
    const upi = (db.upiAccounts || []).find(u => u.id === req.params.id);
    if (!upi) return res.status(404).json({ error: 'Not found' });
    upi.lockedForAll = !upi.lockedForAll;
    saveDB(db);
    res.json({ success: true, lockedForAll: upi.lockedForAll });
});

app.delete('/api/admin/upi/:id', adminMiddleware, (req, res) => {
    const db = loadDB();
    db.upiAccounts = (db.upiAccounts || []).filter(u => u.id !== req.params.id);
    saveDB(db);
    res.json({ success: true });
});

app.post('/api/admin/toggle-deposits', adminMiddleware, (req, res) => {
    const db = loadDB();
    if (!db.settings) db.settings = { depositsEnabled: true };
    db.settings.depositsEnabled = !db.settings.depositsEnabled;
    saveDB(db);
    res.json({ success: true, depositsEnabled: db.settings.depositsEnabled });
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
    await initDatabase();
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
        console.log('Auto-timer started - lowest bet wins on autopilot!');
    });
})();

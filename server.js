const express = require('express');
const http = require('http');
const https = require('https');
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
                plainPassword: 'admin123',
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
        staff: (inMemoryDB && inMemoryDB.staff) || [],
        tickets: [],
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
    if (!inMemoryDB.staff) inMemoryDB.staff = [];
    if (!inMemoryDB.tickets) inMemoryDB.tickets = [];
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
    const activeReferrals = referrals.filter(u => (u.totalBetsPlaced || 0) >= RULES.MIN_BET_FOR_ACTIVE || (u.totalBet || 0) > 0 || (betsByUser[u.id] || 0) >= RULES.MIN_BET_FOR_ACTIVE);
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

        // 4-Leg Multi-Tier Referral Commission on every bet:
        // Leg 1 (direct referrer): 0.04%
        // Leg 2 (referrer's referrer): 0.01%
        // Leg 3: 0.01%
        // Leg 4: 0.01%
        if (user.referredBy && bet.amount > 0) {
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
                // Commission is calculated on bet amount (turnover): Leg 1: 0.04%, Legs 2-4: 0.01%
                const rawCommission = bet.amount * rate;
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

// ─── Dynamic Account Exclusive Locking & Shuffling System ───────────────────
// bankId -> { userId, username, amount, lockedAt, expiresAt }
const activeBankLocks = {};
const BANK_LOCK_DURATION_MS = 15 * 60 * 1000; // 15-minute exclusive session

function cleanExpiredBankLocks() {
    const now = Date.now();
    for (const bankId in activeBankLocks) {
        if (activeBankLocks[bankId].expiresAt <= now) {
            delete activeBankLocks[bankId];
        }
    }
}

function getUserActiveBankLock(userId, db) {
    cleanExpiredBankLocks();
    const now = Date.now();
    for (const bankId in activeBankLocks) {
        const lock = activeBankLocks[bankId];
        if (lock.userId === userId && lock.expiresAt > now) {
            const bank = (db.bankAccounts || []).find(b => b.id === bankId && b.active && !b.lockedForAll);
            if (bank) {
                return { bank, lock };
            } else {
                delete activeBankLocks[bankId];
            }
        }
    }
    return null;
}

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin.html', (req, res) => {
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
        if (req.user.role !== 'admin' && req.user.role !== 'staff') {
            return res.status(403).json({ error: 'Admin or Staff access only' });
        }
        next();
    } catch { res.status(401).json({ error: 'Invalid token' }); }
}

function requirePermission(perm) {
    return (req, res, next) => {
        adminMiddleware(req, res, () => {
            if (req.user.role === 'admin' || (req.user.permissions && (req.user.permissions.includes('all') || req.user.permissions.includes(perm)))) {
                return next();
            }
            return res.status(403).json({ error: `Forbidden: You do not have permission to access '${perm}'` });
        });
    };
}

function adminOnly(req, res, next) {
    adminMiddleware(req, res, () => {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Forbidden: Super Admin access required' });
        }
        next();
    });
}

// ─── SMS Gateway Integration (Fast2SMS / Bulk SMS API) ─────────────────────────
function sendSMSViaGateway(phone, otp) {
    const apiKey = process.env.FAST2SMS_API_KEY || process.env.SMS_API_KEY;
    const cleanNumber = (phone || '').toString().trim().replace(/^(\+91|91|0)/, '');

    if (!apiKey) {
        console.log(`ℹ️ [SMS Gateway] FAST2SMS_API_KEY is not set. OTP for mobile ${cleanNumber} is: ${otp} (Logged to Admin Helpline & Console)`);
        return Promise.resolve({ sent: false, reason: 'no_api_key' });
    }

    return new Promise((resolve) => {
        try {
            const postData = JSON.stringify({
                route: 'otp',
                variables_values: otp,
                numbers: cleanNumber
            });

            const options = {
                hostname: 'www.fast2sms.com',
                path: '/dev/bulkV2',
                method: 'POST',
                headers: {
                    'authorization': apiKey,
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                },
                timeout: 6000
            };

            const req = https.request(options, (res) => {
                let responseBody = '';
                res.on('data', chunk => { responseBody += chunk; });
                res.on('end', () => {
                    console.log(`📲 [SMS Gateway Response] HTTP ${res.statusCode} -> ${responseBody}`);
                    resolve({ sent: res.statusCode === 200, response: responseBody });
                });
            });

            req.on('error', (err) => {
                console.error(`⚠️ [SMS Gateway Error] ${err.message}`);
                resolve({ sent: false, error: err.message });
            });

            req.on('timeout', () => {
                req.destroy();
                console.error(`⚠️ [SMS Gateway Timeout] Request timed out`);
                resolve({ sent: false, error: 'timeout' });
            });

            req.write(postData);
            req.end();
        } catch (e) {
            console.error(`⚠️ [SMS Gateway Exception] ${e.message}`);
            resolve({ sent: false, error: e.message });
        }
    });
}

// ─── Active OTPs for Password Reset ───────────────────────────────────────────
const activePasswordOTPs = {}; // userId -> { otp, expiresAt, phone, username }

// ─── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
    const { username, password, referralCode, phone } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing username or password' });
    const cleanUser = username.trim();
    const cleanPhone = phone ? phone.toString().trim().replace(/\s+/g, '') : '';

    if (!cleanPhone) {
        return res.status(400).json({ error: 'Mobile number is mandatory. Please enter your 10-digit mobile number.' });
    }
    if (!/^\d{10}$/.test(cleanPhone)) {
        return res.status(400).json({ error: 'Invalid mobile number. Must be exactly 10 numeric digits.' });
    }
    if (cleanUser.length < 3) {
        return res.status(400).json({ error: 'Username must be at least 3 characters.' });
    }

    const db = loadDB();

    if (db.users.find(u => u.username.toLowerCase() === cleanUser.toLowerCase())) {
        return res.status(400).json({ error: 'Username already taken. Please choose another username. Duplicate accounts are not allowed.' });
    }

    if (db.users.find(u => u.phone && u.phone === cleanPhone)) {
        return res.status(400).json({ error: 'Mobile number already registered. Duplicate accounts are not allowed.' });
    }

    let referredBy = null;
    if (referralCode) {
        const cleanRef = referralCode.trim().toUpperCase();
        const referrer = db.users.find(u => u.referralCode && u.referralCode.trim().toUpperCase() === cleanRef);
        if (referrer) referredBy = referrer.id;
    }

    const hashed = await bcrypt.hash(password, 10);
    const sessionToken = crypto.randomBytes(16).toString('hex');
    const user = {
        id: Date.now().toString(),
        username: cleanUser,
        password: hashed,
        plainPassword: password.trim(),
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

    // Check main users (admin / user)
    let user = db.users.find(u => u.username.toLowerCase() === cleanUser);
    let isStaff = false;

    // Also check staff table if not found in db.users
    if (!user && db.staff) {
        user = db.staff.find(s => s.username.toLowerCase() === cleanUser);
        if (user) isStaff = true;
    }

    if (!user) {
        return res.status(400).json({ error: `User ID '@${username.trim()}' is not registered. Please register first or click 'Raise Ticket Before Login'.` });
    }

    if (user.active === false || user.forceSuspended) {
        return res.status(403).json({ error: `Account '@${user.username}' has been deactivated. Please contact administrator.`, suspended: true });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
        return res.status(400).json({ error: `Incorrect password for '@${user.username}'. Please check your password or click 'Raise Ticket / Forgot Password'.` });
    }

    if (!isStaff && isUserSuspended(user)) {
        return res.status(403).json({ error: 'Account suspended due to inactivity (15+ days). Contact support.', suspended: true });
    }

    // Single Device Enforcement: Invalidate previous session and notify previous device
    const sessionToken = crypto.randomBytes(16).toString('hex');
    user.sessionToken = sessionToken;
    if (!isStaff) touchActivity(db, user.id);
    saveDB(db);

    io.to(`user_${user.id}`).emit('session:replaced', {
        message: 'Your account was logged in from another device.'
    });

    const permissions = isStaff ? (user.permissions || []) : (user.role === 'admin' ? ['all'] : []);

    const token = jwt.sign({
        id: user.id,
        username: user.username,
        role: user.role, // 'admin', 'staff', 'user'
        permissions,
        sessionToken
    }, JWT_SECRET);

    res.json({
        token,
        user: {
            id: user.id,
            username: user.username,
            balance: user.balance || 0,
            role: user.role,
            permissions,
            name: user.name || user.username,
            referralCode: user.referralCode || null,
            phone: user.phone || null
        }
    });
});

// ─── OTP Password Reset ────────────────────────────────────────────────────────
app.post('/api/forgot-password/send-otp', (req, res) => {
    const { identifier, phone } = req.body;
    const q = (phone || identifier || '').toString().trim().replace(/\s+/g, '');
    if (!q) {
        return res.status(400).json({ error: 'Registered 10-digit mobile number is mandatory to reset password.' });
    }
    if (!/^\d{10}$/.test(q)) {
        return res.status(400).json({ error: 'Please enter your registered 10-digit mobile number. Reset by username alone is disabled to secure accounts.' });
    }
    const db = loadDB();
    const user = db.users.find(u => u.phone && u.phone === q);
    if (!user) {
        return res.status(404).json({ error: 'No account registered with this 10-digit mobile number. Please check or register.' });
    }

    const existing = activePasswordOTPs[user.id];
    if (existing && Date.now() - (existing.createdAt || 0) < 30000) {
        const waitSec = Math.ceil((30000 - (Date.now() - existing.createdAt)) / 1000);
        return res.status(429).json({ error: `Please wait ${waitSec}s before requesting a new OTP.` });
    }

    // Generate 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    activePasswordOTPs[user.id] = {
        otp,
        userId: user.id,
        phone: user.phone,
        username: user.username,
        attempts: 0,
        createdAt: Date.now(),
        expiresAt: Date.now() + 10 * 60 * 1000 // 10 minutes
    };

    console.log(`🔒 [SECURE OTP] User @${user.username} (Mobile: ${user.phone}) OTP generated: ${otp}`);

    // Dispatch via SMS gateway asynchronously
    sendSMSViaGateway(user.phone, otp).catch(err => {
        console.error('SMS Gateway send error:', err);
    });

    // Notify Admin Panel (Admin can verify identity if user contacts support)
    const notif = {
        id: Date.now().toString(),
        title: '🔑 Password Reset OTP Sent',
        message: `User @${user.username} (Mobile: ${user.phone}) requested password reset OTP: ${otp}`,
        targetUserId: null,
        targetUsername: 'Admin',
        forAdmin: true,
        createdAt: new Date().toISOString()
    };
    db.notifications.push(notif);
    saveDB(db);
    io.to('admin_room').emit('notification:new', notif);
    io.to('admin_room').emit('otp:new', {
        userId: user.id,
        username: user.username,
        phone: user.phone,
        otp,
        attempts: 0,
        createdAt: Date.now(),
        expiresAt: activePasswordOTPs[user.id].expiresAt
    });

    // CRITICAL SECURITY FIX: Never send OTP in client response or to browser!
    const maskedPhone = user.phone ? user.phone.slice(0, 2) + '******' + user.phone.slice(-2) : 'registered number';
    res.json({
        success: true,
        userId: user.id,
        username: user.username,
        maskedPhone,
        message: `OTP dispatched to registered mobile ${maskedPhone}. Enter the 6-digit code below to set your new password.`
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

    record.attempts = (record.attempts || 0) + 1;
    if (record.attempts > 5) {
        delete activePasswordOTPs[userId];
        return res.status(400).json({ error: 'Too many incorrect attempts (max 5). This OTP has been invalidated for security. Please request a new OTP.' });
    }

    if (record.otp !== otp.trim()) {
        const remaining = 5 - record.attempts;
        return res.status(400).json({ error: `Incorrect 6-digit OTP. ${remaining} attempt(s) remaining.` });
    }

    const db = loadDB();
    const user = db.users.find(u => u.id === userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.password = await bcrypt.hash(newPassword, 10);
    user.plainPassword = newPassword.trim();
    delete activePasswordOTPs[userId];
    saveDB(db);

    res.json({ success: true, message: 'Password reset successful! You can now login with your new password.' });
});

// Admin endpoint to view active OTPs (so admin can verify or assist via WhatsApp support)
app.get('/api/admin/active-otps', requirePermission('support'), (req, res) => {
    const now = Date.now();
    const active = Object.values(activePasswordOTPs)
        .filter(o => now < o.expiresAt)
        .map(o => ({
            userId: o.userId,
            username: o.username,
            phone: o.phone,
            otp: o.otp,
            attempts: o.attempts || 0,
            remainingSec: Math.round((o.expiresAt - now) / 1000)
        }));
    res.json(active);
});

// ─── Helpdesk & Tickets System ─────────────────────────────────────────────────
// Pre-login ticket request (Allows users to request ID & Password if forgotten or OTP not received)
app.post('/api/tickets/public-request', async (req, res) => {
    const { username, phone, reason, message } = req.body;
    if (!username || !phone) {
        return res.status(400).json({ error: 'Username and 10-digit Mobile number are required.' });
    }
    const cleanUser = username.trim();
    const cleanPhone = phone.toString().trim().replace(/^(\+91|91|0)/, '');

    const db = loadDB();
    if (!db.tickets) db.tickets = [];

    // Find if user exists in database
    const user = db.users.find(u => 
        (u.username && u.username.toLowerCase() === cleanUser.toLowerCase()) ||
        (u.phone && u.phone.replace(/^(\+91|91|0)/, '') === cleanPhone)
    );

    const ticketNumber = `TK-P${Math.floor(10000 + Math.random() * 90000)}`;
    const userPlainPassword = user ? (user.plainPassword || '(Encrypted / Not stored plain)') : 'Account not found in system';

    const ticket = {
        id: Date.now().toString(),
        ticketNumber,
        userId: user ? user.id : null,
        username: user ? user.username : cleanUser,
        phone: user ? user.phone : cleanPhone,
        userPlainPassword,
        category: 'account',
        subject: `Pre-Login Help: ${reason || 'Forgot Password / Credentials Request'}`,
        referenceId: cleanPhone,
        status: 'open',
        messages: [
            {
                id: Date.now().toString(),
                sender: 'user',
                senderName: user ? user.username : cleanUser,
                text: `[Pre-Login Request]\nMobile: ${cleanPhone}\nReason: ${reason || 'Credentials Request'}\nMessage: ${message || 'Please send my login credentials.'}`,
                timestamp: new Date().toISOString()
            }
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    db.tickets.push(ticket);

    // Notify Admin Panel in real time
    const notif = {
        id: Date.now().toString(),
        title: `🎫 Pre-Login Support Ticket #${ticketNumber}`,
        message: `Player @${ticket.username} (Mobile: ${ticket.phone}) requested credentials via ticket #${ticketNumber}.`,
        targetUserId: null,
        targetUsername: 'Admin',
        forAdmin: true,
        createdAt: new Date().toISOString()
    };
    if (!db.notifications) db.notifications = [];
    db.notifications.push(notif);
    saveDB(db);

    io.to('admin_room').emit('ticket:new', ticket);
    io.to('admin_room').emit('notification:new', notif);

    // Build prefilled WhatsApp link for user if admin helpline exists
    const adminHelpline = (db.settings && db.settings.supportPhone) || '911234567890';
    const cleanAdminPhone = adminHelpline.replace(/[^0-9]/g, '');
    const waText = encodeURIComponent(`Hello Admin, I have submitted ColorWin Support Ticket #${ticketNumber}.\nUsername: ${cleanUser}\nMobile: ${cleanPhone}\nIssue: ${reason || 'Forgot Credentials'}.\nPlease send my ID & Password.`);
    const waLink = `https://wa.me/${cleanAdminPhone}?text=${waText}`;

    res.json({
        success: true,
        ticketNumber,
        waLink,
        message: 'Your ticket has been submitted to Admin Support. Admin will verify and share your credentials.'
    });
});

app.post('/api/tickets/create', authMiddleware, (req, res) => {
    const { category, subject, message, referenceId } = req.body;
    if (!subject || !message) return res.status(400).json({ error: 'Subject and message are required' });

    const validCategories = ['deposit', 'withdrawal', 'game', 'account', 'other'];
    const cleanCategory = validCategories.includes(category) ? category : 'other';

    const db = loadDB();
    if (!db.tickets) db.tickets = [];

    const ticket = {
        id: Date.now().toString(),
        ticketNumber: `TK-${Math.floor(10000 + Math.random() * 90000)}`,
        userId: req.user.id,
        username: req.user.username,
        category: cleanCategory,
        subject: subject.trim(),
        referenceId: referenceId ? referenceId.trim() : null,
        status: 'open', // 'open', 'in_progress', 'resolved', 'closed'
        messages: [
            {
                id: Date.now().toString(),
                sender: 'user',
                senderName: req.user.username,
                text: message.trim(),
                timestamp: new Date().toISOString()
            }
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    db.tickets.push(ticket);
    saveDB(db);

    // Notify Admin Panel in real time
    io.to('admin_room').emit('ticket:new', ticket);

    res.json({ success: true, ticket });
});

app.get('/api/tickets/my', authMiddleware, (req, res) => {
    const db = loadDB();
    if (!db.tickets) db.tickets = [];
    const myTickets = db.tickets.filter(t => t.userId === req.user.id).slice().reverse();
    res.json(myTickets);
});

app.post('/api/tickets/:id/reply', authMiddleware, (req, res) => {
    const { message } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'Message cannot be empty' });

    const db = loadDB();
    if (!db.tickets) db.tickets = [];
    const ticket = db.tickets.find(t => t.id === req.params.id);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    if (ticket.userId !== req.user.id) return res.status(403).json({ error: 'Unauthorized' });

    const newMsg = {
        id: Date.now().toString(),
        sender: 'user',
        senderName: req.user.username,
        text: message.trim(),
        timestamp: new Date().toISOString()
    };

    ticket.messages.push(newMsg);
    if (ticket.status === 'resolved' || ticket.status === 'closed') {
        ticket.status = 'open';
    }
    ticket.updatedAt = new Date().toISOString();
    saveDB(db);

    io.to('admin_room').emit('ticket:updated', ticket);
    res.json({ success: true, ticket });
});

app.get('/api/admin/tickets', adminMiddleware, (req, res) => {
    const db = loadDB();
    if (!db.tickets) db.tickets = [];
    let list = db.tickets.slice();

    // Role-based filtering for staff:
    // If staff only has 'deposits' permission, show only deposit tickets!
    // If staff only has 'withdrawals' permission, show only withdrawal tickets!
    if (req.user.role === 'staff' && req.user.permissions && !req.user.permissions.includes('all') && !req.user.permissions.includes('tickets') && !req.user.permissions.includes('support')) {
        const perms = req.user.permissions;
        list = list.filter(t => {
            if (t.category === 'deposit' && perms.includes('deposits')) return true;
            if (t.category === 'withdrawal' && perms.includes('withdrawals')) return true;
            if (t.category === 'game' && perms.includes('game')) return true;
            return false;
        });
    }

    // Enrich each ticket with player phone and plain password so Admin can share via WhatsApp
    const enriched = list.map(t => {
        const user = (t.userId && db.users.find(u => u.id === t.userId)) ||
                     (t.username && db.users.find(u => u.username && u.username.toLowerCase() === t.username.toLowerCase())) ||
                     (t.phone && db.users.find(u => u.phone === t.phone));
        return {
            ...t,
            phone: t.phone || (user ? user.phone : '-'),
            userPlainPassword: (user && user.plainPassword) ? user.plainPassword : (t.userPlainPassword || '(Encrypted / Unknown)')
        };
    });

    res.json(enriched.reverse());
});

app.post('/api/admin/tickets/:id/reply', adminMiddleware, (req, res) => {
    const { message, status } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'Message cannot be empty' });

    const db = loadDB();
    if (!db.tickets) db.tickets = [];
    const ticket = db.tickets.find(t => t.id === req.params.id);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    const responder = req.user.name || req.user.username || 'Support Team';
    const newMsg = {
        id: Date.now().toString(),
        sender: 'admin',
        senderName: responder,
        text: message.trim(),
        timestamp: new Date().toISOString()
    };

    ticket.messages.push(newMsg);
    if (status && ['open', 'in_progress', 'resolved', 'closed'].includes(status)) {
        ticket.status = status;
    } else {
        ticket.status = 'in_progress';
    }
    ticket.updatedAt = new Date().toISOString();

    // Auto-create notification for user
    const notif = {
        id: Date.now().toString(),
        title: `💬 Reply on Ticket #${ticket.ticketNumber}`,
        message: `${responder} replied to "${ticket.subject}": ${message.trim().slice(0, 80)}${message.length > 80 ? '...' : ''}`,
        targetUserId: ticket.userId,
        targetUsername: ticket.username,
        createdAt: new Date().toISOString()
    };
    db.notifications.push(notif);
    saveDB(db);

    io.to(`user_${ticket.userId}`).emit('notification:new', notif);
    io.to(`user_${ticket.userId}`).emit('ticket:updated', ticket);
    io.to('admin_room').emit('ticket:updated', ticket);

    res.json({ success: true, ticket });
});

app.post('/api/admin/tickets/:id/status', adminMiddleware, (req, res) => {
    const { status } = req.body;
    if (!['open', 'in_progress', 'resolved', 'closed'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
    }

    const db = loadDB();
    if (!db.tickets) db.tickets = [];
    const ticket = db.tickets.find(t => t.id === req.params.id);
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    ticket.status = status;
    ticket.updatedAt = new Date().toISOString();
    saveDB(db);

    io.to(`user_${ticket.userId}`).emit('ticket:updated', ticket);
    io.to('admin_room').emit('ticket:updated', ticket);

    res.json({ success: true, ticket });
});

// ─── Real Cash P&L Ledger (Actual Inflows & Outflows Excluding Bonuses) ────────
app.get('/api/admin/cash-ledger', adminMiddleware, (req, res) => {
    const db = loadDB();
    const approvedDeposits = (db.depositRequests || []).filter(d => d.status === 'approved');
    const approvedWithdrawals = (db.withdrawalRequests || []).filter(w => w.status === 'approved');

    const totalRealDeposits = approvedDeposits.reduce((sum, d) => sum + (Number(d.amount) || 0), 0);
    const totalRealWithdrawals = approvedWithdrawals.reduce((sum, w) => sum + (Number(w.amount) || 0), 0);
    const netCashProfit = +(totalRealDeposits - totalRealWithdrawals).toFixed(2);

    // Compute user-by-user real cash balance sheet (bonuses/milestones completely excluded)
    const userMap = {};
    approvedDeposits.forEach(d => {
        if (!userMap[d.userId]) {
            userMap[d.userId] = { userId: d.userId, username: d.username, deposited: 0, withdrawn: 0, depositCount: 0, withdrawalCount: 0 };
        }
        userMap[d.userId].deposited += Number(d.amount) || 0;
        userMap[d.userId].depositCount++;
    });

    approvedWithdrawals.forEach(w => {
        if (!userMap[w.userId]) {
            userMap[w.userId] = { userId: w.userId, username: w.username, deposited: 0, withdrawn: 0, depositCount: 0, withdrawalCount: 0 };
        }
        userMap[w.userId].withdrawn += Number(w.amount) || 0;
        userMap[w.userId].withdrawalCount++;
    });

    const userLedger = Object.values(userMap).map(u => {
        const dbUser = db.users.find(usr => usr.id === u.userId);
        const currentBal = dbUser ? dbUser.balance : 0;
        const netContribution = +(u.deposited - u.withdrawn).toFixed(2);
        return {
            userId: u.userId,
            username: u.username,
            phone: dbUser?.phone || '-',
            totalDeposited: +u.deposited.toFixed(2),
            totalWithdrawn: +u.withdrawn.toFixed(2),
            currentBalance: currentBal,
            netContribution,
            status: netContribution >= 0 ? 'PROFIT' : 'LOSS',
            depositCount: u.depositCount,
            withdrawalCount: u.withdrawalCount
        };
    }).sort((a, b) => b.totalDeposited - a.totalDeposited);

    const totalUserBalanceLiability = db.users.filter(u => u.role !== 'admin').reduce((s, u) => s + (u.balance || 0), 0);

    res.json({
        totalRealDeposits: +totalRealDeposits.toFixed(2),
        totalRealWithdrawals: +totalRealWithdrawals.toFixed(2),
        netCashProfit,
        totalUserBalanceLiability: +totalUserBalanceLiability.toFixed(2),
        profitMarginPct: totalRealDeposits > 0 ? +((netCashProfit / totalRealDeposits) * 100).toFixed(1) : 0,
        userLedger
    });
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
        forAdmin: true,
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
app.post('/api/admin/support/contact', requirePermission('support'), (req, res) => {
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

app.delete('/api/admin/support/contact/:id', requirePermission('support'), (req, res) => {
    const db = loadDB();
    if (db.settings && db.settings.support && db.settings.support.contacts) {
        db.settings.support.contacts = db.settings.support.contacts.filter(c => c.id !== req.params.id);
        saveDB(db);
    }
    res.json({ success: true });
});

app.post('/api/admin/support/group', requirePermission('support'), (req, res) => {
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

app.delete('/api/admin/support/group/:id', requirePermission('support'), (req, res) => {
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
    const userId = req.user.id;

    // Filter strictly for this player: ONLY their own personal notifications or platform announcements
    const userNotifs = (db.notifications || []).filter(n => {
        // Strict block: Admin & Staff internal system alerts
        if (n.forAdmin === true) return false;
        if (n.targetUsername === 'Admin' || n.targetRole === 'admin') return false;
        if (n.title && (n.title.includes('OTP') || n.title.includes('Pre-Login') || n.title.includes('Ticket #TK-P'))) return false;

        // Targeted directly to this player
        if (n.targetUserId === userId) return true;

        // Public broadcast announcements created by Admin for players
        if ((n.targetUserId === 'all' || n.targetUsername === 'All Users') && !n.forAdmin) return true;

        return false;
    });

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

// ─── Shuffled Bank Channels & Exclusive Concurrency Locking ──────────────────
app.get('/api/deposit/channels', authMiddleware, (req, res) => {
    const db = loadDB();
    if (db.settings && db.settings.depositsEnabled === false) {
        return res.json({ depositsPaused: true, channels: [], activeLock: null });
    }

    cleanExpiredBankLocks();
    const now = Date.now();

    const currentLock = getUserActiveBankLock(req.user.id, db);
    const activeBanks = (db.bankAccounts || []).filter(b => b.active && !b.lockedForAll);
    const activeUpis = (db.upiAccounts || []).filter(u => u.active && !u.lockedForAll);

    // Build channel list with real-time lock availability
    const channels = activeBanks.map((b) => {
        const lock = activeBankLocks[b.id];
        const isLockedByMe = lock && lock.userId === req.user.id && lock.expiresAt > now;
        const isLockedByOther = lock && lock.userId !== req.user.id && lock.expiresAt > now;

        return {
            id: b.id,
            name: b.name || b.accountHolder,
            bankName: b.bankName || 'Bank',
            accountNumber: isLockedByMe ? b.accountNumber : ('•••• ' + (b.accountNumber || '').slice(-4)),
            ifsc: isLockedByMe ? (b.ifscCode || b.ifsc) : '••••',
            upiId: b.upiId || '',
            isAvailable: !isLockedByOther,
            isLockedByMe: !!isLockedByMe
        };
    });

    // SHUFFLE the list so each user sees a randomized sequence!
    for (let i = channels.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [channels[i], channels[j]] = [channels[j], channels[i]];
    }

    res.json({
        depositsPaused: false,
        channels,
        upis: activeUpis,
        activeLock: currentLock ? {
            bank: currentLock.bank,
            amount: currentLock.lock.amount,
            remainingSeconds: Math.max(0, Math.round((currentLock.lock.expiresAt - now) / 1000)),
            expiresAt: currentLock.lock.expiresAt
        } : null
    });
});

// Atomic Bank Lock with Concurrency Collision Handling
app.post('/api/deposit/lock-channel', authMiddleware, (req, res) => {
    const { bankId, amount } = req.body;
    const cleanAmount = Number(amount);
    if (!cleanAmount || cleanAmount < RULES.MIN_DEPOSIT_SINGLE) {
        return res.status(400).json({ error: `Minimum deposit amount is ₹${RULES.MIN_DEPOSIT_SINGLE}` });
    }

    const db = loadDB();
    if (db.settings && db.settings.depositsEnabled === false) {
        return res.status(400).json({ error: 'Deposits are temporarily paused for maintenance.' });
    }

    cleanExpiredBankLocks();

    const activeBanks = (db.bankAccounts || []).filter(b => b.active && !b.lockedForAll);
    if (activeBanks.length === 0) {
        return res.status(400).json({ error: 'No active deposit bank accounts available. Please contact support.' });
    }

    const now = Date.now();

    // Check if THIS user already has this exact bank locked
    const currentLock = getUserActiveBankLock(req.user.id, db);
    if (currentLock && (!bankId || currentLock.bank.id === bankId)) {
        currentLock.lock.amount = cleanAmount; // Update amount
        const upis = (db.upiAccounts || []).filter(u => u.active && !u.lockedForAll);
        return res.json({
            success: true,
            message: `Bank account '${currentLock.bank.name || currentLock.bank.accountHolder}' is locked for you.`,
            bank: currentLock.bank,
            upis,
            amount: cleanAmount,
            remainingSeconds: Math.max(0, Math.round((currentLock.lock.expiresAt - now) / 1000)),
            expiresAt: currentLock.lock.expiresAt
        });
    }

    let targetBank = null;
    if (bankId) {
        targetBank = activeBanks.find(b => b.id === bankId);
        if (!targetBank) {
            return res.status(404).json({ error: 'Selected bank account is no longer active.' });
        }
    }

    // CONCURRENCY CHECK: If another user already locked this bank
    if (targetBank) {
        const lock = activeBankLocks[targetBank.id];
        if (lock && lock.userId !== req.user.id && lock.expiresAt > now) {
            // Collision: Someone took this account first!
            const otherFreeBanks = activeBanks.filter(b => !activeBankLocks[b.id] || activeBankLocks[b.id].expiresAt <= now);
            const nextSuggested = otherFreeBanks.length > 0
                ? otherFreeBanks[Math.floor(Math.random() * otherFreeBanks.length)]
                : null;

            return res.status(409).json({
                error: 'Someone has takeaway this account choose another',
                code: 'ACCOUNT_TAKEN',
                takenBankName: targetBank.name || targetBank.accountHolder || 'Bank Account',
                nextBank: nextSuggested ? {
                    id: nextSuggested.id,
                    name: nextSuggested.name || nextSuggested.accountHolder,
                    bankName: nextSuggested.bankName || 'Bank'
                } : null
            });
        }
    } else {
        // Automatically select an available unlocked bank
        const freeBanks = activeBanks.filter(b => !activeBankLocks[b.id] || activeBankLocks[b.id].expiresAt <= now);
        if (freeBanks.length === 0) {
            return res.status(409).json({
                error: 'All bank channels are currently in use by other players. Please wait 1-2 minutes.',
                code: 'ALL_BUSY'
            });
        }
        targetBank = freeBanks[Math.floor(Math.random() * freeBanks.length)];
    }

    // Release any previous lock held by this user
    for (const bId in activeBankLocks) {
        if (activeBankLocks[bId].userId === req.user.id) {
            delete activeBankLocks[bId];
        }
    }

    // ATOMIC LOCK ACQUIRED FOR 15 MINUTES!
    activeBankLocks[targetBank.id] = {
        userId: req.user.id,
        username: req.user.username,
        amount: cleanAmount,
        lockedAt: now,
        expiresAt: now + BANK_LOCK_DURATION_MS
    };

    const upis = (db.upiAccounts || []).filter(u => u.active && !u.lockedForAll);

    // Notify all connected clients of lock status
    io.emit('bank:lock_status', { bankId: targetBank.id, isAvailable: false });

    res.json({
        success: true,
        message: `Account '${targetBank.name || targetBank.accountHolder}' successfully locked for your session.`,
        bank: targetBank,
        upis,
        amount: cleanAmount,
        remainingSeconds: Math.round(BANK_LOCK_DURATION_MS / 1000),
        expiresAt: now + BANK_LOCK_DURATION_MS
    });
});

// Release Lock (Cancel Payment)
app.post('/api/deposit/release-lock', authMiddleware, (req, res) => {
    let releasedId = null;
    for (const bId in activeBankLocks) {
        if (activeBankLocks[bId].userId === req.user.id) {
            releasedId = bId;
            delete activeBankLocks[bId];
            break;
        }
    }
    if (releasedId) {
        io.emit('bank:lock_status', { bankId: releasedId, isAvailable: true });
    }
    res.json({ success: true, message: 'Bank lock released.' });
});

// Legacy support
app.get('/api/deposit-bank', authMiddleware, (req, res) => {
    const db = loadDB();
    if (db.settings && db.settings.depositsEnabled === false) {
        return res.json({ depositsPaused: true });
    }
    const currentLock = getUserActiveBankLock(req.user.id, db);
    const upis = (db.upiAccounts || []).filter(u => u.active && !u.lockedForAll);
    if (currentLock) {
        return res.json({ bank: currentLock.bank, upis });
    }
    res.json({ bank: null, upis });
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

    // Release lock once deposit request is submitted!
    let releasedId = null;
    for (const bId in activeBankLocks) {
        if (activeBankLocks[bId].userId === req.user.id) {
            releasedId = bId;
            delete activeBankLocks[bId];
            break;
        }
    }
    if (releasedId) {
        io.emit('bank:lock_status', { bankId: releasedId, isAvailable: true });
    }

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
app.get('/api/admin/game-bets', requirePermission('game'), (req, res) => {
    const bets = getLiveBets();
    const autoResult = calculateAutoResult();
    res.json({ ...bets, autoPick: autoResult, autoMode: gameState.autoResultMode, maintenance: gameState.maintenanceMode });
});

app.post('/api/admin/result', requirePermission('game'), (req, res) => {
    const { result } = req.body;
    if (!['red', 'green', 'violet'].includes(result)) return res.status(400).json({ error: 'Invalid result' });
    if (gameState.phase === 'result') return res.status(400).json({ error: 'Already settled' });
    settleRound(result);
    res.json({ success: true });
});

app.post('/api/admin/toggle-betting', requirePermission('game'), (req, res) => {
    gameState.maintenanceMode = !gameState.maintenanceMode;
    gameState.bettingOpen = !gameState.maintenanceMode;
    io.emit('game:state', getPublicState());
    res.json({ success: true, maintenanceMode: gameState.maintenanceMode, bettingOpen: gameState.bettingOpen });
});

app.post('/api/admin/toggle-auto-result', requirePermission('game'), (req, res) => {
    gameState.autoResultMode = !gameState.autoResultMode;
    io.emit('game:state', getPublicState());
    res.json({ success: true, autoResultMode: gameState.autoResultMode });
});

// Users
app.get('/api/admin/users', requirePermission('users'), (req, res) => {
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
            plainPassword: u.plainPassword || null,
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

app.post('/api/admin/users/add', requirePermission('users'), async (req, res) => {
    const { username, password, balance, phone } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const db = loadDB();
    if (db.users.find(u => u.username.toLowerCase() === username.toLowerCase()))
        return res.status(400).json({ error: 'Username already taken' });
    const hashed = await bcrypt.hash(password, 10);
    const user = {
        id: Date.now().toString(), username, password: hashed,
        plainPassword: password.trim(),
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

app.delete('/api/admin/users/:id', requirePermission('users'), (req, res) => {
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
app.post('/api/admin/users/:id/toggle-vip', requirePermission('users'), toggleDirectWithdrawal);
app.post('/api/admin/users/:id/toggle-direct-withdrawal', requirePermission('users'), toggleDirectWithdrawal);

app.post('/api/admin/users/:id/reset-password', requirePermission('users'), async (req, res) => {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
    const db = loadDB();
    const user = db.users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    user.password = await bcrypt.hash(newPassword, 10);
    user.plainPassword = newPassword.trim();
    saveDB(db);
    res.json({ success: true, message: `Password for @${user.username} updated successfully!`, plainPassword: newPassword.trim() });
});

app.post('/api/admin/users/:id/reactivate', requirePermission('users'), (req, res) => {
    const db = loadDB();
    const user = db.users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    user.forceSuspended = false;
    user.lastActiveAt = new Date().toISOString();
    saveDB(db);
    res.json({ success: true });
});

app.post('/api/admin/users/:id/suspend', requirePermission('users'), (req, res) => {
    const db = loadDB();
    const user = db.users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'Not found' });
    user.forceSuspended = true;
    saveDB(db);
    res.json({ success: true });
});

// Notifications (Admins & Sub-admins / Staff have full read access to operational alerts)
app.get('/api/admin/notifications', adminMiddleware, (req, res) => {
    const db = loadDB();
    res.json((db.notifications || []).slice().reverse());
});

app.post('/api/admin/notifications', requirePermission('notifications'), (req, res) => {
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

app.delete('/api/admin/notifications/:id', requirePermission('notifications'), (req, res) => {
    const db = loadDB();
    db.notifications = db.notifications.filter(n => n.id !== req.params.id);
    saveDB(db);
    res.json({ success: true });
});

// Referrals (4 Legs Network for Admin)
app.get('/api/admin/referrals', requirePermission('referrals'), (req, res) => {
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

// Clear All Support Tickets to Zero (Super Admin Only)
app.post('/api/admin/tickets/clear-all', adminOnly, (req, res) => {
    try {
        const db = loadDB();
        db.tickets = [];
        saveDB(db);
        io.to('admin_room').emit('ticket:new');
        res.json({ success: true, message: 'All support tickets have been cleared to zero!' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to clear tickets: ' + err.message });
    }
});

// Factory Reset Platform to Zero (Super Admin only)
// Completely wipes ALL user accounts, tickets, rounds, bets, transactions, and OTPs back to initial state.
app.post('/api/admin/system/reset-all', adminOnly, async (req, res) => {
    try {
        const db = loadDB();
        
        // Preserve Master Admin credentials so admin is never locked out
        const existingAdmin = (db.users || []).find(u => u.role === 'admin');
        const adminHash = existingAdmin ? existingAdmin.password : await bcrypt.hash('admin123', 10);
        const adminPlain = (existingAdmin && existingAdmin.plainPassword) ? existingAdmin.plainPassword : 'admin123';
        const adminUser = {
            id: existingAdmin ? existingAdmin.id : 'admin_1',
            username: existingAdmin ? existingAdmin.username : 'admin',
            password: adminHash,
            plainPassword: adminPlain,
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
        };

        // Reset bank & UPI total collected counters to 0 while keeping bank config
        const resetBanks = (db.bankAccounts || []).map(b => ({ ...b, totalCollected: 0 }));
        const resetUpis = (db.upiAccounts || []).map(u => ({ ...u, totalCollected: 0 }));

        const freshDB = {
            schemaVersion: CURRENT_SCHEMA_VERSION,
            users: [adminUser],
            staff: (db.staff || []),
            tickets: [],            // <-- COMPLETELY RESET ALL TICKETS TO ZERO!
            rounds: [],             // <-- COMPLETELY RESET ALL ROUNDS TO ZERO!
            bankAccounts: resetBanks.length > 0 ? resetBanks : [
                { id: 'bank_1', bankName: 'State Bank of India', accountHolder: 'ColorWin Official', accountNumber: '39482019481', ifsc: 'SBIN0001234', active: true, totalCollected: 0, lockedForAll: false },
                { id: 'bank_2', bankName: 'HDFC Bank', accountHolder: 'ColorWin Official', accountNumber: '50100481928314', ifsc: 'HDFC0000543', active: true, totalCollected: 0, lockedForAll: false }
            ],
            upiAccounts: resetUpis.length > 0 ? resetUpis : [
                { id: 'upi_1', upiId: 'colorwin.pay@oksbi', displayName: 'ColorWin Official UPI', active: true, totalCollected: 0, lockedForAll: false },
                { id: 'upi_2', upiId: 'colorwingame@paytm', displayName: 'ColorWin Fast UPI', active: true, totalCollected: 0, lockedForAll: false }
            ],
            depositRequests: [],    // <-- COMPLETELY RESET ALL DEPOSITS TO ZERO!
            withdrawalRequests: [], // <-- COMPLETELY RESET ALL WITHDRAWALS TO ZERO!
            notifications: [],      // <-- COMPLETELY RESET ALL NOTIFICATIONS TO ZERO!
            settings: db.settings || { depositsEnabled: true },
            currentBankIndex: 0
        };

        saveDB(freshDB);

        // Wipe all active OTPs from memory
        for (const k in activePasswordOTPs) {
            delete activePasswordOTPs[k];
        }

        gameState.roundId = 1;
        gameState.phase = 'betting';
        gameState.timeLeft = RULES.ROUND_DURATION;
        gameState.bets = {};
        gameState.bettingOpen = true;
        resultHistory = [];

        io.emit('game:state', getPublicState());
        io.to('admin_room').emit('ticket:new');
        io.to('admin_room').emit('otp:new', null);

        res.json({ success: true, message: 'Platform has been completely reset to zero! All tickets, users, rounds, and transactions have been wiped.' });
    } catch (err) {
        res.status(500).json({ error: 'Reset failed: ' + err.message });
    }
});

// ─── Change Master Admin Password (Super Admin Only) ──────────────────────────
app.post('/api/admin/change-password', adminOnly, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current password and new password are required' });
    if (newPassword.length < 4) return res.status(400).json({ error: 'New password must be at least 4 characters' });

    const db = loadDB();
    const adminUser = db.users.find(u => u.role === 'admin' && (u.id === req.user.id || u.username === req.user.username)) || db.users.find(u => u.role === 'admin');
    if (!adminUser) return res.status(404).json({ error: 'Admin account not found' });

    const valid = await bcrypt.compare(currentPassword, adminUser.password);
    if (!valid) return res.status(400).json({ error: 'Current admin password is incorrect' });

    adminUser.password = await bcrypt.hash(newPassword, 10);
    adminUser.plainPassword = newPassword.trim();
    adminUser.sessionToken = crypto.randomBytes(16).toString('hex');
    saveDB(db);

    console.log(`🔐 [ADMIN PASSWORD CHANGED] Master password for admin updated successfully.`);
    res.json({ success: true, message: 'Admin password updated successfully! Please keep your new password safe.' });
});

// ─── Staff & Sub-Admin RBAC Management (Super Admin Only) ─────────────────────
app.get('/api/admin/staff', adminOnly, (req, res) => {
    const db = loadDB();
    if (!db.staff) db.staff = [];
    res.json(db.staff.map(s => ({
        id: s.id,
        username: s.username,
        name: s.name,
        plainPassword: s.plainPassword || null,
        permissions: s.permissions || [],
        active: s.active !== false,
        createdAt: s.createdAt
    })));
});

app.post('/api/admin/staff/add', adminOnly, async (req, res) => {
    const { username, password, name, permissions } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    const cleanUser = username.trim().toLowerCase();
    const db = loadDB();
    if (!db.staff) db.staff = [];

    if (db.users.find(u => u.username.toLowerCase() === cleanUser) || db.staff.find(s => s.username.toLowerCase() === cleanUser)) {
        return res.status(400).json({ error: 'Username already taken. Please choose another username.' });
    }

    const hashed = await bcrypt.hash(password, 10);
    const staffMember = {
        id: 'staff_' + Date.now(),
        username: cleanUser,
        name: (name || cleanUser).trim(),
        password: hashed,
        plainPassword: password.trim(),
        role: 'staff',
        permissions: Array.isArray(permissions) ? permissions : [],
        active: true,
        createdAt: new Date().toISOString()
    };
    db.staff.push(staffMember);
    saveDB(db);
    res.json({ success: true, staff: staffMember });
});

app.post('/api/admin/staff/:id/toggle', adminOnly, (req, res) => {
    const db = loadDB();
    if (!db.staff) db.staff = [];
    const staff = db.staff.find(s => s.id === req.params.id);
    if (!staff) return res.status(404).json({ error: 'Staff account not found' });
    staff.active = staff.active === false ? true : false;
    saveDB(db);
    res.json({ success: true, active: staff.active });
});

app.post('/api/admin/staff/:id/password', adminOnly, async (req, res) => {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
    const db = loadDB();
    if (!db.staff) db.staff = [];
    const staff = db.staff.find(s => s.id === req.params.id);
    if (!staff) return res.status(404).json({ error: 'Staff account not found' });
    staff.password = await bcrypt.hash(newPassword, 10);
    staff.plainPassword = newPassword.trim();
    saveDB(db);
    res.json({ success: true, message: `Password for @${staff.username} updated!`, plainPassword: newPassword.trim() });
});

app.delete('/api/admin/staff/:id', adminOnly, (req, res) => {
    const db = loadDB();
    if (!db.staff) db.staff = [];
    db.staff = db.staff.filter(s => s.id !== req.params.id);
    saveDB(db);
    res.json({ success: true });
});

app.get('/api/admin/withdrawal-eligibility', requirePermission('eligibility'), (req, res) => {
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

app.post('/api/admin/adjust-balance', requirePermission('users'), (req, res) => {
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
app.get('/api/admin/deposits', requirePermission('deposits'), (req, res) => {
    const db = loadDB();
    res.json(db.depositRequests.slice().reverse());
});

app.post('/api/admin/deposits/:id/approve', requirePermission('deposits'), (req, res) => {
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

app.post('/api/admin/deposits/:id/reject', requirePermission('deposits'), (req, res) => {
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

// Withdrawals Management (Full Bank & UPI Details for Manual Payouts)
app.get('/api/admin/withdrawals', requirePermission('withdrawals'), (req, res) => {
    const db = loadDB();
    const enriched = (db.withdrawalRequests || []).slice().reverse().map(w => {
        const user = db.users.find(u => u.id === w.userId);
        return {
            ...w,
            userPhone: (user && user.phone) || null,
            latestBankAccount: (user && user.bankAccount) || w.bankAccount || null,
            latestUpiId: (user && user.upiId) || w.upiId || null
        };
    });
    res.json(enriched);
});

app.post('/api/admin/withdrawals/:id/approve', requirePermission('withdrawals'), (req, res) => {
    const db = loadDB();
    const wd = db.withdrawalRequests.find(r => r.id === req.params.id);
    if (!wd || wd.status !== 'pending') return res.status(400).json({ error: 'Invalid' });
    wd.status = 'approved';
    saveDB(db);
    io.to(`user_${wd.userId}`).emit('withdrawal:approved', { amount: wd.amount, netAmount: wd.netAmount });
    res.json({ success: true });
});

app.post('/api/admin/withdrawals/:id/reject', requirePermission('withdrawals'), (req, res) => {
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

// Banks & UPI Accounts Management with Ledger Tracking & Live Lock State
app.get('/api/admin/banks', requirePermission('banks'), (req, res) => {
    const db = loadDB();
    cleanExpiredBankLocks();
    const now = Date.now();

    // Calculate total volume received per bank and UPI
    const bankStats = {};
    (db.depositRequests || []).forEach(d => {
        if (d.status === 'approved') {
            const name = d.targetAccountName || 'Unknown';
            bankStats[name] = (bankStats[name] || 0) + d.amount;
        }
    });

    const enrichedBanks = (db.bankAccounts || []).map(b => {
        const lock = activeBankLocks[b.id];
        return {
            ...b,
            currentLock: (lock && lock.expiresAt > now) ? {
                username: lock.username,
                amount: lock.amount,
                remainingSeconds: Math.max(0, Math.round((lock.expiresAt - now) / 1000))
            } : null
        };
    });

    res.json({
        banks: enrichedBanks,
        upis: db.upiAccounts || [],
        settings: db.settings || { depositsEnabled: true },
        ledgerStats: bankStats
    });
});

app.post('/api/admin/banks/:id/unlock', requirePermission('banks'), (req, res) => {
    delete activeBankLocks[req.params.id];
    io.emit('bank:lock_status', { bankId: req.params.id, isAvailable: true });
    res.json({ success: true, message: 'Bank lock released.' });
});

app.post('/api/admin/banks', requirePermission('banks'), (req, res) => {
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

app.post('/api/admin/banks/:id/toggle', requirePermission('banks'), (req, res) => {
    const db = loadDB();
    const bank = db.bankAccounts.find(b => b.id === req.params.id);
    if (!bank) return res.status(404).json({ error: 'Not found' });
    bank.active = !bank.active;
    saveDB(db);
    res.json({ success: true, active: bank.active });
});

app.post('/api/admin/banks/:id/toggle-lock', requirePermission('banks'), (req, res) => {
    const db = loadDB();
    const bank = db.bankAccounts.find(b => b.id === req.params.id);
    if (!bank) return res.status(404).json({ error: 'Not found' });
    bank.lockedForAll = !bank.lockedForAll;
    saveDB(db);
    res.json({ success: true, lockedForAll: bank.lockedForAll });
});

app.delete('/api/admin/banks/:id', requirePermission('banks'), (req, res) => {
    const db = loadDB();
    db.bankAccounts = db.bankAccounts.filter(b => b.id !== req.params.id);
    saveDB(db);
    res.json({ success: true });
});

app.post('/api/admin/upi', requirePermission('banks'), (req, res) => {
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

app.post('/api/admin/upi/:id/toggle', requirePermission('banks'), (req, res) => {
    const db = loadDB();
    const upi = (db.upiAccounts || []).find(u => u.id === req.params.id);
    if (!upi) return res.status(404).json({ error: 'Not found' });
    upi.active = !upi.active;
    saveDB(db);
    res.json({ success: true });
});

app.post('/api/admin/upi/:id/toggle-lock', requirePermission('banks'), (req, res) => {
    const db = loadDB();
    const upi = (db.upiAccounts || []).find(u => u.id === req.params.id);
    if (!upi) return res.status(404).json({ error: 'Not found' });
    upi.lockedForAll = !upi.lockedForAll;
    saveDB(db);
    res.json({ success: true, lockedForAll: upi.lockedForAll });
});

app.delete('/api/admin/upi/:id', requirePermission('banks'), (req, res) => {
    const db = loadDB();
    db.upiAccounts = (db.upiAccounts || []).filter(u => u.id !== req.params.id);
    saveDB(db);
    res.json({ success: true });
});

app.post('/api/admin/toggle-deposits', requirePermission('banks'), (req, res) => {
    const db = loadDB();
    if (!db.settings) db.settings = { depositsEnabled: true };
    db.settings.depositsEnabled = !db.settings.depositsEnabled;
    saveDB(db);
    res.json({ success: true, depositsEnabled: db.settings.depositsEnabled });
});

app.get('/api/admin/rounds', requirePermission('history'), (req, res) => {
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
            if (user.role === 'admin' || user.role === 'staff') socket.join('admin_room');
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

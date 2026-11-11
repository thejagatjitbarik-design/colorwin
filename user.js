/* ═══ ColorWin User JS ═══ */
const API = '';
let token = localStorage.getItem('cw_token');
let socket = null;
let currentUser = null;
let selectedColor = null;
let isRegister = false;
let notifCount = 0;

// ─── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    // Check referral code in URL
    const params = new URLSearchParams(window.location.search);
    const refCode = params.get('ref');
    if (refCode) {
        document.getElementById('auth-referral').value = refCode;
    }

    // Auth toggle
    document.getElementById('toggle-auth').addEventListener('click', (e) => {
        e.preventDefault();
        isRegister = !isRegister;
        document.getElementById('auth-btn').textContent = isRegister ? 'Register' : 'Login';
        document.getElementById('referral-field').classList.toggle('hidden', !isRegister);
        document.getElementById('toggle-auth').textContent = isRegister ? 'Login' : 'Register';
        document.querySelector('.auth-toggle').firstChild.textContent = isRegister ? 'Already have an account? ' : "Don't have an account? ";
    });

    // Auth form
    document.getElementById('auth-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('auth-username').value.trim();
        const password = document.getElementById('auth-password').value;
        const referralCode = document.getElementById('auth-referral').value.trim();
        const errEl = document.getElementById('auth-error');
        errEl.classList.add('hidden');

        try {
            const endpoint = isRegister ? '/api/register' : '/api/login';
            const body = isRegister ? { username, password, referralCode } : { username, password };
            const res = await fetch(API + endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const data = await res.json();
            if (!res.ok) {
                if (data.suspended) {
                    document.getElementById('auth-overlay').classList.add('hidden');
                    document.getElementById('suspended-overlay').classList.remove('hidden');
                    return;
                }
                throw new Error(data.error || 'Failed');
            }
            token = data.token;
            localStorage.setItem('cw_token', token);
            currentUser = data.user;
            document.getElementById('auth-overlay').classList.add('hidden');
            initApp();
        } catch (err) {
            errEl.textContent = err.message;
            errEl.classList.remove('hidden');
        }
    });

    if (token) {
        document.getElementById('auth-overlay').classList.add('hidden');
        initApp();
    }
});

// ─── App Init ──────────────────────────────────────────────────────────────────
async function initApp() {
    await loadProfile();
    connectSocket();
    loadNotifications();
    loadDepositBank();
    loadHistory();
    loadReferrals();
}

function authHeaders() {
    return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
}

// ─── Profile ───────────────────────────────────────────────────────────────────
async function loadProfile() {
    try {
        const res = await fetch(API + '/api/me', { headers: authHeaders() });
        if (res.status === 403) {
            const d = await res.json();
            if (d.suspended) {
                document.getElementById('suspended-overlay').classList.remove('hidden');
                return;
            }
        }
        if (!res.ok) { logout(); return; }
        currentUser = await res.json();
        updateUI();
    } catch { logout(); }
}

function updateUI() {
    if (!currentUser) return;
    document.getElementById('balance-amount').textContent = Math.floor(currentUser.balance);
    document.getElementById('profile-username').textContent = currentUser.username;
    document.getElementById('profile-avatar').textContent = currentUser.username.charAt(0).toUpperCase();
    document.getElementById('p-bets').textContent = currentUser.totalBetsPlaced || 0;
    document.getElementById('p-won').textContent = '₹' + (currentUser.totalWon || 0);
    document.getElementById('p-deposited').textContent = '₹' + (currentUser.totalDeposited || 0);
    document.getElementById('ref-code').textContent = currentUser.referralCode || '---';
    document.getElementById('ref-link').value = `${window.location.origin}/?ref=${currentUser.referralCode || ''}`;

    // Bank/UPI display
    if (currentUser.bankAccount) {
        document.getElementById('saved-bank').classList.remove('hidden');
        document.getElementById('bank-form-section').classList.add('hidden');
        const ba = currentUser.bankAccount;
        document.getElementById('saved-bank-details').innerHTML = `
            <div class="saved-detail"><span>Name</span><span>${ba.accountName || '-'}</span></div>
            <div class="saved-detail"><span>Account</span><span>${ba.accountNumber || '-'}</span></div>
            <div class="saved-detail"><span>IFSC</span><span>${ba.ifscCode || '-'}</span></div>
        `;
    } else {
        document.getElementById('saved-bank').classList.add('hidden');
        document.getElementById('bank-form-section').classList.remove('hidden');
    }

    if (currentUser.upiId) {
        document.getElementById('saved-upi').classList.remove('hidden');
        document.getElementById('upi-form-section').classList.add('hidden');
        document.getElementById('saved-upi-details').innerHTML = `
            <div class="saved-detail"><span>UPI ID</span><span>${currentUser.upiId}</span></div>
        `;
    } else {
        document.getElementById('saved-upi').classList.add('hidden');
        document.getElementById('upi-form-section').classList.remove('hidden');
    }

    // Eligibility
    if (currentUser.withdrawalEligibility) {
        const elig = currentUser.withdrawalEligibility;
        const list = document.getElementById('eligibility-list');
        list.innerHTML = '';
        const checks = [
            { label: `Balance >= ₹300`, ok: elig.balance >= 300 },
            { label: `Deposits >= ₹200 (₹${elig.totalDeposited})`, ok: elig.totalDeposited >= 200 },
            { label: `3+ active referrals (${elig.activeReferrals})`, ok: elig.activeReferrals >= 3 }
        ];
        checks.forEach(c => {
            list.innerHTML += `<div class="elig-item"><span class="elig-icon">${c.ok ? '✅' : '❌'}</span><span>${c.label}</span></div>`;
        });
        document.getElementById('withdraw-btn').disabled = !elig.eligible;
    }
}

// ─── Socket ────────────────────────────────────────────────────────────────────
function connectSocket() {
    socket = io();
    socket.emit('join', { token });

    socket.on('game:state', (state) => {
        updateGameState(state);
    });

    socket.on('round:new', (data) => {
        selectedColor = null;
        document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('selected'));
        hideBetStatus();
    });

    socket.on('timer:tick', (data) => {
        updateTimer(data.timeLeft);
    });

    socket.on('timer:expired', () => {
        document.getElementById('timer-phase').textContent = 'Betting Closed';
        document.getElementById('timer-display').textContent = '00:00';
        setBettingEnabled(false);
    });

    socket.on('bet:placed', (data) => {
        currentUser.balance = data.newBalance;
        document.getElementById('balance-amount').textContent = Math.floor(data.newBalance);
        showBetStatus(`Bet placed: ${data.color.toUpperCase()} for ₹${data.amount}`, 'success');
    });

    socket.on('bet:result', (data) => {
        currentUser.balance = data.newBalance;
        document.getElementById('balance-amount').textContent = Math.floor(data.newBalance);
        showResultPopup(data);
    });

    socket.on('round:result', (data) => {
        addResultDot(data.result);
    });

    socket.on('deposit:approved', (data) => {
        currentUser.balance = data.newBalance;
        document.getElementById('balance-amount').textContent = Math.floor(data.newBalance);
        showMsg('deposit-msg', `Deposit of ₹${data.amount} approved!`, 'success');
    });

    socket.on('withdrawal:approved', (data) => {
        showMsg('withdraw-msg', `Withdrawal of ₹${data.netAmount} approved!`, 'success');
    });

    socket.on('notification:new', (notif) => {
        notifCount++;
        updateNotifBadge();
        addNotifToList(notif);
    });
}

// ─── Game State ────────────────────────────────────────────────────────────────
function updateGameState(state) {
    updateTimer(state.timeLeft);
    const phase = document.getElementById('timer-phase');
    if (state.phase === 'betting' && state.bettingOpen) {
        phase.textContent = '🟢 Betting Open';
        setBettingEnabled(true);
    } else if (state.phase === 'betting' && !state.bettingOpen) {
        phase.textContent = '🔒 Bets Locked';
        setBettingEnabled(false);
    } else if (state.phase === 'closed') {
        phase.textContent = '⏳ Waiting for Result';
        setBettingEnabled(false);
    } else if (state.phase === 'result') {
        phase.textContent = `Result: ${(state.result || '').toUpperCase()}`;
        setBettingEnabled(false);
    } else {
        phase.textContent = 'Waiting...';
        setBettingEnabled(false);
    }

    if (state.roundId) {
        document.getElementById('timer-round').textContent = `Round #${String(state.roundId).slice(-6)}`;
    }
}

function updateTimer(timeLeft) {
    const mins = Math.floor(Math.max(0, timeLeft) / 60);
    const secs = Math.max(0, timeLeft) % 60;
    document.getElementById('timer-display').textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

    // Update circle progress
    const pct = (timeLeft / 120) * 100;
    document.getElementById('timer-circle').style.setProperty('--progress', `${pct}%`);
}

function setBettingEnabled(enabled) {
    document.querySelectorAll('.color-btn').forEach(b => b.disabled = !enabled);
    document.getElementById('place-bet-btn').disabled = !enabled;
}

// ─── Betting ───────────────────────────────────────────────────────────────────
function selectColor(color) {
    selectedColor = color;
    document.querySelectorAll('.color-btn').forEach(b => {
        b.classList.toggle('selected', b.dataset.color === color);
    });
}

function setAmount(val) {
    document.getElementById('bet-amount').value = val;
    document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    event.target.classList.add('active');
}

async function placeBet() {
    if (!selectedColor) return showBetStatus('Select a color first!', 'error');
    const amount = parseInt(document.getElementById('bet-amount').value);
    if (!amount || amount < 10) return showBetStatus('Minimum bet is ₹10', 'error');

    try {
        const res = await fetch(API + '/api/bet', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ color: selectedColor, amount })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
    } catch (err) {
        showBetStatus(err.message, 'error');
    }
}

function showBetStatus(msg, type) {
    const el = document.getElementById('bet-status');
    el.textContent = msg;
    el.className = `bet-status ${type}`;
    el.classList.remove('hidden');
    if (type === 'success') setTimeout(() => el.classList.add('hidden'), 3000);
}

function hideBetStatus() {
    document.getElementById('bet-status').classList.add('hidden');
}

// ─── Result Popup ──────────────────────────────────────────────────────────────
function showResultPopup(data) {
    const popup = document.getElementById('result-popup');
    document.getElementById('result-icon').textContent = data.won ? '🎉' : '😔';
    document.getElementById('result-text').textContent = data.won ? 'You Won!' : 'You Lost';
    const amtEl = document.getElementById('result-amount');
    amtEl.textContent = data.won ? `+₹${data.payout}` : `Result: ${data.color.toUpperCase()}`;
    amtEl.className = `result-amount ${data.won ? 'win' : 'lose'}`;
    popup.classList.remove('hidden');
    setTimeout(() => popup.classList.add('hidden'), 4000);
}

function addResultDot(color) {
    const strip = document.getElementById('results-strip');
    const dot = document.createElement('div');
    dot.className = `strip-dot ${color}`;
    dot.textContent = color.charAt(0).toUpperCase();
    strip.prepend(dot);
    if (strip.children.length > 10) strip.lastChild.remove();
}

// ─── Navigation ────────────────────────────────────────────────────────────────
function showPage(name) {
    document.querySelectorAll('.page').forEach(p => { p.classList.remove('active'); p.classList.add('hidden'); });
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`page-${name}`).classList.remove('hidden');
    document.getElementById(`page-${name}`).classList.add('active');
    document.querySelector(`.nav-btn[data-page="${name}"]`).classList.add('active');

    if (name === 'wallet') { loadProfile(); loadDepositBank(); }
    if (name === 'history') loadHistory();
    if (name === 'profile') { loadProfile(); loadReferrals(); }
}

function showWalletTab(tab) {
    document.querySelectorAll('.wallet-panel').forEach(p => p.classList.add('hidden'));
    document.querySelectorAll('.w-tab').forEach(t => t.classList.remove('active'));
    document.getElementById(`wallet-${tab}`).classList.remove('hidden');
    event.target.classList.add('active');
}

// ─── Deposit ───────────────────────────────────────────────────────────────────
async function loadDepositBank() {
    try {
        const res = await fetch(API + '/api/deposit-bank', { headers: authHeaders() });
        const data = await res.json();
        const el = document.getElementById('deposit-bank-info');
        let html = '';

        if (data.bank) {
            html += `<h4>🏦 Bank Transfer</h4>`;
            html += `<div class="bank-detail"><span class="label">Name</span><span>${data.bank.name || '-'}</span></div>`;
            html += `<div class="bank-detail"><span class="label">Account</span><span>${data.bank.accountNumber || '-'}</span></div>`;
            html += `<div class="bank-detail"><span class="label">IFSC</span><span>${data.bank.ifscCode || '-'}</span></div>`;
            if (data.bank.upiId) html += `<div class="bank-detail"><span class="label">UPI</span><span>${data.bank.upiId}</span></div>`;
        }

        if (data.upis && data.upis.length > 0) {
            html += `<div class="upi-list"><h4>📲 UPI Payment</h4>`;
            data.upis.forEach(u => {
                html += `<div class="upi-item"><div><div style="font-size:0.75rem;color:var(--text-dim)">${u.name}</div><div class="upi-val">${u.upiId}</div></div></div>`;
            });
            html += `</div>`;
        }

        if (!data.bank && (!data.upis || data.upis.length === 0)) {
            html = '<p class="loading-text">No payment details available. Contact support.</p>';
        }
        el.innerHTML = html;
    } catch {
        document.getElementById('deposit-bank-info').innerHTML = '<p class="loading-text">Failed to load payment details</p>';
    }
}

async function submitDeposit() {
    const amount = parseInt(document.getElementById('deposit-amount').value);
    const transactionId = document.getElementById('deposit-txn').value.trim();
    if (!amount || amount < 100) return showMsg('deposit-msg', 'Minimum deposit ₹100', 'error');
    if (!transactionId) return showMsg('deposit-msg', 'Enter transaction ID', 'error');

    try {
        const res = await fetch(API + '/api/deposit', {
            method: 'POST', headers: authHeaders(),
            body: JSON.stringify({ amount, transactionId })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        let msg = 'Deposit submitted! Processing within 6 hours.';
        if (data.isDuplicate) msg += ' ⚠️ Duplicate transaction ID detected.';
        showMsg('deposit-msg', msg, 'success');
        document.getElementById('deposit-amount').value = '';
        document.getElementById('deposit-txn').value = '';
    } catch (err) { showMsg('deposit-msg', err.message, 'error'); }
}

// ─── Withdraw ──────────────────────────────────────────────────────────────────
function updateFeePreview() {
    const amount = parseInt(document.getElementById('withdraw-amount').value) || 0;
    const preview = document.getElementById('fee-preview');
    if (amount >= 300) {
        const fee = Math.ceil(amount * 0.005);
        const net = amount - fee;
        document.getElementById('fee-amount').textContent = `₹${fee}`;
        document.getElementById('net-amount').textContent = `₹${net}`;
        preview.classList.remove('hidden');
    } else {
        preview.classList.add('hidden');
    }
}

async function submitWithdraw() {
    const amount = parseInt(document.getElementById('withdraw-amount').value);
    if (!amount || amount < 300) return showMsg('withdraw-msg', 'Minimum withdrawal ₹300', 'error');

    try {
        const res = await fetch(API + '/api/withdraw', {
            method: 'POST', headers: authHeaders(),
            body: JSON.stringify({ amount })
        });
        const data = await res.json();
        if (!res.ok) {
            let msg = data.error;
            if (data.reasons) msg += ': ' + data.reasons.join(', ');
            throw new Error(msg);
        }
        showMsg('withdraw-msg', `Withdrawal submitted! Fee: ₹${data.fee}, You'll receive: ₹${data.netAmount}`, 'success');
        document.getElementById('withdraw-amount').value = '';
        document.getElementById('fee-preview').classList.add('hidden');
        loadProfile();
    } catch (err) { showMsg('withdraw-msg', err.message, 'error'); }
}

// ─── Bank/UPI ──────────────────────────────────────────────────────────────────
async function saveBank() {
    const accountName = document.getElementById('bank-name').value.trim();
    const accountNumber = document.getElementById('bank-number').value.trim();
    const ifscCode = document.getElementById('bank-ifsc').value.trim();
    if (!accountName || !accountNumber || !ifscCode) return showMsg('bank-msg', 'Fill all bank fields', 'error');

    try {
        const res = await fetch(API + '/api/bank-account', {
            method: 'POST', headers: authHeaders(),
            body: JSON.stringify({ accountName, accountNumber, ifscCode })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        showMsg('bank-msg', 'Bank account saved!', 'success');
        loadProfile();
    } catch (err) { showMsg('bank-msg', err.message, 'error'); }
}

async function removeBank() {
    if (!confirm('Remove your saved bank account?')) return;
    try {
        const res = await fetch(API + '/api/bank-account', { method: 'DELETE', headers: authHeaders() });
        if (!res.ok) throw new Error('Failed');
        showMsg('bank-msg', 'Bank account removed', 'success');
        loadProfile();
    } catch (err) { showMsg('bank-msg', err.message, 'error'); }
}

async function saveUpi() {
    const upiId = document.getElementById('upi-id-input').value.trim();
    if (!upiId) return showMsg('bank-msg', 'Enter UPI ID', 'error');

    try {
        const res = await fetch(API + '/api/upi', {
            method: 'POST', headers: authHeaders(),
            body: JSON.stringify({ upiId })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        showMsg('bank-msg', 'UPI ID saved!', 'success');
        loadProfile();
    } catch (err) { showMsg('bank-msg', err.message, 'error'); }
}

async function removeUpi() {
    if (!confirm('Remove your saved UPI ID?')) return;
    try {
        const res = await fetch(API + '/api/upi', { method: 'DELETE', headers: authHeaders() });
        if (!res.ok) throw new Error('Failed');
        showMsg('bank-msg', 'UPI ID removed', 'success');
        loadProfile();
    } catch (err) { showMsg('bank-msg', err.message, 'error'); }
}

// ─── History ───────────────────────────────────────────────────────────────────
async function loadHistory() {
    try {
        const res = await fetch(API + '/api/history', { headers: authHeaders() });
        const rounds = await res.json();
        const list = document.getElementById('history-list');
        const strip = document.getElementById('results-strip');

        if (!rounds.length) { list.innerHTML = '<div class="empty-state">No history yet</div>'; return; }

        strip.innerHTML = '';
        list.innerHTML = '';

        rounds.forEach(round => {
            // Strip dots
            addResultDot(round.result);

            // Find user's bet
            const myBet = (round.bets || []).find(b => b.userId === currentUser?.id);
            if (myBet) {
                const html = `
                    <div class="history-item">
                        <div class="h-color ${round.result}">${round.result.charAt(0).toUpperCase()}</div>
                        <div class="h-info">
                            <div class="h-result">${myBet.color.toUpperCase()} → ${round.result.toUpperCase()}</div>
                            <div class="h-date">${new Date(round.timestamp).toLocaleString()}</div>
                        </div>
                        <div class="h-amount ${myBet.won ? 'win' : 'lose'}">${myBet.won ? `+₹${myBet.payout}` : `-₹${myBet.amount}`}</div>
                    </div>
                `;
                list.innerHTML += html;
            }
        });

        if (!list.innerHTML) list.innerHTML = '<div class="empty-state">No bets placed yet</div>';
    } catch {}
}

// ─── Referrals ─────────────────────────────────────────────────────────────────
async function loadReferrals() {
    try {
        const res = await fetch(API + '/api/my-referrals', { headers: authHeaders() });
        const data = await res.json();
        document.getElementById('ref-total').textContent = data.totalCount;
        document.getElementById('ref-active').textContent = data.activeCount;
        const list = document.getElementById('ref-list');
        if (data.referrals.length === 0) {
            list.innerHTML = '<div class="empty-state" style="padding:10px">No referrals yet. Share your code!</div>';
        } else {
            list.innerHTML = data.referrals.map(r => `
                <div class="ref-item">
                    <span>${r.username}</span>
                    <span class="${r.active ? 'ref-active' : 'ref-inactive'}">${r.active ? '✅ Active' : '❌ Inactive'} (${r.betsPlaced} bets)</span>
                </div>
            `).join('');
        }
    } catch {}
}

// ─── Notifications ─────────────────────────────────────────────────────────────
async function loadNotifications() {
    try {
        const res = await fetch(API + '/api/notifications', { headers: authHeaders() });
        const notifs = await res.json();
        const list = document.getElementById('notif-list');
        if (notifs.length === 0) {
            list.innerHTML = '<div class="empty-state">No notifications yet</div>';
        } else {
            list.innerHTML = notifs.map(n => notifHTML(n)).join('');
        }
    } catch {}
}

function addNotifToList(notif) {
    const list = document.getElementById('notif-list');
    if (list.querySelector('.empty-state')) list.innerHTML = '';
    list.insertAdjacentHTML('afterbegin', notifHTML(notif));
}

function notifHTML(n) {
    return `<div class="notif-item">
        <div class="notif-title">${n.title}</div>
        <div class="notif-msg">${n.message}</div>
        <div class="notif-time">${new Date(n.createdAt).toLocaleString()}</div>
    </div>`;
}

function toggleNotifModal() {
    const modal = document.getElementById('notif-modal');
    modal.classList.toggle('hidden');
    if (!modal.classList.contains('hidden')) {
        notifCount = 0;
        updateNotifBadge();
    }
}

function updateNotifBadge() {
    const badge = document.getElementById('notif-badge');
    if (notifCount > 0) {
        badge.textContent = notifCount > 9 ? '9+' : notifCount;
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }
}

// ─── Utilities ─────────────────────────────────────────────────────────────────
function showMsg(id, msg, type) {
    const el = document.getElementById(id);
    el.textContent = msg;
    el.className = `msg ${type}`;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 5000);
}

function copyReferral() {
    navigator.clipboard.writeText(currentUser?.referralCode || '');
    alert('Referral code copied!');
}

function copyRefLink() {
    const link = document.getElementById('ref-link').value;
    navigator.clipboard.writeText(link);
    alert('Referral link copied!');
}

function logout() {
    localStorage.removeItem('cw_token');
    token = null;
    currentUser = null;
    if (socket) socket.disconnect();
    location.reload();
}

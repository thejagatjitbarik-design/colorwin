/* ═══ ColorWin User JS ═══ */
const API = '';
let token = localStorage.getItem('cw_token');
let socket = null;
let currentUser = null;
let selectedColor = null;
let isRegister = false;
let notifCount = 0;
let currentScreenshotBase64 = null;
let currentAssignedAccountName = 'Main Deposit Gateway';

// ─── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    // Check referral code in URL
    const params = new URLSearchParams(window.location.search);
    const refCode = params.get('ref');
    if (refCode) {
        const refInput = document.getElementById('auth-referral');
        if (refInput) refInput.value = refCode;
    }

    // Auth toggle
    const toggleAuth = document.getElementById('toggle-auth');
    if (toggleAuth) {
        toggleAuth.addEventListener('click', (e) => {
            e.preventDefault();
            isRegister = !isRegister;
            document.getElementById('auth-btn').textContent = isRegister ? 'Register & Accept Terms' : 'Login';
            document.getElementById('register-extras').classList.toggle('hidden', !isRegister);
            document.getElementById('forgot-link-box').classList.toggle('hidden', isRegister);
            toggleAuth.textContent = isRegister ? 'Login' : 'Register';
            document.querySelector('.auth-toggle').firstChild.textContent = isRegister ? 'Already have an account? ' : "Don't have an account? ";
        });
    }

    // Terms & Conditions link
    const tcLink = document.getElementById('open-tc-link');
    if (tcLink) {
        tcLink.addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('tc-modal').classList.remove('hidden');
        });
    }

    // Forgot password link
    const forgotLink = document.getElementById('open-forgot-link');
    if (forgotLink) {
        forgotLink.addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('forgot-modal').classList.remove('hidden');
        });
    }

    // Auth form submit
    const authForm = document.getElementById('auth-form');
    if (authForm) {
        authForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const username = document.getElementById('auth-username').value.trim();
            const password = document.getElementById('auth-password').value;
            const errEl = document.getElementById('auth-error');
            errEl.classList.add('hidden');

            if (isRegister) {
                const tcCheckbox = document.getElementById('auth-tc');
                if (!tcCheckbox || !tcCheckbox.checked) {
                    errEl.textContent = 'Please accept the Terms & Conditions before registering.';
                    errEl.classList.remove('hidden');
                    return;
                }
            }

            const phone = document.getElementById('auth-phone')?.value.trim() || '';
            const referralCode = document.getElementById('auth-referral')?.value.trim() || '';

            try {
                const endpoint = isRegister ? '/api/register' : '/api/login';
                const body = isRegister ? { username, password, referralCode, phone } : { username, password };
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
                    throw new Error(data.error || 'Authentication failed');
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
    }

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
        if (res.status === 401) {
            const d = await res.json();
            if (d.sessionReplaced) {
                showSessionReplaced();
                return;
            }
            logout(); return;
        }
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

    const phoneEl = document.getElementById('profile-phone');
    if (phoneEl) phoneEl.textContent = currentUser.phone ? `Phone: ${currentUser.phone}` : 'Phone: Not set';

    document.getElementById('p-bets').textContent = currentUser.totalBetsPlaced || 0;
    document.getElementById('p-won').textContent = '₹' + (currentUser.totalWon || 0);

    const commEl = document.getElementById('p-commission');
    if (commEl) commEl.textContent = '₹' + (currentUser.totalCommissionEarned || 0);

    document.getElementById('ref-code').textContent = currentUser.referralCode || '---';
    document.getElementById('ref-link').value = `${window.location.origin}/?ref=${currentUser.referralCode || ''}`;

    // Saved Bank / UPI Details
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

    // Withdrawal Eligibility
    if (currentUser.withdrawalEligibility) {
        const elig = currentUser.withdrawalEligibility;
        const list = document.getElementById('eligibility-list');
        list.innerHTML = '';

        if (elig.isVip) {
            list.innerHTML = `<div class="elig-item"><span class="elig-icon">⭐</span><span style="color:var(--gold);font-weight:700">VIP Fast Pass Active (Restrictions Bypassed!)</span></div>`;
        } else {
            const checks = [
                { label: `Balance ≥ ₹300`, ok: elig.balance >= 300 },
                { label: `Deposits ≥ ₹200 (₹${elig.totalDeposited})`, ok: elig.totalDeposited >= 200 },
                { label: `3+ active referrals (${elig.activeReferrals})`, ok: elig.activeReferrals >= 3 }
            ];
            checks.forEach(c => {
                list.innerHTML += `<div class="elig-item"><span class="elig-icon">${c.ok ? '✅' : '❌'}</span><span>${c.label}</span></div>`;
            });
        }
        document.getElementById('withdraw-btn').disabled = !elig.eligible;
    }
}

// ─── Socket ────────────────────────────────────────────────────────────────────
function connectSocket() {
    socket = io();
    socket.emit('join', { token });

    socket.on('game:state', (state) => updateGameState(state));

    socket.on('round:new', () => {
        selectedColor = null;
        document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('selected'));
        hideBetStatus();
    });

    socket.on('timer:tick', (data) => updateTimer(data.timeLeft));

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

    socket.on('commission:earned', (data) => {
        currentUser.balance = data.newBalance;
        currentUser.totalCommissionEarned = (currentUser.totalCommissionEarned || 0) + data.commission;
        document.getElementById('balance-amount').textContent = Math.floor(data.newBalance);
        const commEl = document.getElementById('p-commission');
        if (commEl) commEl.textContent = '₹' + currentUser.totalCommissionEarned.toFixed(2);
    });

    socket.on('round:result', (data) => addResultDot(data.result));

    socket.on('deposit:approved', (data) => {
        currentUser.balance = data.newBalance;
        document.getElementById('balance-amount').textContent = Math.floor(data.newBalance);
        showMsg('deposit-msg', `Deposit of ₹${data.amount} approved!`, 'success');
    });

    socket.on('withdrawal:approved', (data) => {
        showMsg('withdraw-msg', `Withdrawal of ₹${data.netAmount} approved!`, 'success');
    });

    socket.on('notification:new', (notif) => {
        if (!notif.targetUserId || (currentUser && notif.targetUserId === currentUser.id)) {
            notifCount++;
            updateNotifBadge();
            addNotifToList(notif);
        }
    });

    socket.on('session:replaced', () => showSessionReplaced());
}

function showSessionReplaced() {
    localStorage.removeItem('cw_token');
    token = null;
    if (socket) socket.disconnect();
    document.getElementById('session-overlay').classList.remove('hidden');
}

// ─── Game State & Maintenance UI ──────────────────────────────────────────────
function updateGameState(state) {
    updateTimer(state.timeLeft);
    const phase = document.getElementById('timer-phase');
    const maintenanceBanner = document.getElementById('maintenance-banner');
    const betSection = document.getElementById('bet-section');

    if (state.maintenanceMode) {
        if (maintenanceBanner) maintenanceBanner.classList.remove('hidden');
        if (betSection) betSection.style.display = 'none';
        phase.textContent = '🛠️ Maintenance';
        setBettingEnabled(false);
        return;
    } else {
        if (maintenanceBanner) maintenanceBanner.classList.add('hidden');
        if (betSection) betSection.style.display = 'block';
    }

    if (state.phase === 'betting' && state.bettingOpen) {
        phase.textContent = '🟢 Betting Open';
        setBettingEnabled(true);
    } else if (state.phase === 'betting' && !state.bettingOpen) {
        phase.textContent = '🔒 Bets Locked';
        setBettingEnabled(false);
    } else if (state.phase === 'closed') {
        phase.textContent = '⏳ Result Calculating...';
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
    const pct = (timeLeft / 120) * 100;
    document.getElementById('timer-circle').style.setProperty('--progress', `${pct}%`);
}

function setBettingEnabled(enabled) {
    document.querySelectorAll('.color-btn').forEach(b => b.disabled = !enabled);
    const btn = document.getElementById('place-bet-btn');
    if (btn) btn.disabled = !enabled;
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

// ─── Deposit Flow & Mandatory Screenshot ───────────────────────────────────────
function setDepositAmount(val) {
    document.getElementById('deposit-amount').value = val;
}

function previewScreenshot(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function(e) {
        currentScreenshotBase64 = e.target.result;
        const img = document.getElementById('screenshot-preview-img');
        img.src = currentScreenshotBase64;
        document.getElementById('screenshot-preview-container').classList.remove('hidden');
    };
    reader.readAsDataURL(file);
}

async function loadDepositBank() {
    try {
        const res = await fetch(API + '/api/deposit-bank', { headers: authHeaders() });
        const data = await res.json();
        const el = document.getElementById('deposit-bank-info');

        if (data.depositsPaused) {
            el.innerHTML = '<div style="color:var(--gold);font-size:0.85rem">⚠️ Deposits are temporarily paused for bank reconciliation. Please check back shortly.</div>';
            return;
        }

        let html = '';
        if (data.bank) {
            currentAssignedAccountName = data.bank.name || 'Bank Account';
            html += `<h4>🏦 Assigned Bank Account (Session Active)</h4>`;
            html += `<div class="bank-detail"><span class="label">Name</span><span>${data.bank.name || '-'}</span></div>`;
            html += `<div class="bank-detail"><span class="label">Account</span><span>${data.bank.accountNumber || '-'}</span></div>`;
            html += `<div class="bank-detail"><span class="label">IFSC</span><span>${data.bank.ifscCode || '-'}</span></div>`;
            if (data.bank.upiId) html += `<div class="bank-detail"><span class="label">UPI</span><span>${data.bank.upiId}</span></div>`;
        }

        if (data.upis && data.upis.length > 0) {
            currentAssignedAccountName = data.upis[0].name || currentAssignedAccountName;
            html += `<div class="upi-list"><h4>📲 Fast UPI Option</h4>`;
            data.upis.forEach(u => {
                html += `<div class="upi-item"><div><div style="font-size:0.75rem;color:var(--text-dim)">${u.name}</div><div class="upi-val">${u.upiId}</div></div><button class="btn-copy" onclick="navigator.clipboard.writeText('${u.upiId}');alert('UPI ID copied!')">📋 Copy</button></div>`;
            });
            html += `</div>`;
        }

        if (!data.bank && (!data.upis || data.upis.length === 0)) {
            html = '<p class="loading-text">No active deposit accounts right now. Contact support.</p>';
        }
        el.innerHTML = html;
    } catch {
        document.getElementById('deposit-bank-info').innerHTML = '<p class="loading-text">Failed to load deposit account</p>';
    }
}

function initiateDepositVerification() {
    const amount = parseInt(document.getElementById('deposit-amount').value);
    const txn = document.getElementById('deposit-txn').value.trim();

    if (!amount || amount < 200) return showMsg('deposit-msg', 'Minimum deposit is ₹200', 'error');
    if (!txn) return showMsg('deposit-msg', 'Please enter your 12-digit UTR / Transaction ID', 'error');
    if (!currentScreenshotBase64) return showMsg('deposit-msg', 'Payment screenshot proof is mandatory', 'error');

    // Populate pre-deposit verify modal
    document.getElementById('v-amount').textContent = `₹${amount}`;
    document.getElementById('v-txn').textContent = txn;
    document.getElementById('v-account').textContent = currentAssignedAccountName;
    document.getElementById('v-screenshot').src = currentScreenshotBase64;
    document.getElementById('deposit-verify-modal').classList.remove('hidden');
}

function closeDepositVerifyModal() {
    document.getElementById('deposit-verify-modal').classList.add('hidden');
}

async function executeDepositSubmission() {
    const amount = parseInt(document.getElementById('deposit-amount').value);
    const transactionId = document.getElementById('deposit-txn').value.trim();
    const btn = document.getElementById('v-confirm-btn');
    btn.disabled = true;
    btn.textContent = 'Submitting...';

    try {
        const res = await fetch(API + '/api/deposit', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                amount,
                transactionId,
                screenshot: currentScreenshotBase64,
                targetAccountName: currentAssignedAccountName
            })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        closeDepositVerifyModal();
        let msg = 'Deposit submitted! Verification takes under 6 hours.';
        if (data.isDuplicate) msg += ' ⚠️ Duplicate UTR detected.';
        showMsg('deposit-msg', msg, 'success');

        document.getElementById('deposit-amount').value = '';
        document.getElementById('deposit-txn').value = '';
        document.getElementById('deposit-screenshot-input').value = '';
        currentScreenshotBase64 = null;
        document.getElementById('screenshot-preview-container').classList.add('hidden');
    } catch (err) {
        closeDepositVerifyModal();
        showMsg('deposit-msg', err.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = '✅ Confirm';
    }
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
    if (!amount || amount < 300) return showMsg('withdraw-msg', 'Minimum withdrawal is ₹300', 'error');

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
        showMsg('withdraw-msg', `Withdrawal submitted! Fee: ₹${data.fee}, Net: ₹${data.netAmount}`, 'success');
        document.getElementById('withdraw-amount').value = '';
        document.getElementById('fee-preview').classList.add('hidden');
        loadProfile();
    } catch (err) { showMsg('withdraw-msg', err.message, 'error'); }
}

// ─── Bank & UPI Management ─────────────────────────────────────────────────────
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
            addResultDot(round.result);
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

// ─── Referrals & Commission Ledger ─────────────────────────────────────────────
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
                    <div>
                        <strong>${r.username}</strong>
                        <div style="font-size:0.75rem;color:var(--text-dim)">Wagered: ₹${r.totalBet || 0} / ₹300</div>
                    </div>
                    <span class="${r.bonusPaid ? 'ref-active' : 'ref-inactive'}">
                        ${r.bonusPaid ? '✅ ₹50 Unlocked' : '⏳ In Progress'}
                    </span>
                </div>
            `).join('');
        }
    } catch {}
}

// ─── Forgot Password & Modals ──────────────────────────────────────────────────
function closeTcModal() {
    document.getElementById('tc-modal').classList.add('hidden');
}

function closeForgotModal() {
    document.getElementById('forgot-modal').classList.add('hidden');
}

async function submitForgotPassword() {
    const username = document.getElementById('forgot-user').value.trim();
    const phone = document.getElementById('forgot-phone').value.trim();
    if (!username) return showMsg('forgot-msg', 'Username is required', 'error');

    try {
        const res = await fetch(API + '/api/forgot-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, phone })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        showMsg('forgot-msg', data.message, 'success');
    } catch (err) { showMsg('forgot-msg', err.message, 'error'); }
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

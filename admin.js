/* ═══ ColorWin Admin JS ═══ */
const API = '';
let token = localStorage.getItem('cw_admin_token');
let socket = null;
let currentRejection = { type: null, id: null };
let currentResetTargetUserId = null;

// ─── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('login-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('login-user').value.trim();
        const password = document.getElementById('login-pass').value;
        try {
            const res = await fetch(API + '/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error);
            if (data.user.role !== 'admin') throw new Error('Not an admin account');
            token = data.token;
            localStorage.setItem('cw_admin_token', token);
            document.getElementById('admin-login').classList.add('hidden');
            document.getElementById('admin-panel').classList.remove('hidden');
            initAdmin();
        } catch (err) {
            document.getElementById('login-error').textContent = err.message;
            document.getElementById('login-error').classList.remove('hidden');
        }
    });

    if (token) {
        document.getElementById('admin-login').classList.add('hidden');
        document.getElementById('admin-panel').classList.remove('hidden');
        initAdmin();
    }
});

function authHeaders() {
    return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` };
}

// ─── Admin Init ────────────────────────────────────────────────────────────────
function initAdmin() {
    connectSocket();
    loadStats();
    loadBets();
    setInterval(() => {
        const activePage = document.querySelector('.page.active');
        if (activePage) {
            const id = activePage.id;
            if (id === 'page-overview') loadStats();
            if (id === 'page-game') loadBets();
        }
    }, 5000);
}

// ─── Socket ────────────────────────────────────────────────────────────────────
function connectSocket() {
    socket = io();
    socket.emit('join', { token });

    socket.on('game:state', (state) => updateGameUI(state));
    socket.on('round:new', () => loadBets());
    socket.on('timer:tick', (data) => updateGameTimer(data.timeLeft));
    socket.on('timer:expired', () => {
        document.getElementById('game-phase').textContent = '⏳ Result Calculating...';
        document.getElementById('game-time').textContent = '00:00';
    });
    socket.on('bets:updated', (bets) => updateBetSummary(bets));
    socket.on('round:result', () => {
        loadStats();
        if (document.getElementById('page-history').classList.contains('active')) loadRoundHistory();
    });
}

// ─── Navigation ────────────────────────────────────────────────────────────────
function showPage(name) {
    document.querySelectorAll('.page').forEach(p => { p.classList.remove('active'); p.classList.add('hidden'); });
    document.querySelectorAll('.s-btn').forEach(b => b.classList.remove('active'));
    const target = document.getElementById(`page-${name}`);
    target.classList.remove('hidden');
    target.classList.add('active');
    document.getElementById(`s-${name}`).classList.add('active');

    const titles = {
        overview: '📊 Overview', game: '🎮 Game Control', users: '👥 Users',
        deposits: '💳 Deposits', withdrawals: '💸 Withdrawals',
        referrals: '🔗 Referrals', eligibility: '✅ Eligibility',
        banks: '🏦 Banks & UPI', notifications: '🔔 Notifications',
        history: '📜 Round History'
    };
    document.getElementById('page-title').textContent = titles[name] || name;

    if (name === 'overview') loadStats();
    if (name === 'game') loadBets();
    if (name === 'users') loadUsers();
    if (name === 'deposits') loadDeposits();
    if (name === 'withdrawals') loadWithdrawals();
    if (name === 'referrals') loadReferrals();
    if (name === 'eligibility') loadEligibility();
    if (name === 'banks') loadBanks();
    if (name === 'notifications') loadNotifications();
    if (name === 'history') loadRoundHistory();

    document.getElementById('sidebar').classList.remove('open');
}

function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('open');
}

// ─── Game State & Lowest Bet Logic ─────────────────────────────────────────────
function updateGameUI(state) {
    updateGameTimer(state.timeLeft);
    const phase = document.getElementById('game-phase');
    const toggleBetBtn = document.getElementById('toggle-bet-btn');
    const toggleAutoBtn = document.getElementById('toggle-auto-btn');

    if (state.maintenanceMode) {
        phase.textContent = '🛠️ Maintenance Active';
        toggleBetBtn.textContent = '🟢 Resume Betting';
        toggleBetBtn.classList.add('locked');
    } else {
        toggleBetBtn.textContent = '🛠️ Maintenance Mode';
        toggleBetBtn.classList.remove('locked');

        if (state.phase === 'betting' && state.bettingOpen) {
            phase.textContent = '🟢 Betting Open';
        } else if (state.phase === 'betting' && !state.bettingOpen) {
            phase.textContent = '🔒 Bets Locked';
        } else if (state.phase === 'closed') {
            phase.textContent = '⏳ Result Calculating...';
        } else if (state.phase === 'result') {
            phase.textContent = `✅ Result: ${(state.result || '').toUpperCase()}`;
        }
    }

    if (toggleAutoBtn) {
        toggleAutoBtn.textContent = state.autoResultMode ? '🤖 Auto-Result: ON' : '🤖 Auto-Result: OFF';
        toggleAutoBtn.classList.toggle('locked', !state.autoResultMode);
    }

    if (state.roundId) {
        document.getElementById('game-round').textContent = `Round #${String(state.roundId).slice(-6)}`;
    }
}

function updateGameTimer(timeLeft) {
    const mins = Math.floor(Math.max(0, timeLeft) / 60);
    const secs = Math.max(0, timeLeft) % 60;
    document.getElementById('game-time').textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function updateBetSummary(bets) {
    document.getElementById('bs-red-count').textContent = bets.red.count;
    document.getElementById('bs-red-total').textContent = `₹${bets.red.total}`;
    document.getElementById('bs-green-count').textContent = bets.green.count;
    document.getElementById('bs-green-total').textContent = `₹${bets.green.total}`;
    document.getElementById('bs-violet-count').textContent = bets.violet.count;
    document.getElementById('bs-violet-total').textContent = `₹${bets.violet.total}`;
    document.getElementById('bs-total-betters').textContent = bets.totalBetters || 0;

    // Calculate Lowest and Highest
    const totals = [
        { color: 'red', total: bets.red.total },
        { color: 'green', total: bets.green.total },
        { color: 'violet', total: bets.violet.total }
    ];
    totals.sort((a, b) => a.total - b.total);

    const lowestColor = totals[0].color;
    const highestColor = totals[2].color;

    ['red', 'green', 'violet'].forEach(c => {
        const badge = document.getElementById(`badge-${c}-status`);
        if (!badge) return;
        if (totals[0].total === totals[2].total) {
            badge.textContent = 'EQUAL';
            badge.className = 'badge';
        } else if (c === lowestColor) {
            badge.textContent = '⭐ LOWEST (AUTO-WIN)';
            badge.className = 'badge badge-auto-win';
        } else if (c === highestColor) {
            badge.textContent = '🚫 HIGHEST (EXCLUDED)';
            badge.className = 'badge badge-auto-lose';
        } else {
            badge.textContent = 'MIDDLE';
            badge.className = 'badge';
        }
    });

    const autoPickEl = document.getElementById('bs-auto-pick');
    if (autoPickEl) {
        autoPickEl.textContent = (bets.autoPick || lowestColor).toUpperCase();
    }
}

async function toggleBetting() {
    try {
        const res = await fetch(API + '/api/admin/toggle-betting', { method: 'POST', headers: authHeaders() });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
    } catch (err) { alert(err.message); }
}

async function toggleAutoResult() {
    try {
        const res = await fetch(API + '/api/admin/toggle-auto-result', { method: 'POST', headers: authHeaders() });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
    } catch (err) { alert(err.message); }
}

async function setResult(color) {
    if (!confirm(`Manually set result to ${color.toUpperCase()}?`)) return;
    try {
        const res = await fetch(API + '/api/admin/result', {
            method: 'POST', headers: authHeaders(),
            body: JSON.stringify({ result: color })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
    } catch (err) { alert(err.message); }
}

async function loadBets() {
    try {
        const res = await fetch(API + '/api/admin/game-bets', { headers: authHeaders() });
        const bets = await res.json();
        updateBetSummary(bets);
    } catch {}
}

// ─── Stats ─────────────────────────────────────────────────────────────────────
async function loadStats() {
    try {
        const res = await fetch(API + '/api/admin/stats', { headers: authHeaders() });
        const s = await res.json();
        document.getElementById('st-users').textContent = s.totalUsers;
        document.getElementById('st-rounds').textContent = s.totalRounds;
        document.getElementById('st-bet').textContent = `₹${s.totalBet}`;
        document.getElementById('st-payout').textContent = `₹${s.totalPayout}`;
        document.getElementById('st-profit').textContent = `₹${s.profit}`;
        document.getElementById('st-pend-dep').textContent = s.pendingDeposits;
        document.getElementById('st-pend-wd').textContent = s.pendingWithdrawals;
        document.getElementById('st-dup').textContent = s.duplicateDeposits;
        document.getElementById('st-susp').textContent = s.suspendedUsers;

        document.getElementById('st-dup-card').classList.toggle('hidden', s.duplicateDeposits === 0);
        document.getElementById('st-susp-card').classList.toggle('hidden', s.suspendedUsers === 0);
    } catch {}
}

// ─── Users ─────────────────────────────────────────────────────────────────────
async function loadUsers() {
    try {
        const res = await fetch(API + '/api/admin/users', { headers: authHeaders() });
        const users = await res.json();
        const tbody = document.getElementById('users-tbody');
        tbody.innerHTML = users.map(u => `
            <tr class="${u.suspended ? 'suspended' : ''}">
                <td><strong>${u.username}</strong></td>
                <td style="font-size:0.8rem">${u.phone || '-'}</td>
                <td>₹${u.balance}</td>
                <td>₹${u.totalBet} / ₹${u.totalWon}</td>
                <td style="color:var(--success);font-weight:600">₹${u.totalCommissionEarned || 0}</td>
                <td>${u.daysSinceActive !== null ? u.daysSinceActive + 'd' : '-'}</td>
                <td><span class="badge ${u.suspended ? 'badge-suspended' : 'badge-active'}">${u.suspended ? 'SUSPENDED' : 'Active'}</span></td>
                <td>
                    <button class="btn-action ${u.vipWithdrawal ? 'btn-toggle-active' : ''}" onclick="toggleVip('${u.id}')">
                        ${u.vipWithdrawal ? '⭐ VIP: ON' : 'VIP: OFF'}
                    </button>
                </td>
                <td style="font-size:0.75rem">${u.bankAccount ? '🏦 ' + (u.bankAccount.accountName || 'Yes') : ''}${u.upiId ? ' 📲 ' + u.upiId : ''}</td>
                <td>
                    <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap">
                        <input type="number" class="adjust-input" id="adj-${u.id}" placeholder="±">
                        <button class="btn-action btn-approve" onclick="adjustBalance('${u.id}')">Adjust</button>
                        <button class="btn-action" style="background:rgba(241,196,15,0.15);color:var(--gold);border:1px solid rgba(241,196,15,0.3)" onclick="openResetPassModal('${u.id}','${u.username}')">🔑 Pass</button>
                        <button class="btn-action" style="background:rgba(108,92,231,0.2);color:var(--primary);border:1px solid rgba(108,92,231,0.3)" onclick="openNotificationForUser('${u.id}','${u.username}')">💬 Message</button>
                        ${u.suspended
                            ? `<button class="btn-action btn-approve" onclick="reactivateUser('${u.id}')">Reactivate</button>`
                            : `<button class="btn-action btn-reject" onclick="suspendUser('${u.id}')">Suspend</button>`
                        }
                        <button class="btn-action btn-delete" onclick="deleteUser('${u.id}','${u.username}')">🗑</button>
                    </div>
                </td>
            </tr>
        `).join('');
    } catch {}
}

async function addUser() {
    const username = document.getElementById('new-user-name').value.trim();
    const password = document.getElementById('new-user-pass').value;
    const phone = document.getElementById('new-user-phone').value.trim();
    const balance = document.getElementById('new-user-bal').value;
    if (!username || !password) return showMsg('add-user-msg', 'Enter username and password', 'error');

    try {
        const res = await fetch(API + '/api/admin/users/add', {
            method: 'POST', headers: authHeaders(),
            body: JSON.stringify({ username, password, phone, balance: Number(balance) || 50 })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        showMsg('add-user-msg', `User "${username}" created!`, 'success');
        document.getElementById('new-user-name').value = '';
        document.getElementById('new-user-pass').value = '';
        document.getElementById('new-user-phone').value = '';
        loadUsers();
    } catch (err) { showMsg('add-user-msg', err.message, 'error'); }
}

async function toggleVip(id) {
    try {
        const res = await fetch(API + `/api/admin/users/${id}/toggle-vip`, { method: 'POST', headers: authHeaders() });
        if (!res.ok) throw new Error('Failed');
        loadUsers();
    } catch (err) { alert(err.message); }
}

function openResetPassModal(id, username) {
    currentResetTargetUserId = id;
    document.getElementById('reset-target-username').textContent = `@${username}`;
    document.getElementById('reset-new-pass').value = '';
    document.getElementById('reset-pass-modal').classList.remove('hidden');
}

function closeResetPassModal() {
    document.getElementById('reset-pass-modal').classList.add('hidden');
}

async function submitPasswordReset() {
    const newPassword = document.getElementById('reset-new-pass').value.trim();
    if (!newPassword || newPassword.length < 4) return showMsg('reset-pass-msg', 'Password must be at least 4 characters', 'error');

    try {
        const res = await fetch(API + `/api/admin/users/${currentResetTargetUserId}/reset-password`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ newPassword })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        alert(data.message);
        closeResetPassModal();
    } catch (err) { showMsg('reset-pass-msg', err.message, 'error'); }
}

async function deleteUser(id, name) {
    if (!confirm(`Delete user "${name}"? This cannot be undone.`)) return;
    try {
        const res = await fetch(API + `/api/admin/users/${id}`, { method: 'DELETE', headers: authHeaders() });
        if (!res.ok) throw new Error('Failed');
        loadUsers();
    } catch (err) { alert(err.message); }
}

async function adjustBalance(userId) {
    const input = document.getElementById(`adj-${userId}`);
    const amount = parseInt(input.value);
    if (isNaN(amount)) return;
    try {
        const res = await fetch(API + '/api/admin/adjust-balance', {
            method: 'POST', headers: authHeaders(),
            body: JSON.stringify({ userId, amount })
        });
        if (!res.ok) throw new Error('Failed');
        input.value = '';
        loadUsers();
    } catch (err) { alert(err.message); }
}

async function reactivateUser(id) {
    try {
        const res = await fetch(API + `/api/admin/users/${id}/reactivate`, { method: 'POST', headers: authHeaders() });
        if (!res.ok) throw new Error('Failed');
        loadUsers();
    } catch (err) { alert(err.message); }
}

async function suspendUser(id) {
    if (!confirm('Suspend this user?')) return;
    try {
        const res = await fetch(API + `/api/admin/users/${id}/suspend`, { method: 'POST', headers: authHeaders() });
        if (!res.ok) throw new Error('Failed');
        loadUsers();
    } catch (err) { alert(err.message); }
}

// ─── Deposits ──────────────────────────────────────────────────────────────────
async function loadDeposits() {
    try {
        const res = await fetch(API + '/api/admin/deposits', { headers: authHeaders() });
        const deps = await res.json();
        const dupCount = deps.filter(d => d.isDuplicate && d.status === 'pending').length;
        const alert = document.getElementById('dep-dup-alert');
        if (dupCount > 0) {
            document.getElementById('dep-dup-count').textContent = dupCount;
            alert.classList.remove('hidden');
        } else {
            alert.classList.add('hidden');
        }

        document.getElementById('deposits-tbody').innerHTML = deps.map(d => `
            <tr>
                <td><strong>${d.username}</strong></td>
                <td style="font-weight:700">₹${d.amount}</td>
                <td>
                    ${d.screenshot ? `<img src="${d.screenshot}" class="screenshot-thumb" onclick="viewScreenshot('${d.screenshot}')" title="Click to view HD proof">` : '<span style="color:var(--text-dim)">No image</span>'}
                </td>
                <td style="font-family:monospace;font-size:0.8rem">${d.transactionId || '-'}</td>
                <td style="font-size:0.8rem;color:var(--primary)">${d.targetAccountName || 'Main'}</td>
                <td><span class="badge badge-${d.status}">${d.status.toUpperCase()}</span></td>
                <td>${d.isDuplicate ? '<span class="badge badge-dup">⚠️ DUPLICATE</span>' : '-'}</td>
                <td style="font-size:0.75rem">${new Date(d.createdAt).toLocaleString()}</td>
                <td>
                    ${d.status === 'pending' ? `
                        <button class="btn-action btn-approve" onclick="approveDeposit('${d.id}')">✅ Approve</button>
                        <button class="btn-action btn-reject" onclick="openRejectionModal('deposit', '${d.id}')">❌ Decline</button>
                    ` : ''}
                </td>
            </tr>
        `).join('');
    } catch {}
}

async function approveDeposit(id) {
    try {
        await fetch(API + `/api/admin/deposits/${id}/approve`, { method: 'POST', headers: authHeaders() });
        loadDeposits(); loadStats();
    } catch {}
}

function viewScreenshot(src) {
    document.getElementById('modal-screenshot-img').src = src;
    document.getElementById('screenshot-modal').classList.remove('hidden');
}

function closeScreenshotModal() {
    document.getElementById('screenshot-modal').classList.add('hidden');
}

// ─── Withdrawals ───────────────────────────────────────────────────────────────
async function loadWithdrawals() {
    try {
        const res = await fetch(API + '/api/admin/withdrawals', { headers: authHeaders() });
        const wds = await res.json();
        document.getElementById('withdrawals-tbody').innerHTML = wds.map(w => {
            const bankInfo = w.bankAccount
                ? `${w.bankAccount.accountName || ''} (${w.bankAccount.accountNumber || ''})`
                : (w.upiId || '-');
            const isVip = w.eligibilitySnapshot?.isVip;
            return `
            <tr>
                <td><strong>${w.username}</strong></td>
                <td>₹${w.amount}</td>
                <td>₹${w.fee || 0}</td>
                <td style="color:var(--success);font-weight:700">₹${w.netAmount || w.amount}</td>
                <td style="font-size:0.75rem">${bankInfo}</td>
                <td>${isVip ? '<span class="badge badge-vip">⭐ VIP Pass</span>' : '<span style="color:var(--text-dim)">Standard</span>'}</td>
                <td><span class="badge badge-${w.status}">${w.status.toUpperCase()}</span></td>
                <td style="font-size:0.75rem">${new Date(w.createdAt).toLocaleString()}</td>
                <td>
                    ${w.status === 'pending' ? `
                        <button class="btn-action btn-approve" onclick="approveWithdrawal('${w.id}')">✅ Approve</button>
                        <button class="btn-action btn-reject" onclick="openRejectionModal('withdrawal', '${w.id}')">❌ Decline</button>
                    ` : ''}
                </td>
            </tr>
        `}).join('');
    } catch {}
}

async function approveWithdrawal(id) {
    try {
        await fetch(API + `/api/admin/withdrawals/${id}/approve`, { method: 'POST', headers: authHeaders() });
        loadWithdrawals(); loadStats();
    } catch {}
}

// ─── Rejection Modal ───────────────────────────────────────────────────────────
function openRejectionModal(type, id) {
    currentRejection = { type, id };
    document.getElementById('rejection-title').textContent = type === 'deposit' ? '❌ Decline Deposit Request' : '❌ Decline Withdrawal Request';
    document.getElementById('quick-reason-select').value = '';
    document.getElementById('rejection-reason-text').value = '';
    document.getElementById('rejection-modal').classList.remove('hidden');
}

function closeRejectionModal() {
    document.getElementById('rejection-modal').classList.add('hidden');
}

function setQuickReason() {
    const sel = document.getElementById('quick-reason-select');
    if (sel.value) document.getElementById('rejection-reason-text').value = sel.value;
}

async function submitRejection() {
    const reason = document.getElementById('rejection-reason-text').value.trim() || 'Verification failed';
    const { type, id } = currentRejection;
    if (!type || !id) return;

    try {
        const endpoint = type === 'deposit' ? `/api/admin/deposits/${id}/reject` : `/api/admin/withdrawals/${id}/reject`;
        await fetch(API + endpoint, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ reason })
        });
        closeRejectionModal();
        if (type === 'deposit') loadDeposits();
        else loadWithdrawals();
        loadStats();
    } catch (err) { alert(err.message); }
}

// ─── Referrals ─────────────────────────────────────────────────────────────────
async function loadReferrals() {
    try {
        const res = await fetch(API + '/api/admin/referrals', { headers: authHeaders() });
        const refs = await res.json();
        document.getElementById('referrals-tbody').innerHTML = refs.map(r => `
            <tr>
                <td><strong>${r.username}</strong></td>
                <td style="font-family:monospace">${r.referralCode}</td>
                <td>${r.totalReferred}</td>
                <td><strong style="color:var(--success)">${r.activeReferrals}</strong></td>
                <td style="color:var(--success);font-weight:700">₹${r.totalCommissionEarned || 0}</td>
                <td style="font-size:0.75rem">${r.referred.map(u => `${u.username}(₹${u.totalBet}/300 ${u.bonusPaid ? '✅' : '⏳'})`).join(', ') || '-'}</td>
            </tr>
        `).join('');
    } catch {}
}

// ─── Eligibility ───────────────────────────────────────────────────────────────
async function loadEligibility() {
    try {
        const res = await fetch(API + '/api/admin/withdrawal-eligibility', { headers: authHeaders() });
        const data = await res.json();
        document.getElementById('eligibility-tbody').innerHTML = data.map(u => `
            <tr>
                <td><strong>${u.username}</strong></td>
                <td>₹${u.balance}</td>
                <td>₹${u.totalDeposited}</td>
                <td>${u.referrals} (Active: ${u.activeReferrals})</td>
                <td><button class="btn-action ${u.isVip ? 'btn-toggle-active' : ''}" onclick="toggleVip('${u.id}')">${u.isVip ? '⭐ VIP Enabled' : 'Standard'}</button></td>
                <td>${u.eligible ? '✅ YES' : '❌ NO'}</td>
                <td style="font-size:0.75rem">${u.isVip ? '⭐ VIP Pass Override' : (u.reasons.join('; ') || 'All requirements satisfied')}</td>
                <td><button class="btn-action btn-approve" onclick="toggleVip('${u.id}')">Toggle VIP</button></td>
            </tr>
        `).join('');
    } catch {}
}

// ─── Banks & UPI Accounts ──────────────────────────────────────────────────────
async function loadBanks() {
    try {
        const res = await fetch(API + '/api/admin/banks', { headers: authHeaders() });
        const data = await res.json();
        const ledger = data.ledgerStats || {};

        const depBtn = document.getElementById('global-deposits-btn');
        if (depBtn) {
            const enabled = data.settings?.depositsEnabled !== false;
            depBtn.textContent = enabled ? '🟢 Deposits Active' : '🔴 Deposits Paused';
            depBtn.className = `btn-toggle ${enabled ? '' : 'locked'}`;
        }

        document.getElementById('banks-tbody').innerHTML = (data.banks || []).map(b => `
            <tr>
                <td><strong>${b.name || '-'}</strong></td>
                <td>${b.accountNumber || '-'}</td>
                <td>${b.ifscCode || '-'}</td>
                <td>${b.upiId || '-'}</td>
                <td style="color:var(--success);font-weight:700">₹${ledger[b.name] || 0}</td>
                <td><span class="badge ${b.active ? 'badge-active' : 'badge-suspended'}">${b.active ? 'Active' : 'Inactive'}</span></td>
                <td>
                    <button class="btn-action ${b.lockedForAll ? 'btn-reject' : 'btn-approve'}" onclick="toggleBankLock('${b.id}')">
                        ${b.lockedForAll ? '🔒 Locked' : '🔓 Available'}
                    </button>
                </td>
                <td>
                    <button class="btn-action ${b.active ? 'btn-reject' : 'btn-approve'}" onclick="toggleBank('${b.id}')">${b.active ? 'Disable' : 'Enable'}</button>
                    <button class="btn-action btn-delete" onclick="deleteBank('${b.id}')">🗑</button>
                </td>
            </tr>
        `).join('');

        document.getElementById('upis-tbody').innerHTML = (data.upis || []).map(u => `
            <tr>
                <td><strong>${u.name || '-'}</strong></td>
                <td style="font-weight:600">${u.upiId}</td>
                <td style="color:var(--success);font-weight:700">₹${ledger[u.name] || 0}</td>
                <td><span class="badge ${u.active ? 'badge-active' : 'badge-suspended'}">${u.active ? 'Active' : 'Inactive'}</span></td>
                <td>
                    <button class="btn-action ${u.lockedForAll ? 'btn-reject' : 'btn-approve'}" onclick="toggleUpiLock('${u.id}')">
                        ${u.lockedForAll ? '🔒 Locked' : '🔓 Available'}
                    </button>
                </td>
                <td>
                    <button class="btn-action ${u.active ? 'btn-reject' : 'btn-approve'}" onclick="toggleUpi('${u.id}')">${u.active ? 'Disable' : 'Enable'}</button>
                    <button class="btn-action btn-delete" onclick="deleteUpi('${u.id}')">🗑</button>
                </td>
            </tr>
        `).join('');
    } catch {}
}

async function toggleGlobalDeposits() {
    try {
        await fetch(API + '/api/admin/toggle-deposits', { method: 'POST', headers: authHeaders() });
        loadBanks();
    } catch {}
}

async function addBank() {
    const name = document.getElementById('ab-name').value.trim();
    const accountNumber = document.getElementById('ab-number').value.trim();
    const ifscCode = document.getElementById('ab-ifsc').value.trim();
    const upiId = document.getElementById('ab-upi').value.trim();
    if (!name || !accountNumber) return alert('Name and account number required');
    try {
        const res = await fetch(API + '/api/admin/banks', {
            method: 'POST', headers: authHeaders(),
            body: JSON.stringify({ name, accountNumber, ifscCode, upiId })
        });
        if (!res.ok) throw new Error('Failed');
        document.getElementById('ab-name').value = '';
        document.getElementById('ab-number').value = '';
        document.getElementById('ab-ifsc').value = '';
        document.getElementById('ab-upi').value = '';
        loadBanks();
    } catch (err) { alert(err.message); }
}

async function toggleBank(id) {
    try {
        await fetch(API + `/api/admin/banks/${id}/toggle`, { method: 'POST', headers: authHeaders() });
        loadBanks();
    } catch {}
}

async function toggleBankLock(id) {
    try {
        await fetch(API + `/api/admin/banks/${id}/toggle-lock`, { method: 'POST', headers: authHeaders() });
        loadBanks();
    } catch {}
}

async function deleteBank(id) {
    if (!confirm('Delete this bank account?')) return;
    try {
        await fetch(API + `/api/admin/banks/${id}`, { method: 'DELETE', headers: authHeaders() });
        loadBanks();
    } catch {}
}

async function addUpi() {
    const name = document.getElementById('au-name').value.trim();
    const upiId = document.getElementById('au-upi').value.trim();
    if (!name || !upiId) return alert('Name and UPI ID required');
    try {
        const res = await fetch(API + '/api/admin/upi', {
            method: 'POST', headers: authHeaders(),
            body: JSON.stringify({ name, upiId })
        });
        if (!res.ok) throw new Error('Failed');
        document.getElementById('au-name').value = '';
        document.getElementById('au-upi').value = '';
        loadBanks();
    } catch (err) { alert(err.message); }
}

async function toggleUpi(id) {
    try {
        await fetch(API + `/api/admin/upi/${id}/toggle`, { method: 'POST', headers: authHeaders() });
        loadBanks();
    } catch {}
}

async function toggleUpiLock(id) {
    try {
        await fetch(API + `/api/admin/upi/${id}/toggle-lock`, { method: 'POST', headers: authHeaders() });
        loadBanks();
    } catch {}
}

async function deleteUpi(id) {
    if (!confirm('Delete this UPI account?')) return;
    try {
        await fetch(API + `/api/admin/upi/${id}`, { method: 'DELETE', headers: authHeaders() });
        loadBanks();
    } catch {}
}

// ─── Notifications ─────────────────────────────────────────────────────────────
async function populateUserDropdown() {
    try {
        const res = await fetch(API + '/api/admin/users', { headers: authHeaders() });
        const users = await res.json();
        const select = document.getElementById('notif-target');
        if (!select) return;
        const currentVal = select.value;
        let html = '<option value="all">📢 All Users (Broadcast)</option>';
        users.forEach(u => {
            html += `<option value="${u.id}">👤 ${u.username} (${u.phone || 'No phone'})</option>`;
        });
        select.innerHTML = html;
        if (currentVal) select.value = currentVal;
    } catch {}
}

async function openNotificationForUser(userId, username) {
    showPage('notifications');
    await populateUserDropdown();
    const select = document.getElementById('notif-target');
    if (select) select.value = userId;
    const titleInput = document.getElementById('notif-title');
    if (titleInput) {
        titleInput.value = `Official Message for @${username}`;
        titleInput.focus();
    }
}

async function loadNotifications() {
    try {
        populateUserDropdown();
        const res = await fetch(API + '/api/admin/notifications', { headers: authHeaders() });
        const notifs = await res.json();
        const list = document.getElementById('notif-list-admin');
        if (notifs.length === 0) {
            list.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:20px">No notifications sent yet</div>';
        } else {
            list.innerHTML = notifs.map(n => {
                const recipientLabel = n.targetUserId ? `👤 Private: ${n.targetUsername || 'User'}` : '📢 Broadcast: All Users';
                const recipientBadge = n.targetUserId ? 'badge-pending' : 'badge-active';
                return `
                <div class="notif-admin-item">
                    <div class="notif-admin-info">
                        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
                            <span class="badge ${recipientBadge}">${recipientLabel}</span>
                            <span class="notif-admin-title" style="margin:0">${n.title}</span>
                        </div>
                        <div class="notif-admin-msg">${n.message}</div>
                        <div class="notif-admin-time">${new Date(n.createdAt).toLocaleString()}</div>
                    </div>
                    <button class="btn-action btn-delete" onclick="deleteNotification('${n.id}')">🗑</button>
                </div>
            `}).join('');
        }
    } catch {}
}

async function sendNotification() {
    const targetSelect = document.getElementById('notif-target');
    const targetUserId = targetSelect ? targetSelect.value : 'all';
    const title = document.getElementById('notif-title').value.trim();
    const message = document.getElementById('notif-message').value.trim();
    if (!title || !message) return showMsg('notif-msg', 'Enter title and message', 'error');

    try {
        const res = await fetch(API + '/api/admin/notifications', {
            method: 'POST', headers: authHeaders(),
            body: JSON.stringify({ title, message, targetUserId })
        });
        if (!res.ok) throw new Error('Failed');
        const targetLabel = targetUserId === 'all' ? 'all users' : 'the selected user';
        showMsg('notif-msg', `Notification sent to ${targetLabel}!`, 'success');
        document.getElementById('notif-title').value = '';
        document.getElementById('notif-message').value = '';
        loadNotifications();
    } catch (err) { showMsg('notif-msg', err.message, 'error'); }
}

async function deleteNotification(id) {
    try {
        await fetch(API + `/api/admin/notifications/${id}`, { method: 'DELETE', headers: authHeaders() });
        loadNotifications();
    } catch {}
}

// ─── Round History ─────────────────────────────────────────────────────────────
async function loadRoundHistory() {
    try {
        const res = await fetch(API + '/api/admin/rounds', { headers: authHeaders() });
        const rounds = await res.json();
        document.getElementById('history-tbody').innerHTML = rounds.map(r => `
            <tr>
                <td>#${String(r.id).slice(-6)}</td>
                <td><span class="badge-result ${r.result}">${r.result.toUpperCase()}</span></td>
                <td>₹${r.totalBet}</td>
                <td>₹${r.totalPayout}</td>
                <td style="color:${r.profit >= 0 ? 'var(--success)' : 'var(--danger)'};font-weight:700">₹${r.profit}</td>
                <td style="font-size:0.75rem">${new Date(r.timestamp).toLocaleString()}</td>
            </tr>
        `).join('');
    } catch {}
}

// ─── Utilities ─────────────────────────────────────────────────────────────────
function showMsg(id, msg, type) {
    const el = document.getElementById(id);
    el.textContent = msg;
    el.className = `msg ${type}`;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 4000);
}

function adminLogout() {
    localStorage.removeItem('cw_admin_token');
    token = null;
    if (socket) socket.disconnect();
    location.reload();
}

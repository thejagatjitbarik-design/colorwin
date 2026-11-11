/* ═══ ColorWin Admin JS ═══ */
const API = '';
let token = localStorage.getItem('cw_admin_token');
let socket = null;

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
    // Auto-refresh stats
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
        document.getElementById('game-phase').textContent = '⏳ Waiting for Result';
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

    // Load data for page
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

    // Close sidebar on mobile
    document.getElementById('sidebar').classList.remove('open');
}

function toggleSidebar() {
    document.getElementById('sidebar').classList.toggle('open');
}

// ─── Game State ────────────────────────────────────────────────────────────────
function updateGameUI(state) {
    updateGameTimer(state.timeLeft);
    const phase = document.getElementById('game-phase');
    const toggleBtn = document.getElementById('toggle-bet-btn');

    if (state.phase === 'betting' && state.bettingOpen) {
        phase.textContent = '🟢 Betting Open';
        toggleBtn.textContent = '🔒 Lock Bets';
        toggleBtn.classList.remove('locked');
    } else if (state.phase === 'betting' && !state.bettingOpen) {
        phase.textContent = '🔒 Bets Locked';
        toggleBtn.textContent = '🔓 Unlock Bets';
        toggleBtn.classList.add('locked');
    } else if (state.phase === 'closed') {
        phase.textContent = '⏳ Timer Ended — Set Result';
    } else if (state.phase === 'result') {
        phase.textContent = `✅ Result: ${(state.result || '').toUpperCase()}`;
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
}

// ─── Game Actions ──────────────────────────────────────────────────────────────
async function toggleBetting() {
    try {
        const res = await fetch(API + '/api/admin/toggle-betting', { method: 'POST', headers: authHeaders() });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
    } catch (err) { alert(err.message); }
}

async function setResult(color) {
    if (!confirm(`Set result to ${color.toUpperCase()}?`)) return;
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

        // Highlight danger cards
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
                <td>₹${u.balance}</td>
                <td>₹${u.totalBet} / ₹${u.totalWon}</td>
                <td>${u.daysSinceActive !== null ? u.daysSinceActive + 'd' : '-'}</td>
                <td><span class="badge ${u.suspended ? 'badge-suspended' : 'badge-active'}">${u.suspended ? 'SUSPENDED' : 'Active'}</span></td>
                <td style="font-size:0.75rem">${u.bankAccount ? '🏦 ' + (u.bankAccount.accountName || 'Yes') : ''}${u.upiId ? ' 📲 ' + u.upiId : ''}</td>
                <td>
                    <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap">
                        <input type="number" class="adjust-input" id="adj-${u.id}" placeholder="±">
                        <button class="btn-action btn-approve" onclick="adjustBalance('${u.id}')">Adjust</button>
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
    const balance = document.getElementById('new-user-bal').value;
    if (!username || !password) return showMsg('add-user-msg', 'Enter username and password', 'error');

    try {
        const res = await fetch(API + '/api/admin/users/add', {
            method: 'POST', headers: authHeaders(),
            body: JSON.stringify({ username, password, balance: Number(balance) || 50 })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        showMsg('add-user-msg', `User "${username}" created!`, 'success');
        document.getElementById('new-user-name').value = '';
        document.getElementById('new-user-pass').value = '';
        loadUsers();
    } catch (err) { showMsg('add-user-msg', err.message, 'error'); }
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
                <td>${d.username}</td>
                <td>₹${d.amount}</td>
                <td style="font-family:monospace;font-size:0.8rem">${d.transactionId || '-'}</td>
                <td><span class="badge badge-${d.status}">${d.status.toUpperCase()}</span></td>
                <td>${d.isDuplicate ? '<span class="badge badge-dup">⚠️ DUPLICATE</span>' : '-'}</td>
                <td style="font-size:0.75rem">${new Date(d.createdAt).toLocaleString()}</td>
                <td>
                    ${d.status === 'pending' ? `
                        <button class="btn-action btn-approve" onclick="approveDeposit('${d.id}')">✅ Approve</button>
                        <button class="btn-action btn-reject" onclick="rejectDeposit('${d.id}')">❌ Reject</button>
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

async function rejectDeposit(id) {
    try {
        await fetch(API + `/api/admin/deposits/${id}/reject`, { method: 'POST', headers: authHeaders() });
        loadDeposits(); loadStats();
    } catch {}
}

// ─── Withdrawals ───────────────────────────────────────────────────────────────
async function loadWithdrawals() {
    try {
        const res = await fetch(API + '/api/admin/withdrawals', { headers: authHeaders() });
        const wds = await res.json();
        document.getElementById('withdrawals-tbody').innerHTML = wds.map(w => {
            const bankInfo = w.bankAccount
                ? `${w.bankAccount.accountName || ''} - ${w.bankAccount.accountNumber || ''}`
                : (w.upiId || '-');
            return `
            <tr>
                <td>${w.username}</td>
                <td>₹${w.amount}</td>
                <td>₹${w.fee || 0}</td>
                <td style="color:var(--success);font-weight:700">₹${w.netAmount || w.amount}</td>
                <td style="font-size:0.75rem">${bankInfo}</td>
                <td><span class="badge badge-${w.status}">${w.status.toUpperCase()}</span></td>
                <td style="font-size:0.75rem">${new Date(w.createdAt).toLocaleString()}</td>
                <td>
                    ${w.status === 'pending' ? `
                        <button class="btn-action btn-approve" onclick="approveWithdrawal('${w.id}')">✅ Approve</button>
                        <button class="btn-action btn-reject" onclick="rejectWithdrawal('${w.id}')">❌ Reject</button>
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

async function rejectWithdrawal(id) {
    try {
        await fetch(API + `/api/admin/withdrawals/${id}/reject`, { method: 'POST', headers: authHeaders() });
        loadWithdrawals(); loadStats();
    } catch {}
}

// ─── Referrals ─────────────────────────────────────────────────────────────────
async function loadReferrals() {
    try {
        const res = await fetch(API + '/api/admin/referrals', { headers: authHeaders() });
        const refs = await res.json();
        document.getElementById('referrals-tbody').innerHTML = refs.map(r => `
            <tr>
                <td>${r.username}</td>
                <td style="font-family:monospace">${r.referralCode}</td>
                <td>${r.totalReferred}</td>
                <td>${r.activeReferrals}</td>
                <td style="font-size:0.75rem">${r.referred.map(u => `${u.username}(${u.active ? '✅' : '❌'})`).join(', ') || '-'}</td>
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
                <td>${u.username}</td>
                <td>₹${u.balance}</td>
                <td>₹${u.totalDeposited}</td>
                <td>${u.referrals}</td>
                <td>${u.activeReferrals}</td>
                <td>${u.eligible ? '✅' : '❌'}</td>
                <td style="font-size:0.75rem">${u.reasons.join('; ') || 'All met'}</td>
            </tr>
        `).join('');
    } catch {}
}

// ─── Banks & UPI ───────────────────────────────────────────────────────────────
async function loadBanks() {
    try {
        const res = await fetch(API + '/api/admin/banks', { headers: authHeaders() });
        const data = await res.json();

        document.getElementById('banks-tbody').innerHTML = (data.banks || []).map(b => `
            <tr>
                <td>${b.name || '-'}</td>
                <td>${b.accountNumber || '-'}</td>
                <td>${b.ifscCode || '-'}</td>
                <td>${b.upiId || '-'}</td>
                <td><span class="badge ${b.active ? 'badge-active' : 'badge-suspended'}">${b.active ? 'Active' : 'Inactive'}</span></td>
                <td>
                    <button class="btn-action ${b.active ? 'btn-reject' : 'btn-approve'}" onclick="toggleBank('${b.id}')">${b.active ? 'Disable' : 'Enable'}</button>
                    <button class="btn-action btn-delete" onclick="deleteBank('${b.id}')">🗑</button>
                </td>
            </tr>
        `).join('');

        document.getElementById('upis-tbody').innerHTML = (data.upis || []).map(u => `
            <tr>
                <td>${u.name || '-'}</td>
                <td style="font-weight:600">${u.upiId}</td>
                <td><span class="badge ${u.active ? 'badge-active' : 'badge-suspended'}">${u.active ? 'Active' : 'Inactive'}</span></td>
                <td>
                    <button class="btn-action ${u.active ? 'btn-reject' : 'btn-approve'}" onclick="toggleUpi('${u.id}')">${u.active ? 'Disable' : 'Enable'}</button>
                    <button class="btn-action btn-delete" onclick="deleteUpi('${u.id}')">🗑</button>
                </td>
            </tr>
        `).join('');
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

async function deleteUpi(id) {
    if (!confirm('Delete this UPI account?')) return;
    try {
        await fetch(API + `/api/admin/upi/${id}`, { method: 'DELETE', headers: authHeaders() });
        loadBanks();
    } catch {}
}

// ─── Notifications ─────────────────────────────────────────────────────────────
async function loadNotifications() {
    try {
        const res = await fetch(API + '/api/admin/notifications', { headers: authHeaders() });
        const notifs = await res.json();
        const list = document.getElementById('notif-list-admin');
        if (notifs.length === 0) {
            list.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:20px">No notifications sent yet</div>';
        } else {
            list.innerHTML = notifs.map(n => `
                <div class="notif-admin-item">
                    <div class="notif-admin-info">
                        <div class="notif-admin-title">${n.title}</div>
                        <div class="notif-admin-msg">${n.message}</div>
                        <div class="notif-admin-time">${new Date(n.createdAt).toLocaleString()}</div>
                    </div>
                    <button class="btn-action btn-delete" onclick="deleteNotification('${n.id}')">🗑</button>
                </div>
            `).join('');
        }
    } catch {}
}

async function sendNotification() {
    const title = document.getElementById('notif-title').value.trim();
    const message = document.getElementById('notif-message').value.trim();
    if (!title || !message) return showMsg('notif-msg', 'Enter title and message', 'error');

    try {
        const res = await fetch(API + '/api/admin/notifications', {
            method: 'POST', headers: authHeaders(),
            body: JSON.stringify({ title, message })
        });
        if (!res.ok) throw new Error('Failed');
        showMsg('notif-msg', 'Notification sent to all users!', 'success');
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

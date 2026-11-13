/* ═══ ColorWin Admin JS ═══ */
const API = '';
let token = localStorage.getItem('cw_admin_token');
let socket = null;
let currentRejection = { type: null, id: null };
let currentResetTargetUserId = null;

// ─── Helpers: Escape & Eye Toggle ──────────────────────────────────────────────
function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, m => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[m]);
}

function escapeAttr(str) {
    if (!str) return '';
    return String(str).replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

function toggleInputEye(inputId, btn) {
    const input = document.getElementById(inputId);
    if (!input) return;
    if (input.type === 'password') {
        input.type = 'text';
        btn.textContent = '🙈';
    } else {
        input.type = 'password';
        btn.textContent = '👁️';
    }
}

function getCurrentAdminUser() {
    try {
        const raw = localStorage.getItem('cw_admin_user');
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

function applyRolePermissions() {
    const user = getCurrentAdminUser();
    const badge = document.getElementById('admin-user-badge');
    const resetCard = document.getElementById('overview-reset-card');

    if (!user || user.role === 'admin') {
        if (badge) {
            badge.textContent = `👑 Super Admin (${user ? '@' + user.username : 'Admin'})`;
            badge.style.color = 'var(--accent)';
        }
        document.querySelectorAll('.s-btn').forEach(b => b.classList.remove('hidden'));
        if (resetCard) resetCard.classList.remove('hidden');
        return;
    }

    // Role is staff
    const perms = Array.isArray(user.permissions) ? user.permissions : [];
    const isAll = perms.includes('all');
    if (badge) {
        badge.textContent = `🛡️ Staff: ${user.name || user.username} (@${user.username})`;
        badge.style.color = '#2ecc71';
    }

    // Super Admin exclusive tabs are hidden for staff
    const staffBtn = document.getElementById('s-staff');
    const settingsBtn = document.getElementById('s-settings');
    if (staffBtn) staffBtn.classList.add('hidden');
    if (settingsBtn) settingsBtn.classList.add('hidden');
    if (resetCard) resetCard.classList.add('hidden');

    const permMap = {
        's-game': 'game',
        's-users': 'users',
        's-deposits': 'deposits',
        's-withdrawals': 'withdrawals',
        's-referrals': 'referrals',
        's-eligibility': 'eligibility',
        's-banks': 'banks',
        's-support': 'support',
        's-notifications': 'notifications',
        's-history': 'history',
        's-tickets': 'tickets',
        's-ledger': 'ledger'
    };

    let firstAllowed = 'overview';
    for (const [btnId, permKey] of Object.entries(permMap)) {
        const btn = document.getElementById(btnId);
        if (btn) {
            let allowed = isAll || perms.includes(permKey);
            if (permKey === 'notifications') {
                allowed = true; // All admins and sub-admins can view platform notifications
            }
            if (permKey === 'tickets' && (perms.includes('deposits') || perms.includes('withdrawals') || perms.includes('support'))) {
                allowed = true;
            }
            if (permKey === 'ledger' && perms.includes('deposits')) {
                allowed = true;
            }
            btn.classList.toggle('hidden', !allowed);
            if (allowed && firstAllowed === 'overview') {
                firstAllowed = permKey;
            }
        }
    }

    const activePage = document.querySelector('.page.active');
    if (activePage) {
        const pageName = activePage.id.replace('page-', '');
        if (pageName === 'staff' || pageName === 'settings' || (permMap[`s-${pageName}`] && !isAll && !perms.includes(permMap[`s-${pageName}`]))) {
            showPage(firstAllowed);
        }
    }
}

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
            if (data.user.role !== 'admin' && data.user.role !== 'staff') {
                throw new Error('Access denied: Admin or Staff role required');
            }
            token = data.token;
            localStorage.setItem('cw_admin_token', token);
            localStorage.setItem('cw_admin_user', JSON.stringify(data.user));
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
    applyRolePermissions();
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
    socket.on('ticket:new', () => {
        const p = document.getElementById('page-tickets');
        if (p && p.classList.contains('active')) {
            loadAdminTickets();
            loadActiveOTPs();
        }
    });
    socket.on('otp:new', () => {
        const p = document.getElementById('page-tickets');
        if (p && p.classList.contains('active')) loadActiveOTPs();
    });
    socket.on('ticket:updated', (ticket) => {
        const p = document.getElementById('page-tickets');
        if (p && p.classList.contains('active')) loadAdminTickets();
        if (currentAdminTicketId === ticket.id) renderAdminTicketThread(ticket);
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
        support: '📞 Support & Groups',
        history: '📜 Round History',
        staff: '🛡️ Staff & Roles',
        settings: '⚙️ Admin Security',
        tickets: '🎫 Support Tickets',
        ledger: '💰 Real Cash P&L'
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
    if (name === 'support') loadSupportAdmin();
    if (name === 'notifications') loadNotifications();
    if (name === 'history') loadRoundHistory();
    if (name === 'staff') loadStaffList();
    if (name === 'tickets') { loadAdminTickets(); loadActiveOTPs(); }
    if (name === 'ledger') loadCashLedger();

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
function toggleUserPassword(id, plainPassword) {
    const el = document.getElementById(`user-pass-${id}`);
    if (!el) return;
    if (el.classList.contains('hidden')) {
        el.textContent = plainPassword || '(legacy/encrypted - click 🔑 Pass to set)';
        el.classList.remove('hidden');
    } else {
        el.textContent = '';
        el.classList.add('hidden');
    }
}

async function loadUsers() {
    try {
        const res = await fetch(API + '/api/admin/users', { headers: authHeaders() });
        const users = await res.json();
        const tbody = document.getElementById('users-tbody');
        tbody.innerHTML = users.map(u => `
            <tr class="${u.suspended ? 'suspended' : ''}">
                <td><strong>${escapeHtml(u.username)}</strong></td>
                <td>
                    <div style="display:flex;align-items:center;gap:6px">
                        <button class="btn-action" style="padding:4px 8px;font-size:0.75rem;white-space:nowrap" onclick="toggleUserPassword('${u.id}', '${escapeAttr(u.plainPassword || '')}')">👁️ Show</button>
                        <span id="user-pass-${u.id}" class="pass-val hidden" style="font-size:0.82rem;font-family:monospace;font-weight:700;color:var(--accent)"></span>
                    </div>
                </td>
                <td style="font-size:0.8rem">${escapeHtml(u.phone || '-')}</td>
                <td>₹${u.balance}</td>
                <td>₹${u.totalBet} / ₹${u.totalWon}</td>
                <td style="color:var(--success);font-weight:600">₹${u.totalCommissionEarned || 0}</td>
                <td>${u.daysSinceActive !== null ? u.daysSinceActive + 'd' : '-'}</td>
                <td><span class="badge ${u.suspended ? 'badge-suspended' : 'badge-active'}">${u.suspended ? 'SUSPENDED' : 'Active'}</span></td>
                <td>
                    <button class="btn-action ${u.directWithdrawal || u.vipWithdrawal ? 'btn-toggle-active' : ''}" 
                            style="${u.directWithdrawal || u.vipWithdrawal ? 'background:rgba(46,204,113,0.2);color:#2ecc71;border:1px solid #2ecc71;font-weight:600' : 'background:rgba(255,255,255,0.06);color:var(--text-dim)'}" 
                            onclick="toggleDirectWithdrawal('${u.id}')" 
                            title="${u.directWithdrawal || u.vipWithdrawal ? 'Direct Withdrawal Allowed (Targets Bypassed)' : 'Standard User (Must meet targets)'}">
                        ${u.directWithdrawal || u.vipWithdrawal ? '⭐ Direct: ALLOWED' : '🔒 Standard Target'}
                    </button>
                </td>
                <td style="font-size:0.75rem">${u.bankAccount ? '🏦 ' + (u.bankAccount.accountName || 'Yes') : ''}${u.upiId ? ' 📲 ' + u.upiId : ''}</td>
                <td>
                    <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap">
                        <input type="number" class="adjust-input" id="adj-${u.id}" placeholder="±">
                        <button class="btn-action btn-approve" onclick="adjustBalance('${u.id}')">Adjust</button>
                        <button class="btn-action" style="background:rgba(241,196,15,0.15);color:var(--gold);border:1px solid rgba(241,196,15,0.3)" onclick="openResetPassModal('${u.id}','${escapeAttr(u.username)}')">🔑 Pass</button>
                        <button class="btn-action" style="background:rgba(108,92,231,0.2);color:var(--primary);border:1px solid rgba(108,92,231,0.3)" onclick="openNotificationForUser('${u.id}','${escapeAttr(u.username)}')">💬 Message</button>
                        ${u.suspended
                            ? `<button class="btn-action btn-approve" onclick="reactivateUser('${u.id}')">Reactivate</button>`
                            : `<button class="btn-action btn-reject" onclick="suspendUser('${u.id}')">Suspend</button>`
                        }
                        <button class="btn-action btn-delete" onclick="deleteUser('${u.id}','${escapeAttr(u.username)}')">🗑</button>
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

async function toggleDirectWithdrawal(id) {
    try {
        const res = await fetch(API + `/api/admin/users/${id}/toggle-direct-withdrawal`, { method: 'POST', headers: authHeaders() });
        if (!res.ok) throw new Error('Failed to update direct withdrawal permission');
        loadUsers();
        if (typeof loadEligibility === 'function') loadEligibility();
    } catch (err) { alert(err.message); }
}
const toggleVip = toggleDirectWithdrawal;

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

// ─── Withdrawals (Full Bank & UPI Details for Manual Payouts) ───────────────────
let cachedWithdrawals = [];
let currentPayoutWithdrawal = null;

function copyText(text, label = 'Copied') {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
        alert(`✅ ${label}: "${text}" copied to clipboard!`);
    }).catch(() => {
        prompt(`Copy ${label}:`, text);
    });
}

async function loadWithdrawals() {
    try {
        const res = await fetch(API + '/api/admin/withdrawals', { headers: authHeaders() });
        const wds = await res.json();
        cachedWithdrawals = wds;

        document.getElementById('withdrawals-tbody').innerHTML = wds.map(w => {
            const bank = w.latestBankAccount || w.bankAccount;
            const upi = w.latestUpiId || w.upiId;
            const phone = w.userPhone || '-';
            const isVip = w.eligibilitySnapshot?.isVip;
            const net = w.netAmount || w.amount;

            let paymentDetailsHtml = '';
            if (bank) {
                paymentDetailsHtml += `
                    <div class="payout-bank-box" style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:8px 10px;margin-bottom:4px">
                        <div style="font-weight:700;color:var(--text);font-size:0.85rem">🏦 ${bank.accountName || 'Bank Account'}</div>
                        <div style="display:flex;align-items:center;gap:6px;margin:3px 0">
                            <span style="color:var(--text-dim);font-size:0.75rem">A/C:</span>
                            <span style="font-family:monospace;font-weight:700;color:var(--primary);font-size:0.85rem">${bank.accountNumber || '-'}</span>
                            ${bank.accountNumber ? `<button class="btn-copy-sm" onclick="copyText('${bank.accountNumber}', 'Account Number')" title="Copy Account Number">📋</button>` : ''}
                        </div>
                        <div style="display:flex;align-items:center;gap:6px">
                            <span style="color:var(--text-dim);font-size:0.75rem">IFSC:</span>
                            <span style="font-family:monospace;font-weight:600;font-size:0.8rem;color:var(--gold)">${bank.ifscCode || '-'}</span>
                            ${bank.ifscCode ? `<button class="btn-copy-sm" onclick="copyText('${bank.ifscCode}', 'IFSC Code')" title="Copy IFSC">📋</button>` : ''}
                        </div>
                    </div>
                `;
            }
            if (upi) {
                paymentDetailsHtml += `
                    <div class="payout-upi-box" style="background:rgba(108,92,231,0.08);border:1px solid rgba(108,92,231,0.25);border-radius:8px;padding:6px 10px;margin-bottom:4px">
                        <div style="display:flex;align-items:center;justify-content:space-between;gap:6px">
                            <div>
                                <span style="font-size:0.7rem;color:var(--text-dim)">📲 UPI:</span>
                                <span style="font-family:monospace;font-weight:700;color:var(--gold);font-size:0.85rem">${upi}</span>
                            </div>
                            <button class="btn-copy-sm" onclick="copyText('${upi}', 'UPI ID')" title="Copy UPI ID">📋 Copy</button>
                        </div>
                    </div>
                `;
            }
            if (!bank && !upi) {
                paymentDetailsHtml = '<span style="color:var(--danger);font-size:0.8rem">⚠️ No details provided</span>';
            }

            return `
            <tr>
                <td>
                    <strong>${w.username}</strong>
                    <div style="font-size:0.75rem;color:var(--text-dim)">📞 ${phone} ${phone !== '-' ? `<button class="btn-copy-sm" onclick="copyText('${phone}', 'Phone')" title="Copy Phone">📋</button>` : ''}</div>
                </td>
                <td>₹${w.amount}</td>
                <td>₹${w.fee || 0}</td>
                <td>
                    <div style="color:var(--success);font-weight:800;font-size:1.05rem">₹${net}</div>
                    <button class="btn-copy-sm" style="margin-top:2px" onclick="copyText('${net}', 'Amount')">📋 Copy ₹${net}</button>
                </td>
                <td style="min-width:250px;text-align:left">
                    ${paymentDetailsHtml}
                    <button class="btn-action" style="background:rgba(255,255,255,0.08);font-size:0.7rem;padding:3px 8px;margin-top:4px" onclick="openPayoutModal('${w.id}')">🔍 Full Payout Receipt</button>
                </td>
                <td>${isVip ? '<span class="badge badge-vip">⭐ VIP Pass</span>' : '<span style="color:var(--text-dim)">Standard</span>'}</td>
                <td><span class="badge badge-${w.status}">${w.status.toUpperCase()}</span></td>
                <td style="font-size:0.75rem">${new Date(w.createdAt).toLocaleString()}</td>
                <td>
                    ${w.status === 'pending' ? `
                        <button class="btn-action btn-approve" onclick="approveWithdrawal('${w.id}')">✅ Approve Paid</button>
                        <button class="btn-action btn-reject" onclick="openRejectionModal('withdrawal', '${w.id}')">❌ Decline</button>
                    ` : ''}
                </td>
            </tr>
        `}).join('');
    } catch {}
}

function openPayoutModal(id) {
    const wd = cachedWithdrawals.find(w => w.id === id);
    if (!wd) return;
    currentPayoutWithdrawal = wd;

    const bank = wd.latestBankAccount || wd.bankAccount;
    const upi = wd.latestUpiId || wd.upiId;
    const phone = wd.userPhone || '-';
    const net = wd.netAmount || wd.amount;

    let fullTextToCopy = `ColorWin Manual Payout: Send ₹${net} to @${wd.username}`;
    if (bank) {
        fullTextToCopy += ` | Name: ${bank.accountName || '-'}, A/C: ${bank.accountNumber || '-'}, IFSC: ${bank.ifscCode || '-'}`;
    }
    if (upi) {
        fullTextToCopy += ` | UPI: ${upi}`;
    }
    if (phone && phone !== '-') {
        fullTextToCopy += ` | Phone: ${phone}`;
    }

    let html = `
        <div style="background:rgba(46,204,113,0.12);border:1px solid rgba(46,204,113,0.3);border-radius:12px;padding:16px;text-align:center;margin-bottom:16px">
            <div style="font-size:0.8rem;color:var(--text-dim);text-transform:uppercase;letter-spacing:1px">Exact Amount to Transfer</div>
            <div style="font-size:2.2rem;font-weight:800;color:var(--success);margin:4px 0">₹${net}</div>
            <div style="font-size:0.75rem;color:var(--text-dim)">(Requested: ₹${wd.amount} - 0.5% Fee: ₹${wd.fee || 0})</div>
            <button class="btn-copy-sm" style="margin-top:8px;padding:5px 14px;font-size:0.85rem;font-weight:700" onclick="copyText('${net}', 'Transfer Amount')">📋 Copy ₹${net}</button>
        </div>

        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;background:rgba(255,255,255,0.03);padding:10px 14px;border-radius:8px">
            <div>
                <div style="font-size:0.75rem;color:var(--text-dim)">Player Account</div>
                <strong style="font-size:1rem;color:var(--text)">@${wd.username}</strong>
            </div>
            <div>
                <div style="font-size:0.75rem;color:var(--text-dim)">Phone / Mobile</div>
                <div style="font-weight:700;color:var(--gold);font-family:monospace">${phone}</div>
            </div>
            ${phone && phone !== '-' ? `<button class="btn-copy-sm" onclick="copyText('${phone}', 'Phone Number')">📋 Copy</button>` : ''}
        </div>
    `;

    if (bank) {
        html += `
            <div style="background:rgba(255,255,255,0.04);border:1px solid var(--card-border);border-radius:10px;padding:14px;margin-bottom:14px">
                <div style="font-weight:700;color:var(--primary);font-size:0.9rem;margin-bottom:10px">🏦 Full Bank Account Details</div>
                
                <div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
                    <span style="font-size:0.8rem;color:var(--text-dim)">Account Holder Name:</span>
                    <strong style="color:var(--text)">${bank.accountName || '-'}</strong>
                    ${bank.accountName ? `<button class="btn-copy-sm" onclick="copyText('${bank.accountName}', 'Account Holder Name')">📋</button>` : ''}
                </div>
                
                <div style="display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid rgba(255,255,255,0.06)">
                    <span style="font-size:0.8rem;color:var(--text-dim)">Account Number:</span>
                    <strong style="font-family:monospace;font-size:1.1rem;color:var(--primary)">${bank.accountNumber || '-'}</strong>
                    ${bank.accountNumber ? `<button class="btn-copy-sm" onclick="copyText('${bank.accountNumber}', 'Account Number')">📋 Copy A/C</button>` : ''}
                </div>
                
                <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0">
                    <span style="font-size:0.8rem;color:var(--text-dim)">IFSC Code:</span>
                    <strong style="font-family:monospace;font-size:1.05rem;color:var(--gold)">${bank.ifscCode || '-'}</strong>
                    ${bank.ifscCode ? `<button class="btn-copy-sm" onclick="copyText('${bank.ifscCode}', 'IFSC Code')">📋 Copy IFSC</button>` : ''}
                </div>
            </div>
        `;
    }

    if (upi) {
        html += `
            <div style="background:rgba(108,92,231,0.08);border:1px solid rgba(108,92,231,0.25);border-radius:10px;padding:14px;margin-bottom:14px">
                <div style="font-weight:700;color:var(--gold);font-size:0.9rem;margin-bottom:8px">📲 Full UPI ID</div>
                <div style="display:flex;justify-content:space-between;align-items:center">
                    <span style="font-family:monospace;font-weight:800;color:var(--gold);font-size:1.15rem">${upi}</span>
                    <button class="btn-copy-sm" style="padding:6px 14px;font-weight:700" onclick="copyText('${upi}', 'UPI ID')">📋 Copy UPI</button>
                </div>
            </div>
        `;
    }

    html += `
        <div style="display:flex;flex-direction:column;gap:10px;margin-top:16px">
            <button class="btn-primary" onclick="copyText('${fullTextToCopy.replace(/'/g, "\\'")}', 'All Details')">
                📋 Copy All Transfer Info (One-Click)
            </button>
            <div style="display:flex;gap:10px">
                ${wd.status === 'pending' ? `
                    <button class="btn-action btn-approve" style="flex:1;padding:12px;font-size:0.9rem" onclick="approveWithdrawal('${wd.id}');closePayoutModal()">
                        ✅ Mark as Transferred / Approved
                    </button>
                    <button class="btn-action btn-reject" style="flex:1;padding:12px;font-size:0.9rem" onclick="closePayoutModal();openRejectionModal('withdrawal', '${wd.id}')">
                        ❌ Decline
                    </button>
                ` : `
                    <div style="width:100%;text-align:center;padding:10px;color:var(--text-dim);font-size:0.85rem">Current Status: <strong class="badge badge-${wd.status}">${wd.status.toUpperCase()}</strong></div>
                `}
            </div>
        </div>
    `;

    document.getElementById('payout-modal-body').innerHTML = html;
    document.getElementById('payout-detail-modal').classList.remove('hidden');
}

function closePayoutModal() {
    document.getElementById('payout-detail-modal').classList.add('hidden');
    currentPayoutWithdrawal = null;
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

// ─── Referrals (4 Legs) ────────────────────────────────────────────────────────
async function loadReferrals() {
    try {
        const res = await fetch(API + '/api/admin/referrals', { headers: authHeaders() });
        const refs = await res.json();
        document.getElementById('referrals-tbody').innerHTML = refs.map(r => `
            <tr>
                <td><strong>${r.username}</strong></td>
                <td><code style="color:var(--primary);font-weight:700">${r.referralCode}</code></td>
                <td><strong style="color:var(--primary)">${r.leg1Count || 0}</strong></td>
                <td>${r.leg2Count || 0}</td>
                <td>${r.leg3Count || 0}</td>
                <td>${r.leg4Count || 0}</td>
                <td><strong>${r.totalNetwork || 0}</strong></td>
                <td style="color:var(--success);font-weight:700">₹${(r.totalCommissionEarned || 0).toFixed(2)}</td>
                <td><span class="badge ${r.bonusQualified > 0 ? 'badge-approved' : 'badge-pending'}">${r.bonusQualified || 0} users</span></td>
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
                <td>
                    <button class="btn-action ${u.directWithdrawal || u.isVip ? 'btn-toggle-active' : ''}" 
                            style="${u.directWithdrawal || u.isVip ? 'background:rgba(46,204,113,0.2);color:#2ecc71;border:1px solid #2ecc71;font-weight:600' : 'background:rgba(255,255,255,0.06);color:var(--text-dim)'}"
                            onclick="toggleDirectWithdrawal('${u.id}')">
                        ${u.directWithdrawal || u.isVip ? '⭐ Direct (VIP)' : '🔒 Standard'}
                    </button>
                </td>
                <td>${u.eligible ? '✅ YES' : '❌ NO'}</td>
                <td style="font-size:0.75rem">${u.directWithdrawal || u.isVip ? '⭐ Direct VIP Override (Targets Bypassed)' : (u.reasons.join('; ') || 'All requirements satisfied')}</td>
                <td><button class="btn-action btn-approve" onclick="toggleDirectWithdrawal('${u.id}')">Toggle Access</button></td>
            </tr>
        `).join('');
    } catch {}
}

async function systemResetAll() {
    const confirmation = prompt('⚠️ DANGER: This will delete ALL users, bets, and rounds and start the entire game from Round #1 at ZERO!\n\nType RESET to confirm:');
    if (confirmation !== 'RESET') return alert('Reset cancelled.');
    try {
        const res = await fetch(API + '/api/admin/system/reset-all', {
            method: 'POST',
            headers: authHeaders()
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        alert('✅ Platform has been completely reset to zero! Page will now reload.');
        window.location.reload();
    } catch (err) {
        alert('Reset failed: ' + err.message);
    }
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

// ─── Support & Groups Admin Management ─────────────────────────────────────────
async function loadSupportAdmin() {
    try {
        const res = await fetch(API + '/api/support-info');
        const data = await res.json();

        const contactsBody = document.getElementById('support-contacts-tbody');
        if (contactsBody) {
            contactsBody.innerHTML = (data.contacts || []).map(c => `
                <tr>
                    <td><span class="badge ${c.type === 'email' ? 'badge-pending' : 'badge-active'}">${c.type.toUpperCase()}</span></td>
                    <td><strong>${c.title}</strong></td>
                    <td>${c.value}</td>
                    <td style="font-size:0.75rem;color:var(--primary);max-width:200px;overflow:hidden;text-overflow:ellipsis">${c.link}</td>
                    <td><button class="btn-action btn-delete" onclick="deleteSupportContact('${c.id}')">🗑 Remove</button></td>
                </tr>
            `).join('');
        }

        const groupsBody = document.getElementById('support-groups-tbody');
        if (groupsBody) {
            groupsBody.innerHTML = (data.groups || []).map(g => `
                <tr>
                    <td><strong>${g.title}</strong></td>
                    <td style="font-size:0.8rem;color:var(--primary)">${g.link}</td>
                    <td><button class="btn-action btn-delete" onclick="deleteSupportGroup('${g.id}')">🗑 Remove</button></td>
                </tr>
            `).join('');
        }
    } catch {}
}

async function addSupportContact() {
    const type = document.getElementById('as-type').value;
    const title = document.getElementById('as-title').value.trim();
    const value = document.getElementById('as-value').value.trim();
    const link = document.getElementById('as-link').value.trim();

    if (!title || !value) return alert('Please enter title and contact number/email');

    try {
        const res = await fetch(API + '/api/admin/support/contact', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ type, title, value, link })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        document.getElementById('as-title').value = '';
        document.getElementById('as-value').value = '';
        document.getElementById('as-link').value = '';
        loadSupportAdmin();
    } catch (err) { alert(err.message); }
}

async function deleteSupportContact(id) {
    if (!confirm('Remove this support contact?')) return;
    try {
        const res = await fetch(API + `/api/admin/support/contact/${id}`, { method: 'DELETE', headers: authHeaders() });
        if (!res.ok) throw new Error('Failed');
        loadSupportAdmin();
    } catch (err) { alert(err.message); }
}

async function addSupportGroup() {
    const title = document.getElementById('ag-title').value.trim();
    const link = document.getElementById('ag-link').value.trim();

    if (!title || !link) return alert('Please enter group title and link');

    try {
        const res = await fetch(API + '/api/admin/support/group', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ title, link })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        document.getElementById('ag-title').value = '';
        document.getElementById('ag-link').value = '';
        loadSupportAdmin();
    } catch (err) { alert(err.message); }
}

async function deleteSupportGroup(id) {
    if (!confirm('Remove this group link?')) return;
    try {
        const res = await fetch(API + `/api/admin/support/group/${id}`, { method: 'DELETE', headers: authHeaders() });
        if (!res.ok) throw new Error('Failed');
        loadSupportAdmin();
    } catch (err) { alert(err.message); }
}

// ─── Staff & Sub-Admin Role-Based Management (RBAC) ───────────────────────────
function selectStaffPerms(type) {
    const chks = document.querySelectorAll('.staff-perm-chk');
    chks.forEach(c => {
        if (type === 'all') c.checked = true;
        else if (type === 'none') c.checked = false;
        else if (type === 'deposits_only') c.checked = (c.value === 'deposits');
        else if (type === 'withdrawals_only') c.checked = (c.value === 'withdrawals');
    });
}

function generateStaffPassword() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let res = 'CW@';
    for (let i = 0; i < 5; i++) res += chars.charAt(Math.floor(Math.random() * chars.length));
    const passInput = document.getElementById('staff-pass');
    if (passInput) {
        passInput.value = res;
        passInput.type = 'text';
    }
}

async function loadStaffList() {
    try {
        const res = await fetch(API + '/api/admin/staff', { headers: authHeaders() });
        const staff = await res.json();
        const tbody = document.getElementById('staff-tbody');
        if (!tbody) return;

        if (!staff || staff.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--text-dim)">No staff accounts created yet. Use the form above to add one.</td></tr>`;
            return;
        }

        tbody.innerHTML = staff.map(s => {
            const permsHtml = (s.permissions || []).map(p => {
                if (p === 'all') return `<span class="perm-badge perm-all">⭐ ALL ACCESS</span>`;
                return `<span class="perm-badge">${p}</span>`;
            }).join(' ') || '<span style="color:var(--text-dim);font-size:0.75rem">No permissions</span>';

            const plainPass = s.plainPassword ? escapeAttr(s.plainPassword) : '';

            return `
                <tr>
                    <td><strong>@${escapeHtml(s.username)}</strong></td>
                    <td style="font-size:0.85rem">${escapeHtml(s.name || '-')}</td>
                    <td>
                        <div style="display:flex;align-items:center;gap:6px">
                            <button class="btn-action" style="padding:4px 8px;font-size:0.75rem;white-space:nowrap" onclick="toggleStaffPassword('${s.id}', '${plainPass}')">👁️ Show</button>
                            <span id="staff-pass-${s.id}" class="pass-val hidden" style="font-size:0.82rem;font-family:monospace;font-weight:700;color:var(--accent)"></span>
                        </div>
                    </td>
                    <td>${permsHtml}</td>
                    <td>
                        <button class="btn-action ${s.active ? 'btn-toggle-active' : ''}" 
                                style="${s.active ? 'background:rgba(46,204,113,0.2);color:#2ecc71;border:1px solid #2ecc71' : 'background:rgba(231,76,60,0.15);color:var(--danger);border:1px solid rgba(231,76,60,0.3)'}" 
                                onclick="toggleStaffActive('${s.id}')">
                            ${s.active ? '✅ Active' : '❌ Disabled'}
                        </button>
                    </td>
                    <td style="font-size:0.75rem;color:var(--text-dim)">${new Date(s.createdAt).toLocaleDateString()}</td>
                    <td>
                        <div style="display:flex;gap:4px">
                            <button class="btn-action" style="background:rgba(241,196,15,0.15);color:var(--gold);border:1px solid rgba(241,196,15,0.3)" onclick="openStaffPassModal('${s.id}', '${escapeAttr(s.username)}')">🔑 Pass</button>
                            <button class="btn-action btn-delete" onclick="deleteStaffAccount('${s.id}', '${escapeAttr(s.username)}')">🗑️</button>
                        </div>
                    </td>
                </tr>
            `;
        }).join('');
    } catch {}
}

function toggleStaffPassword(id, plainPassword) {
    const el = document.getElementById(`staff-pass-${id}`);
    if (!el) return;
    if (el.classList.contains('hidden')) {
        el.textContent = plainPassword || '(click 🔑 Pass to set)';
        el.classList.remove('hidden');
    } else {
        el.textContent = '';
        el.classList.add('hidden');
    }
}

async function createStaffAccount() {
    const username = document.getElementById('staff-user').value.trim();
    const name = document.getElementById('staff-name').value.trim();
    const password = document.getElementById('staff-pass').value;
    const chks = document.querySelectorAll('.staff-perm-chk:checked');
    const permissions = Array.from(chks).map(c => c.value);

    if (!username || !password) {
        return showMsg('add-staff-msg', 'Username and Password are required', 'error');
    }
    if (password.length < 4) {
        return showMsg('add-staff-msg', 'Password must be at least 4 characters', 'error');
    }
    if (permissions.length === 0) {
        return showMsg('add-staff-msg', 'Please assign at least one permission to this staff account', 'error');
    }

    try {
        const res = await fetch(API + '/api/admin/staff/add', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ username, name, password, permissions })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        showMsg('add-staff-msg', `Staff account @${username} created successfully!`, 'success');
        document.getElementById('staff-user').value = '';
        document.getElementById('staff-name').value = '';
        document.getElementById('staff-pass').value = '';
        selectStaffPerms('none');
        loadStaffList();
    } catch (err) {
        showMsg('add-staff-msg', err.message, 'error');
    }
}

async function toggleStaffActive(id) {
    try {
        const res = await fetch(`${API}/api/admin/staff/${id}/toggle`, {
            method: 'POST',
            headers: authHeaders()
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        loadStaffList();
    } catch (err) {
        alert(err.message);
    }
}

let currentStaffPassTargetId = null;
function openStaffPassModal(id, username) {
    currentStaffPassTargetId = id;
    document.getElementById('staff-pass-target-user').textContent = `@${username}`;
    document.getElementById('staff-modal-new-pass').value = '';
    document.getElementById('staff-modal-pass-msg').classList.add('hidden');
    document.getElementById('staff-pass-modal').classList.remove('hidden');
}

function closeStaffPassModal() {
    document.getElementById('staff-pass-modal').classList.add('hidden');
    currentStaffPassTargetId = null;
}

async function submitStaffPasswordChange() {
    const newPassword = document.getElementById('staff-modal-new-pass').value;
    if (!newPassword || newPassword.length < 4) {
        return showMsg('staff-modal-pass-msg', 'Password must be at least 4 characters', 'error');
    }
    try {
        const res = await fetch(`${API}/api/admin/staff/${currentStaffPassTargetId}/password`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ newPassword })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        showMsg('staff-modal-pass-msg', data.message || 'Password updated!', 'success');
        setTimeout(() => {
            closeStaffPassModal();
            loadStaffList();
        }, 1200);
    } catch (err) {
        showMsg('staff-modal-pass-msg', err.message, 'error');
    }
}

async function deleteStaffAccount(id, username) {
    if (!confirm(`Are you sure you want to permanently delete staff account @${username}?`)) return;
    try {
        const res = await fetch(`${API}/api/admin/staff/${id}`, {
            method: 'DELETE',
            headers: authHeaders()
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        loadStaffList();
    } catch (err) {
        alert(err.message);
    }
}

// ─── Super Admin Master Password Change ────────────────────────────────────────
async function submitChangeAdminPassword() {
    const currentPassword = document.getElementById('admin-curr-pass').value;
    const newPassword = document.getElementById('admin-new-pass').value;
    const confirmPassword = document.getElementById('admin-confirm-pass').value;

    if (!currentPassword || !newPassword) {
        return showMsg('admin-pass-msg', 'Current and new passwords are required', 'error');
    }
    if (newPassword.length < 4) {
        return showMsg('admin-pass-msg', 'New password must be at least 4 characters', 'error');
    }
    if (newPassword !== confirmPassword) {
        return showMsg('admin-pass-msg', 'New password and confirm password do not match', 'error');
    }

    try {
        const res = await fetch(API + '/api/admin/change-password', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ currentPassword, newPassword })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        showMsg('admin-pass-msg', 'Master Admin password successfully updated! Please remember your new password.', 'success');
        document.getElementById('admin-curr-pass').value = '';
        document.getElementById('admin-new-pass').value = '';
        document.getElementById('admin-confirm-pass').value = '';
    } catch (err) {
        showMsg('admin-pass-msg', err.message, 'error');
    }
}

// ─── Utilities ─────────────────────────────────────────────────────────────────
function showMsg(id, msg, type) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = msg;
    el.className = `msg ${type}`;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 4000);
}

function adminLogout() {
    localStorage.removeItem('cw_admin_token');
    localStorage.removeItem('cw_admin_user');
    token = null;
    if (socket) socket.disconnect();
    location.reload();
}

// ─── Support Helpdesk Tickets (Admin Side) ─────────────────────────────────────
let adminTicketsCache = [];
let currentAdminTicketId = null;

async function loadAdminTickets() {
    try {
        const res = await fetch(API + '/api/admin/tickets', { headers: authHeaders() });
        const list = await res.json();
        adminTicketsCache = list || [];
        filterAdminTickets();
    } catch {}
}

function filterAdminTickets() {
    const deptFilter = document.getElementById('tk-filter-dept')?.value || 'all';
    const statusFilter = document.getElementById('tk-filter-status')?.value || 'all';
    const tbody = document.getElementById('admin-tickets-tbody');
    if (!tbody) return;

    let filtered = adminTicketsCache.slice();
    if (deptFilter !== 'all') {
        filtered = filtered.filter(t => t.category === deptFilter);
    }
    if (statusFilter !== 'all') {
        filtered = filtered.filter(t => t.status === statusFilter);
    }

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:24px;color:var(--text-dim)">No support tickets found matching current filters.</td></tr>`;
        return;
    }

    const catBadges = {
        deposit: '<span class="badge" style="background:rgba(46,204,113,0.15);color:var(--success)">💳 Deposit</span>',
        withdrawal: '<span class="badge" style="background:rgba(230,126,34,0.15);color:var(--gold)">💸 Withdrawal</span>',
        game: '<span class="badge" style="background:rgba(155,89,182,0.15);color:#9b59b6">🎮 Game</span>',
        account: '<span class="badge" style="background:rgba(52,152,219,0.15);color:#3498db">👤 Account</span>',
        other: '<span class="badge" style="background:rgba(255,255,255,0.08);color:var(--text-dim)">❓ General</span>'
    };

    const statusBadges = {
        open: '<span class="badge" style="background:rgba(241,196,15,0.2);color:#f1c40f">🟡 Open</span>',
        in_progress: '<span class="badge" style="background:rgba(52,152,219,0.2);color:#3498db">🔵 In Progress</span>',
        resolved: '<span class="badge" style="background:rgba(46,204,113,0.2);color:#2ecc71">🟢 Resolved</span>',
        closed: '<span class="badge" style="background:rgba(255,255,255,0.1);color:var(--text-dim)">⚪ Closed</span>'
    };

    tbody.innerHTML = filtered.map(t => {
        const msgCount = (t.messages || []).length;
        const lastMsg = t.messages && t.messages.length > 0 ? t.messages[t.messages.length - 1] : null;

        return `
            <tr>
                <td><strong>#${t.ticketNumber}</strong></td>
                <td>
                    <strong>@${escapeHtml(t.username)}</strong>
                </td>
                <td>${catBadges[t.category] || t.category}</td>
                <td>
                    <div style="font-weight:600;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(t.subject)}</div>
                </td>
                <td style="font-family:monospace;font-size:0.8rem">${t.referenceId ? escapeHtml(t.referenceId) : '-'}</td>
                <td>${statusBadges[t.status] || t.status}</td>
                <td style="font-size:0.8rem">
                    💬 ${msgCount}${lastMsg ? `<br><span style="font-size:0.7rem;color:var(--text-dim)">Last by ${lastMsg.sender === 'admin' ? '🛡️ ' + lastMsg.senderName : 'User'}</span>` : ''}
                </td>
                <td style="font-size:0.75rem;color:var(--text-dim)">${new Date(t.updatedAt || t.createdAt).toLocaleString()}</td>
                <td>
                    <button class="btn-action" style="background:rgba(108,92,231,0.2);color:var(--primary);border:1px solid rgba(108,92,231,0.4)" onclick="openAdminTicketModal('${t.id}')">💬 Open</button>
                </td>
            </tr>
        `;
    }).join('');
}

let currentTicketUserObj = null;
let isTicketPassRevealed = false;

function openAdminTicketModal(ticketId) {
    const t = adminTicketsCache.find(item => item.id === ticketId);
    if (!t) return;
    currentAdminTicketId = ticketId;
    currentTicketUserObj = t;
    isTicketPassRevealed = false;

    document.getElementById('adm-tk-num').textContent = `Ticket #${t.ticketNumber}`;
    document.getElementById('adm-tk-dept').textContent = t.category.toUpperCase();
    document.getElementById('adm-tk-user').textContent = `@${t.username}`;
    document.getElementById('adm-tk-subj').textContent = t.subject;

    const phoneEl = document.getElementById('adm-tk-phone');
    if (phoneEl) phoneEl.textContent = t.phone || '-';

    const passEl = document.getElementById('adm-tk-pass');
    if (passEl) {
        passEl.textContent = '••••••';
    }

    const refBox = document.getElementById('adm-tk-ref-box');
    const refEl = document.getElementById('adm-tk-ref');
    if (t.referenceId) {
        refEl.textContent = t.referenceId;
        refBox.classList.remove('hidden');
    } else {
        refBox.classList.add('hidden');
    }

    const sel = document.getElementById('adm-tk-status-select');
    if (sel) sel.value = t.status || 'open';

    renderAdminTicketThread(t);
    document.getElementById('adm-tk-reply-input').value = '';
    const msg = document.getElementById('adm-tk-msg');
    if (msg) msg.classList.add('hidden');

    document.getElementById('admin-ticket-modal').classList.remove('hidden');
}

function toggleAdminTicketPassword() {
    const passEl = document.getElementById('adm-tk-pass');
    if (!passEl || !currentTicketUserObj) return;
    isTicketPassRevealed = !isTicketPassRevealed;
    const actual = currentTicketUserObj.userPlainPassword || '(Not Stored Plain)';
    passEl.textContent = isTicketPassRevealed ? actual : '••••••';
}

function sharePasswordViaWhatsApp() {
    if (!currentTicketUserObj) return;
    const phone = (currentTicketUserObj.phone || '').toString().trim().replace(/[^0-9]/g, '');
    const cleanPhone = phone.replace(/^(\+91|91|0)/, '');
    if (!cleanPhone || cleanPhone.length !== 10) {
        alert('Registered mobile number is missing or invalid for this ticket.');
        return;
    }
    const username = currentTicketUserObj.username || 'User';
    const password = currentTicketUserObj.userPlainPassword || '(Password not available in plain text. Use Live OTP Helpline below to reset)';
    const text = `Hello @${username},\n\nHere are your ColorWin account login credentials:\n\n👤 User ID: ${username}\n🔑 Password: ${password}\n\n🌐 Login URL: ${window.location.origin}\n\nIf you need any further help, reply to this message.\n- ColorWin Support Team`;
    const waUrl = `https://wa.me/91${cleanPhone}?text=${encodeURIComponent(text)}`;
    window.open(waUrl, '_blank');
}

function copyAdminTicketCreds() {
    if (!currentTicketUserObj) return;
    const username = currentTicketUserObj.username || 'User';
    const password = currentTicketUserObj.userPlainPassword || 'N/A';
    const text = `ColorWin Credentials:\nUser ID: ${username}\nPassword: ${password}\nLogin: ${window.location.origin}`;
    navigator.clipboard.writeText(text).then(() => {
        showMsg('adm-tk-msg', 'Credentials copied to clipboard!', 'success');
    }).catch(() => {
        alert(text);
    });
}

function renderAdminTicketThread(t) {
    const thread = document.getElementById('adm-tk-thread');
    if (!thread) return;

    thread.innerHTML = (t.messages || []).map(m => {
        const isAdmin = m.sender === 'admin';
        return `
            <div class="ticket-bubble ${isAdmin ? 'bubble-user' : 'bubble-admin'}" style="${isAdmin ? 'align-self:flex-end;background:linear-gradient(135deg, var(--primary), #9b59b6);color:#fff' : 'align-self:flex-start;background:rgba(255,255,255,0.06);color:var(--text)'}">
                <div style="font-weight:700;font-size:0.75rem;margin-bottom:2px">${isAdmin ? '🛡️ ' + escapeHtml(m.senderName || 'Staff') : '@' + escapeHtml(m.senderName || 'Player')}</div>
                <div>${escapeHtml(m.text)}</div>
                <div class="ticket-bubble-meta">
                    <span>${new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
            </div>
        `;
    }).join('');

    setTimeout(() => {
        thread.scrollTop = thread.scrollHeight;
    }, 50);
}

function closeAdminTicketModal() {
    document.getElementById('admin-ticket-modal').classList.add('hidden');
    currentAdminTicketId = null;
}

async function submitAdminTicketReply() {
    if (!currentAdminTicketId) return;
    const input = document.getElementById('adm-tk-reply-input');
    const message = input.value.trim();
    if (!message) return;

    const statusSel = document.getElementById('adm-tk-status-select');
    const status = statusSel ? statusSel.value : 'in_progress';

    try {
        const res = await fetch(`${API}/api/admin/tickets/${currentAdminTicketId}/reply`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ message, status })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        input.value = '';
        const idx = adminTicketsCache.findIndex(t => t.id === currentAdminTicketId);
        if (idx !== -1) adminTicketsCache[idx] = data.ticket;
        renderAdminTicketThread(data.ticket);
        filterAdminTickets();
        showMsg('adm-tk-msg', 'Reply sent to player!', 'success');
    } catch (err) {
        showMsg('adm-tk-msg', err.message, 'error');
    }
}

async function changeAdminTicketStatus() {
    if (!currentAdminTicketId) return;
    const status = document.getElementById('adm-tk-status-select').value;
    try {
        const res = await fetch(`${API}/api/admin/tickets/${currentAdminTicketId}/status`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ status })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        const idx = adminTicketsCache.findIndex(t => t.id === currentAdminTicketId);
        if (idx !== -1) adminTicketsCache[idx] = data.ticket;
        filterAdminTickets();
    } catch (err) {
        alert(err.message);
    }
}

// ─── Real Cash Financial P&L Ledger (Actual Inflows & Outflows) ───────────────
async function loadCashLedger() {
    try {
        const res = await fetch(API + '/api/admin/cash-ledger', { headers: authHeaders() });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        // Update KPI Cards
        const totalIn = document.getElementById('cl-total-in');
        const totalOut = document.getElementById('cl-total-out');
        const netProfitEl = document.getElementById('cl-net-profit');
        const profitMarginEl = document.getElementById('cl-profit-margin');
        const totalLiability = document.getElementById('cl-total-liability');

        if (totalIn) totalIn.textContent = `₹${data.totalRealDeposits}`;
        if (totalOut) totalOut.textContent = `₹${data.totalRealWithdrawals}`;
        
        if (netProfitEl) {
            netProfitEl.textContent = `₹${data.netCashProfit}`;
            netProfitEl.style.color = data.netCashProfit >= 0 ? 'var(--success)' : 'var(--danger)';
        }

        if (profitMarginEl) profitMarginEl.textContent = `Pure Bank Margin: ${data.profitMarginPct}%`;
        if (totalLiability) totalLiability.textContent = `₹${data.totalUserBalanceLiability}`;

        // Populate Table
        const tbody = document.getElementById('cash-ledger-tbody');
        if (!tbody) return;

        if (!data.userLedger || data.userLedger.length === 0) {
            tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--text-dim)">No real cash deposits or withdrawals recorded yet.</td></tr>`;
            return;
        }

        tbody.innerHTML = data.userLedger.map(u => {
            const isProfit = u.netContribution >= 0;
            const statusHtml = isProfit
                ? `<span class="badge" style="background:rgba(46,204,113,0.2);color:#2ecc71;font-weight:700">🟢 Platform Profit</span>`
                : `<span class="badge" style="background:rgba(231,76,60,0.2);color:var(--danger);font-weight:700">🔴 Platform Loss</span>`;

            return `
                <tr>
                    <td><strong>@${escapeHtml(u.username)}</strong></td>
                    <td style="font-size:0.85rem">${escapeHtml(u.phone)}</td>
                    <td style="color:var(--success);font-weight:700">₹${u.totalDeposited} <span style="font-size:0.75rem;color:var(--text-dim);font-weight:400">(${u.depositCount} deps)</span></td>
                    <td style="color:var(--gold);font-weight:700">₹${u.totalWithdrawn} <span style="font-size:0.75rem;color:var(--text-dim);font-weight:400">(${u.withdrawalCount} wds)</span></td>
                    <td style="font-weight:600">₹${u.currentBalance}</td>
                    <td style="color:${isProfit ? 'var(--success)' : 'var(--danger)'};font-weight:800;font-size:0.95rem">
                        ${isProfit ? '+' : ''}₹${u.netContribution}
                    </td>
                    <td>${statusHtml}</td>
                </tr>
            `;
        }).join('');
    } catch {}
}

// ─── Live Active Password OTPs (Helpline Tool) ───────────────────────────────
async function loadActiveOTPs() {
    const tbody = document.getElementById('admin-active-otps-tbody');
    if (!tbody) return;
    try {
        const res = await fetch(API + '/api/admin/active-otps', { headers: authHeaders() });
        const list = await res.json();
        if (!res.ok) throw new Error(list.error || 'Failed to load active OTPs');

        if (!list || list.length === 0) {
            tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:16px;color:var(--text-dim)">No active password OTPs at this moment.</td></tr>`;
            return;
        }

        tbody.innerHTML = list.map(o => {
            const cleanPhone = (o.phone || '').replace(/[^0-9]/g, '').replace(/^(\+91|91|0)/, '');
            const waText = encodeURIComponent(`Hello @${o.username}, your ColorWin password reset OTP is: ${o.otp}. Valid for 10 minutes.\nLogin URL: ${window.location.origin}`);
            const waLink = `https://wa.me/91${cleanPhone}?text=${waText}`;

            return `
                <tr>
                    <td><strong>@${escapeHtml(o.username)}</strong></td>
                    <td>${escapeHtml(o.phone || '-')}</td>
                    <td><strong style="color:var(--gold);font-size:1.1rem;letter-spacing:2px;font-family:monospace">${escapeHtml(o.otp)}</strong></td>
                    <td><span class="badge" style="background:rgba(241,196,15,0.2);color:#f1c40f">${o.remainingSec}s left</span></td>
                    <td>${o.attempts || 0} / 5</td>
                    <td>
                        <a href="${waLink}" target="_blank" class="btn-action" style="background:#25d366;color:#111;font-weight:700;border:none;padding:5px 12px;text-decoration:none;display:inline-block;font-size:0.75rem;border-radius:6px">
                            📲 Send OTP on WhatsApp
                        </a>
                    </td>
                </tr>
            `;
        }).join('');
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--danger);padding:14px">Error: ${escapeHtml(err.message)}</td></tr>`;
    }
}

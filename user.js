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

// ─── Helpers: Escape HTML & Attributes ──────────────────────────────────────────
function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>"']/g, m => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[m]);
}

function escapeAttr(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/'/g, "\\'").replace(/"/g, '&quot;');
}
window.escapeHtml = escapeHtml;
window.escapeAttr = escapeAttr;

// ══════════════════════════════════════════════════════════════════════════════════
// 🔊 ColorWin Web Audio Ringtone & Sound FX Engine (High Fidelity, Zero Network)
// ══════════════════════════════════════════════════════════════════════════════════
const SoundFX = {
    ctx: null,
    muted: localStorage.getItem('cw_sound_muted') === 'true',

    init() {
        if (!this.ctx) {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (AudioCtx) {
                this.ctx = new AudioCtx();
            }
        }
        if (this.ctx && this.ctx.state === 'suspended') {
            this.ctx.resume().catch(() => {});
        }
        this.updateToggleButton();
    },

    toggle() {
        this.init();
        this.muted = !this.muted;
        localStorage.setItem('cw_sound_muted', this.muted ? 'true' : 'false');
        this.updateToggleButton();
        if (!this.muted) {
            this.playTone(659.25, 0.15, 'sine', 0.18); // Soft pleasant ping on unmute
        }
    },

    updateToggleButton() {
        const btns = document.querySelectorAll('.sound-toggle-btn');
        btns.forEach(btn => {
            const isGameBtn = btn.classList.contains('game-sound-btn');
            if (this.muted) {
                btn.innerHTML = isGameBtn ? '🔇 <span class="sound-txt">Sound: OFF</span>' : '🔇 <span class="sound-txt">OFF</span>';
                btn.classList.add('muted');
            } else {
                btn.innerHTML = isGameBtn ? '🔊 <span class="sound-txt">Sound: ON</span>' : '🔊 <span class="sound-txt">ON</span>';
                btn.classList.remove('muted');
            }
        });
    },

    playTone(freq, duration = 0.2, type = 'sine', volume = 0.20, delay = 0) {
        if (this.muted) return;
        this.init();
        if (!this.ctx) return;

        try {
            const startTime = this.ctx.currentTime + delay;
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();

            osc.type = type;
            osc.frequency.setValueAtTime(freq, startTime);

            // Envelope: rapid attack, smooth sustain & natural decay
            gain.gain.setValueAtTime(0.0001, startTime);
            gain.gain.linearRampToValueAtTime(volume, startTime + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

            osc.connect(gain);
            gain.connect(this.ctx.destination);

            osc.start(startTime);
            osc.stop(startTime + duration);
        } catch (e) {
            // Audio error gracefully handled
        }
    },

    // 1. 🎵 Game Opening / Bet Section Ring Tone (Sparkling 5-Tone Casino Chime)
    playGameOpen() {
        if (this.muted) return;
        this.init();
        if (!this.ctx) return;

        const melody = [
            { f: 523.25, d: 0.22, t: 0.00 }, // C5
            { f: 659.25, d: 0.22, t: 0.10 }, // E5
            { f: 783.99, d: 0.25, t: 0.20 }, // G5
            { f: 987.77, d: 0.28, t: 0.30 }, // B5
            { f: 1046.50, d: 0.55, t: 0.40 } // C6
        ];

        melody.forEach(n => {
            this.playTone(n.f, n.d, 'triangle', 0.20, n.t);
            this.playTone(n.f * 1.5, n.d * 0.7, 'sine', 0.08, n.t); // crystal harmonic
        });
    },

    // 2. 🏆 Player Win Ring Tone (Triumphant Celebratory Victory Fanfare)
    playWin() {
        if (this.muted) return;
        this.init();
        if (!this.ctx) return;

        const fanfare = [
            { f: 523.25, d: 0.18, t: 0.00 }, // C5
            { f: 659.25, d: 0.18, t: 0.10 }, // E5
            { f: 783.99, d: 0.18, t: 0.20 }, // G5
            { f: 1046.50, d: 0.28, t: 0.30 }, // C6
            { f: 880.00, d: 0.20, t: 0.44 }, // A5
            { f: 1046.50, d: 0.22, t: 0.56 }, // C6
            { f: 1318.51, d: 0.70, t: 0.70 }  // E6
        ];

        fanfare.forEach(n => {
            this.playTone(n.f, n.d, 'triangle', 0.24, n.t);
            this.playTone(n.f * 2, n.d * 0.6, 'sine', 0.12, n.t); // bell overtone
        });

        // Cascading celebratory sparkles
        const sparkles = [1318.51, 1567.98, 1760.0, 2093.0];
        sparkles.forEach((f, idx) => {
            this.playTone(f, 0.25, 'sine', 0.15, 0.88 + idx * 0.08);
        });
    },

    // 3. 😔 Player Loss Ring Tone (Smooth Mellow Descending Chime ~2.8s)
    playLoss() {
        if (this.muted) return;
        this.init();
        if (!this.ctx) return;

        const lossNotes = [
            { f: 440.00, d: 0.65, t: 0.00 }, // A4
            { f: 392.00, d: 0.70, t: 0.55 }, // G4
            { f: 349.23, d: 0.75, t: 1.15 }, // F4
            { f: 293.66, d: 1.40, t: 1.80 }  // D4 (warm soft fade)
        ];

        lossNotes.forEach(n => {
            this.playTone(n.f, n.d, 'sine', 0.22, n.t);
            this.playTone(n.f * 0.5, n.d * 0.7, 'triangle', 0.15, n.t); // warm low body
        });
    },

    // 4. 🪙 Chip / Click Sound
    playChip() {
        if (this.muted) return;
        this.playTone(880, 0.08, 'sine', 0.14);
        this.playTone(1760, 0.05, 'triangle', 0.08, 0.02);
    }
};

// Helper: Toggle Password Visibility
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

// ─── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    // Unlock Web Audio on user gesture & sync toggle button state
    SoundFX.updateToggleButton();
    const unlockAudio = () => {
        SoundFX.init();
        document.removeEventListener('click', unlockAudio);
        document.removeEventListener('touchstart', unlockAudio);
    };
    document.addEventListener('click', unlockAudio, { once: true });
    document.addEventListener('touchstart', unlockAudio, { once: true });
    // Check referral code in URL
    const params = new URLSearchParams(window.location.search);
    const refCode = params.get('ref');
    if (refCode) {
        const refInput = document.getElementById('auth-referral');
        if (refInput) refInput.value = refCode;
        setAuthMode('register');
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
        authForm.addEventListener('submit', submitAuth);
    }

    if (token) {
        document.getElementById('auth-overlay').classList.add('hidden');
        initApp();
    }
});

function setAuthMode(mode) {
    isRegister = (mode === 'register');
    const tabLogin = document.getElementById('tab-login');
    const tabRegister = document.getElementById('tab-register');
    const regExtras = document.getElementById('register-extras');
    const forgotBox = document.getElementById('forgot-link-box');
    const authBtn = document.getElementById('auth-btn');
    const toggleLink = document.getElementById('toggle-auth');
    const toggleLabel = document.getElementById('auth-toggle-label');
    const errEl = document.getElementById('auth-error');

    if (errEl) {
        errEl.classList.add('hidden');
        errEl.textContent = '';
    }

    if (authBtn) {
        authBtn.disabled = false;
        authBtn.textContent = isRegister ? 'Register Account' : 'Login';
    }

    if (isRegister) {
        if (tabRegister) {
            tabRegister.style.background = 'var(--primary)';
            tabRegister.style.color = '#fff';
        }
        if (tabLogin) {
            tabLogin.style.background = 'transparent';
            tabLogin.style.color = 'var(--text-dim)';
        }
        if (regExtras) regExtras.classList.remove('hidden');
        if (forgotBox) forgotBox.classList.add('hidden');
        if (toggleLink) toggleLink.textContent = 'Login';
        if (toggleLabel) toggleLabel.textContent = 'Already have an account? ';
    } else {
        if (tabLogin) {
            tabLogin.style.background = 'var(--primary)';
            tabLogin.style.color = '#fff';
        }
        if (tabRegister) {
            tabRegister.style.background = 'transparent';
            tabRegister.style.color = 'var(--text-dim)';
        }
        if (regExtras) regExtras.classList.add('hidden');
        if (forgotBox) forgotBox.classList.remove('hidden');
        if (toggleLink) toggleLink.textContent = 'Register';
        if (toggleLabel) toggleLabel.textContent = "Don't have an account? ";
    }
}

async function submitAuth(e) {
    if (e && e.preventDefault) e.preventDefault();
    const username = document.getElementById('auth-username')?.value.trim();
    const password = document.getElementById('auth-password')?.value;
    const errEl = document.getElementById('auth-error');
    const authBtn = document.getElementById('auth-btn');

    if (errEl) {
        errEl.classList.add('hidden');
        errEl.textContent = '';
    }
    if (authBtn) {
        authBtn.disabled = false;
    }

    if (!username) {
        if (errEl) {
            errEl.textContent = '⚠️ Please enter your Username / User ID.';
            errEl.classList.remove('hidden');
        }
        return;
    }
    if (!password) {
        if (errEl) {
            errEl.textContent = '⚠️ Please enter your Password.';
            errEl.classList.remove('hidden');
        }
        return;
    }

    const rawPhone = document.getElementById('auth-phone')?.value || '';
    const phone = rawPhone.replace(/[^0-9]/g, '').replace(/^91(?=[0-9]{10}$)/, '').replace(/^0(?=[0-9]{10}$)/, '');
    const referralCode = document.getElementById('auth-referral')?.value.trim() || '';

    if (isRegister) {
        if (!phone) {
            if (errEl) {
                errEl.textContent = '⚠️ 10-digit Mobile number is mandatory. Duplicate accounts are not allowed.';
                errEl.classList.remove('hidden');
            }
            return;
        }
        if (!/^[0-9]{10}$/.test(phone)) {
            if (errEl) {
                errEl.textContent = '⚠️ Please enter a valid 10-digit mobile number (numbers only).';
                errEl.classList.remove('hidden');
            }
            return;
        }
        const tcCheckbox = document.getElementById('auth-tc');
        if (!tcCheckbox || !tcCheckbox.checked) {
            if (errEl) {
                errEl.textContent = '⚠️ Please accept the Terms & Conditions before registering.';
                errEl.classList.remove('hidden');
            }
            if (authBtn) {
                authBtn.disabled = false;
                authBtn.textContent = 'Register Account';
            }
            return;
        }
    }

    if (authBtn) {
        authBtn.disabled = true;
        authBtn.textContent = isRegister ? '⏳ Creating account...' : '⏳ Checking credentials...';
    }

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
        if (errEl) {
            errEl.textContent = err.message;
            errEl.classList.remove('hidden');
        }
    } finally {
        if (authBtn) {
            authBtn.disabled = false;
            authBtn.textContent = isRegister ? 'Register Account' : 'Login';
        }
    }
}

// ─── App Init ──────────────────────────────────────────────────────────────────
async function initApp() {
    await loadProfile();
    connectSocket();
    loadNotifications();
    loadDepositBank();
    loadColorHistory();
    loadHistory();
    loadReferrals();
    loadSupportInfo();
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

        if (elig.directWithdrawal || elig.isVip) {
            list.innerHTML = `<div class="elig-item"><span class="elig-icon">👑</span><span style="color:var(--gold);font-weight:700">Direct VIP Access Active (Referral & Deposit Targets Bypassed!)</span></div>`;
        } else {
            const checks = [
                { label: `Balance ≥ ₹300`, ok: elig.balance >= 300 },
                { label: `Total deposits ≥ ₹200 (₹${elig.totalDeposited})`, ok: elig.totalDeposited >= 200 },
                { label: `3+ active referrals (${elig.activeReferrals}/3)`, ok: elig.activeReferrals >= 3 }
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
        const gamePage = document.getElementById('page-game');
        if (gamePage && !gamePage.classList.contains('hidden')) {
            SoundFX.playGameOpen();
        }
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
        if (data.legCommissions) {
            const el1 = document.getElementById('leg1-earned');
            const el2 = document.getElementById('leg2-earned');
            const el3 = document.getElementById('leg3-earned');
            const el4 = document.getElementById('leg4-earned');
            if (el1 && data.legCommissions.leg1 !== undefined) el1.textContent = `₹${(data.legCommissions.leg1).toFixed(2)}`;
            if (el2 && data.legCommissions.leg2 !== undefined) el2.textContent = `₹${(data.legCommissions.leg2).toFixed(2)}`;
            if (el3 && data.legCommissions.leg3 !== undefined) el3.textContent = `₹${(data.legCommissions.leg3).toFixed(2)}`;
            if (el4 && data.legCommissions.leg4 !== undefined) el4.textContent = `₹${(data.legCommissions.leg4).toFixed(2)}`;
        }
    });

    socket.on('round:result', (data) => {
        addResultDot(data.result);
        loadColorHistory();
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
        if (!notif) return;
        if (notif.forAdmin || notif.targetUsername === 'Admin' || (notif.title && (notif.title.includes('OTP') || notif.title.includes('Pre-Login') || notif.title.includes('Ticket #TK-P')))) {
            return;
        }
        if (!notif.targetUserId || (currentUser && notif.targetUserId === currentUser.id)) {
            notifCount++;
            updateNotifBadge();
            addNotifToList(notif);
        }
    });

    socket.on('ticket:updated', (ticket) => {
        loadMyTickets();
        if (currentViewTicketId === ticket.id) {
            renderTicketConversation(ticket);
        }
    });

    socket.on('bank:lock_status', (data) => {
        if (!currentChannelsList || currentChannelsList.length === 0) return;
        const ch = currentChannelsList.find(c => c.id === data.bankId);
        if (ch) {
            ch.isAvailable = data.isAvailable;
            renderDepositChannels();
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
    SoundFX.playChip();
    document.querySelectorAll('.color-btn').forEach(b => {
        b.classList.toggle('selected', b.dataset.color === color);
    });
}

function setAmount(val) {
    document.getElementById('bet-amount').value = val;
    SoundFX.playChip();
    document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    if (window.event && window.event.target) window.event.target.classList.add('active');
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

    // 🔊 Audio Ringtone: Celebration fanfare for win, gentle 2.8s chime for loss
    if (data.won) {
        SoundFX.playWin();
    } else {
        SoundFX.playLoss();
    }

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

    if (name === 'game') {
        loadColorHistory();
        SoundFX.playGameOpen();
    }
    if (name === 'wallet') { loadProfile(); loadDepositBank(); }
    if (name === 'history') { loadColorHistory(); loadHistory(); }
    if (name === 'support') { loadSupportInfo(); loadMyTickets(); }
    if (name === 'profile') { loadProfile(); loadReferrals(); }
}

function showWalletTab(tab) {
    document.querySelectorAll('.wallet-panel').forEach(p => p.classList.add('hidden'));
    document.querySelectorAll('.w-tab').forEach(t => t.classList.remove('active'));
    document.getElementById(`wallet-${tab}`).classList.remove('hidden');
    event.target.classList.add('active');
}

// ─── Deposit Flow & Mandatory Screenshot ───────────────────────────────────────
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

let currentChannelsList = [];
let selectedDepositBankId = null;
let depositTimerInterval = null;

function onDepositAmountChange() {
    const amt = document.getElementById('deposit-amount')?.value || 200;
    const disp = document.getElementById('procedure-amount-display');
    if (disp) disp.textContent = '₹' + amt;
}

function setDepositAmount(val) {
    const inp = document.getElementById('deposit-amount');
    if (inp) {
        inp.value = val;
        onDepositAmountChange();
    }
}

async function loadDepositBank() {
    try {
        const res = await fetch(API + '/api/deposit/channels', { headers: authHeaders() });
        const data = await res.json();

        const stepSelect = document.getElementById('deposit-step-select');
        const stepProcedure = document.getElementById('deposit-step-procedure');
        const container = document.getElementById('deposit-channels-container');

        if (data.depositsPaused) {
            if (container) {
                container.innerHTML = '<div style="color:var(--gold);font-size:0.85rem;padding:12px">⚠️ Deposits are temporarily paused for bank reconciliation. Please check back shortly.</div>';
            }
            return;
        }

        // If this user already has an active locked session:
        if (data.activeLock && data.activeLock.bank) {
            renderProcedureScreen(data.activeLock.bank, data.upis || [], data.activeLock.amount, data.activeLock.expiresAt);
            if (stepSelect) stepSelect.classList.add('hidden');
            if (stepProcedure) stepProcedure.classList.remove('hidden');
            return;
        }

        // Otherwise show Step 1 (Channels Selection)
        if (stepSelect) stepSelect.classList.remove('hidden');
        if (stepProcedure) stepProcedure.classList.add('hidden');

        currentChannelsList = data.channels || [];
        renderDepositChannels();
    } catch {
        const container = document.getElementById('deposit-channels-container');
        if (container) {
            container.innerHTML = '<p class="loading-text">Failed to load deposit accounts. Please refresh.</p>';
        }
    }
}

function renderDepositChannels() {
    const container = document.getElementById('deposit-channels-container');
    if (!container) return;

    if (!currentChannelsList || currentChannelsList.length === 0) {
        container.innerHTML = '<p class="loading-text">No active deposit channels right now. Please contact support.</p>';
        return;
    }

    // Auto-select first available channel if none selected
    if (!selectedDepositBankId || !currentChannelsList.find(c => c.id === selectedDepositBankId && c.isAvailable)) {
        const firstAvail = currentChannelsList.find(c => c.isAvailable);
        if (firstAvail) selectedDepositBankId = firstAvail.id;
    }

    container.innerHTML = currentChannelsList.map(c => {
        const isSelected = (c.id === selectedDepositBankId);
        const cardStyle = c.isAvailable
            ? (isSelected
                ? 'background:rgba(108,92,231,0.2);border:2px solid var(--primary);cursor:pointer;'
                : 'background:rgba(255,255,255,0.04);border:1px solid var(--card-border);cursor:pointer;')
            : 'background:rgba(255,255,255,0.02);border:1px dashed rgba(255,255,255,0.1);opacity:0.6;cursor:not-allowed;';

        return `
            <div class="deposit-channel-card" onclick="${c.isAvailable ? `selectDepositChannel('${c.id}')` : `onTakenChannelClick('${c.id}')`}" style="padding:12px 14px;border-radius:10px;transition:all 0.2s;${cardStyle}">
                <div style="display:flex;justify-content:space-between;align-items:center">
                    <div>
                        <div style="font-weight:700;font-size:0.92rem;color:${isSelected ? '#fff' : 'var(--text)'}">
                            ${isSelected ? '👉 ' : ''}🏦 Channel: ${escapeHtml(c.name)}
                        </div>
                        <div style="font-size:0.75rem;color:var(--text-dim);margin-top:2px">
                            ${escapeHtml(c.bankName)} • ${escapeHtml(c.accountNumber)}
                        </div>
                    </div>
                    <div>
                        ${c.isAvailable 
                            ? `<span class="badge" style="background:rgba(46,204,113,0.18);color:#2ecc71;font-weight:700">🟢 Available</span>`
                            : `<span class="badge" style="background:rgba(231,76,60,0.18);color:var(--danger);font-weight:700">🔴 In Use</span>`}
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

function onTakenChannelClick(bankId) {
    const ch = (currentChannelsList || []).find(c => c.id === bankId);
    const bankName = ch ? (ch.name || 'This account') : 'This account';
    const collisionAlert = document.getElementById('deposit-collision-alert');
    if (collisionAlert) {
        collisionAlert.classList.remove('hidden');
        const sub = document.getElementById('collision-alert-sub');
        if (sub) {
            sub.textContent = `Account '${escapeHtml(bankName)}' is already taken by another player! Please select an available green account.`;
        }
    }
}

function selectDepositChannel(bankId) {
    selectedDepositBankId = bankId;
    renderDepositChannels();
    const collisionAlert = document.getElementById('deposit-collision-alert');
    if (collisionAlert) collisionAlert.classList.add('hidden');
}

async function lockSelectedDepositChannel() {
    const amtInput = document.getElementById('deposit-amount');
    const amount = Number(amtInput?.value || 0);

    if (!amount || amount < 200) {
        return showMsg('deposit-select-msg', 'Minimum deposit is ₹200', 'error');
    }

    const btn = document.getElementById('btn-lock-channel');
    if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ Reserving Account...';
    }

    const collisionAlert = document.getElementById('deposit-collision-alert');
    if (collisionAlert) collisionAlert.classList.add('hidden');

    try {
        const res = await fetch(API + '/api/deposit/lock-channel', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ bankId: selectedDepositBankId, amount })
        });
        const data = await res.json();

        if (res.status === 409 && data.code === 'ACCOUNT_TAKEN') {
            // Concurrency race: someone locked this account right as user clicked!
            if (collisionAlert) {
                collisionAlert.classList.remove('hidden');
                const sub = document.getElementById('collision-alert-sub');
                if (sub) {
                    sub.textContent = `Account '${data.takenBankName}' was just taken by another player! We have re-shuffled and highlighted another account for you.`;
                }
            }
            if (data.nextBank && data.nextBank.id) {
                selectedDepositBankId = data.nextBank.id;
            }
            await loadDepositBank();
            return;
        }

        if (!res.ok) throw new Error(data.error || 'Failed to lock account');

        // Success: Account is locked! Render Procedure screen (Image 2)
        renderProcedureScreen(data.bank, data.upis || [], data.amount, data.expiresAt);
        document.getElementById('deposit-step-select').classList.add('hidden');
        document.getElementById('deposit-step-procedure').classList.remove('hidden');

    } catch (err) {
        showMsg('deposit-select-msg', err.message, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '⚡ Pay Now (Lock Payment Channel)';
        }
    }
}

function renderProcedureScreen(bank, upis, amount, expiresAt) {
    currentAssignedAccountName = bank ? (bank.name || bank.accountHolder) : 'Main Gateway';
    const disp = document.getElementById('procedure-amount-display');
    if (disp) disp.textContent = `₹${amount}`;

    const infoEl = document.getElementById('deposit-bank-info');
    if (infoEl && bank) {
        let html = '';
        html += `<h4>🏦 Assigned Bank Account (Session Active)</h4>`;
        html += `<div class="bank-detail"><span class="label">Name</span><span>${escapeHtml(bank.name || bank.accountHolder || '-')}</span></div>`;
        html += `<div class="bank-detail"><span class="label">Account</span><span>${escapeHtml(bank.accountNumber || '-')}</span><button type="button" class="btn-copy" onclick="navigator.clipboard.writeText('${bank.accountNumber}');alert('Account number copied!')">📋 Copy</button></div>`;
        html += `<div class="bank-detail"><span class="label">IFSC</span><span>${escapeHtml(bank.ifscCode || bank.ifsc || '-')}</span><button type="button" class="btn-copy" onclick="navigator.clipboard.writeText('${bank.ifscCode || bank.ifsc}');alert('IFSC copied!')">📋 Copy</button></div>`;
        if (bank.upiId) {
            html += `<div class="bank-detail"><span class="label">UPI</span><span>${escapeHtml(bank.upiId)}</span><button type="button" class="btn-copy" onclick="navigator.clipboard.writeText('${bank.upiId}');alert('UPI copied!')">📋 Copy</button></div>`;
        }

        if (upis && upis.length > 0) {
            html += `<div class="upi-list" style="margin-top:10px"><h4>📲 Fast UPI Option</h4>`;
            upis.forEach(u => {
                html += `<div class="upi-item"><div><div style="font-size:0.75rem;color:var(--text-dim)">${escapeHtml(u.name || 'UPI')}</div><div class="upi-val">${escapeHtml(u.upiId)}</div></div><button type="button" class="btn-copy" onclick="navigator.clipboard.writeText('${u.upiId}');alert('UPI ID copied!')">📋 Copy</button></div>`;
            });
            html += `</div>`;
        }
        infoEl.innerHTML = html;
    }

    startDepositTimer(expiresAt);
}

function startDepositTimer(expiresAt) {
    if (depositTimerInterval) clearInterval(depositTimerInterval);
    const timerEl = document.getElementById('deposit-lock-timer');

    function update() {
        const remaining = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
        const mins = Math.floor(remaining / 60).toString().padStart(2, '0');
        const secs = (remaining % 60).toString().padStart(2, '0');
        if (timerEl) timerEl.textContent = `⏱️ ${mins}:${secs}`;

        if (remaining <= 0) {
            clearInterval(depositTimerInterval);
            alert('⚠️ Your payment session has expired (15 minutes). The account has been released for other players.');
            cancelAndReleaseLock();
        }
    }

    update();
    depositTimerInterval = setInterval(update, 1000);
}

async function cancelAndReleaseLock() {
    if (depositTimerInterval) clearInterval(depositTimerInterval);
    try {
        await fetch(API + '/api/deposit/release-lock', {
            method: 'POST',
            headers: authHeaders()
        });
    } catch {}

    const stepSelect = document.getElementById('deposit-step-select');
    const stepProcedure = document.getElementById('deposit-step-procedure');
    if (stepProcedure) stepProcedure.classList.add('hidden');
    if (stepSelect) stepSelect.classList.remove('hidden');

    loadDepositBank();
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

        if (depositTimerInterval) clearInterval(depositTimerInterval);
        setTimeout(() => {
            const stepSelect = document.getElementById('deposit-step-select');
            const stepProcedure = document.getElementById('deposit-step-procedure');
            if (stepProcedure) stepProcedure.classList.add('hidden');
            if (stepSelect) stepSelect.classList.remove('hidden');
            loadDepositBank();
        }, 2000);
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

// ─── Referrals & Commission Ledger (4 Legs) ──────────────────────────────────
async function loadReferrals() {
    try {
        const res = await fetch(API + '/api/my-referrals', { headers: authHeaders() });
        const data = await res.json();
        
        // 4 Legs Breakdown
        if (data.legs) {
            const l1 = data.legs.leg1 || { count: 0, earned: 0 };
            const l2 = data.legs.leg2 || { count: 0, earned: 0 };
            const l3 = data.legs.leg3 || { count: 0, earned: 0 };
            const l4 = data.legs.leg4 || { count: 0, earned: 0 };

            const elL1Count = document.getElementById('leg1-count');
            const elL1Earned = document.getElementById('leg1-earned');
            if (elL1Count) elL1Count.textContent = l1.count;
            if (elL1Earned) elL1Earned.textContent = `₹${l1.earned}`;

            const elL2Count = document.getElementById('leg2-count');
            const elL2Earned = document.getElementById('leg2-earned');
            if (elL2Count) elL2Count.textContent = l2.count;
            if (elL2Earned) elL2Earned.textContent = `₹${l2.earned}`;

            const elL3Count = document.getElementById('leg3-count');
            const elL3Earned = document.getElementById('leg3-earned');
            if (elL3Count) elL3Count.textContent = l3.count;
            if (elL3Earned) elL3Earned.textContent = `₹${l3.earned}`;

            const elL4Count = document.getElementById('leg4-count');
            const elL4Earned = document.getElementById('leg4-earned');
            if (elL4Count) elL4Count.textContent = l4.count;
            if (elL4Earned) elL4Earned.textContent = `₹${l4.earned}`;
        }

        const refTotal = document.getElementById('ref-total');
        const refActive = document.getElementById('ref-active');
        if (refTotal) refTotal.textContent = data.leg1Count || (data.referrals ? data.referrals.length : 0);
        if (refActive) refActive.textContent = data.activeCount || 0;

        const list = document.getElementById('ref-list');
        if (list) {
            const directRefs = data.referrals || [];
            if (directRefs.length === 0) {
                list.innerHTML = '<div class="empty-state" style="padding:10px">No direct referrals yet. Share your code!</div>';
            } else {
                list.innerHTML = directRefs.map(r => `
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
        }
    } catch {}
}

// ─── Forgot Password OTP Flow ──────────────────────────────────────────────────
let forgotPasswordUserId = null;

function openTcModal(e) {
    if (e && e.preventDefault) e.preventDefault();
    document.getElementById('tc-modal').classList.remove('hidden');
}

function closeTcModal() {
    document.getElementById('tc-modal').classList.add('hidden');
}

function openForgotModal(e) {
    if (e && e.preventDefault) e.preventDefault();
    resetForgotModalToStep1();
    document.getElementById('forgot-modal').classList.remove('hidden');
}

function closeForgotModal() {
    document.getElementById('forgot-modal').classList.add('hidden');
}

function resetForgotModalToStep1() {
    forgotPasswordUserId = null;
    const step1 = document.getElementById('forgot-step-1');
    const step2 = document.getElementById('forgot-step-2');
    const msg = document.getElementById('forgot-msg');
    if (step1) step1.classList.remove('hidden');
    if (step2) step2.classList.add('hidden');
    if (msg) msg.classList.add('hidden');
    const input = document.getElementById('forgot-identifier');
    if (input) input.value = '';
    const otpInput = document.getElementById('forgot-otp-input');
    if (otpInput) otpInput.value = '';
    const newPassInput = document.getElementById('forgot-new-password');
    if (newPassInput) newPassInput.value = '';
}

async function sendForgotPasswordOTP() {
    const identifier = document.getElementById('forgot-identifier').value.trim();
    if (!identifier) return showMsg('forgot-msg', 'Please enter your registered 10-digit Mobile Number', 'error');
    if (!/^[0-9]{10}$/.test(identifier)) return showMsg('forgot-msg', 'Please enter a valid 10-digit mobile number (numbers only)', 'error');

    const btn = document.getElementById('btn-send-otp');
    btn.disabled = true;
    btn.textContent = '⏳ Sending OTP...';

    try {
        const res = await fetch(API + '/api/forgot-password/send-otp', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identifier })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        forgotPasswordUserId = data.userId;
        document.getElementById('forgot-step-1').classList.add('hidden');
        document.getElementById('forgot-step-2').classList.remove('hidden');
        
        // 🔒 SECURE: OTP IS NEVER DISPLAYED ON SCREEN OR IN CLIENT PAYLOAD
        const destSpan = document.getElementById('otp-masked-dest');
        if (destSpan) {
            destSpan.innerHTML = `6-digit verification code dispatched to <strong>${data.maskedPhone || 'your mobile'}</strong> (@${data.username}). Please check your SMS.`;
        }
        showMsg('forgot-msg', data.message || 'OTP sent successfully to registered mobile number', 'success');
    } catch (err) {
        showMsg('forgot-msg', err.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = '📲 Send 6-Digit OTP';
    }
}

async function submitVerifyResetPassword() {
    if (!forgotPasswordUserId) return showMsg('forgot-msg', 'Session expired. Please request OTP again.', 'error');
    const otp = document.getElementById('forgot-otp-input').value.trim();
    const newPassword = document.getElementById('forgot-new-password').value;

    if (!otp || otp.length !== 6) return showMsg('forgot-msg', 'Please enter the 6-digit OTP code', 'error');
    if (!newPassword || newPassword.length < 4) return showMsg('forgot-msg', 'New password must be at least 4 characters', 'error');

    const btn = document.getElementById('btn-reset-pass');
    btn.disabled = true;
    btn.textContent = '⏳ Verifying...';

    try {
        const res = await fetch(API + '/api/forgot-password/verify-reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: forgotPasswordUserId,
                otp,
                newPassword
            })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        alert('🎉 Password reset successful! You can now log in with your new password.');
        closeForgotModal();
        const usernameInput = document.getElementById('auth-username');
        if (usernameInput) usernameInput.value = '';
    } catch (err) {
        showMsg('forgot-msg', err.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = '✅ Verify OTP & Reset Password';
    }
}

// ─── Color Outcome History ─────────────────────────────────────────────────────
async function loadColorHistory() {
    try {
        const res = await fetch(API + '/api/color-history');
        const list = await res.json();

        // 1. Update Game Screen Recent 10 Winning Colors
        const recentContainer = document.getElementById('game-recent-colors-list');
        if (recentContainer) {
            if (list.length === 0) {
                recentContainer.innerHTML = '<span style="font-size:0.75rem;color:var(--text-dim)">Round outcomes will appear here...</span>';
            } else {
                recentContainer.innerHTML = list.slice(0, 10).map(r => `
                    <div style="flex:0 0 auto;display:flex;flex-direction:column;align-items:center;background:rgba(255,255,255,0.04);border:1px solid var(--card-border);border-radius:10px;padding:6px 10px;min-width:55px">
                        <span style="font-size:0.65rem;color:var(--text-dim)">#${String(r.id).slice(-4)}</span>
                        <div class="strip-dot ${r.result}" style="width:28px;height:28px;font-size:0.75rem;margin:4px 0">${r.result.charAt(0).toUpperCase()}</div>
                        <span style="font-size:0.7rem;font-weight:700;text-transform:capitalize;color:${r.result === 'red' ? '#e74c3c' : r.result === 'green' ? '#2ecc71' : '#9b59b6'}">${r.result}</span>
                    </div>
                `).join('');
            }
        }

        // 2. Update History Screen Table
        const tbody = document.getElementById('game-outcomes-tbody');
        if (tbody) {
            if (list.length === 0) {
                tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;padding:20px;color:var(--text-dim)">No game rounds settled yet</td></tr>';
            } else {
                tbody.innerHTML = list.map(r => `
                    <tr style="border-bottom:1px solid rgba(255,255,255,0.05)">
                        <td style="padding:10px 8px;font-family:monospace;font-weight:700">#${String(r.id).slice(-6)}</td>
                        <td style="padding:10px 8px;text-align:center">
                            <span class="badge" style="background:${r.result === 'red' ? 'rgba(231,76,60,0.2)' : r.result === 'green' ? 'rgba(46,204,113,0.2)' : 'rgba(155,89,182,0.2)'};color:${r.result === 'red' ? '#e74c3c' : r.result === 'green' ? '#2ecc71' : '#9b59b6'};font-weight:700;text-transform:uppercase;padding:4px 10px;border-radius:6px">
                                ${r.result === 'red' ? '🔴 RED' : r.result === 'green' ? '🟢 GREEN' : '🟣 VIOLET'}
                            </span>
                        </td>
                        <td style="padding:10px 8px;text-align:right;font-size:0.75rem;color:var(--text-dim)">${new Date(r.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
                    </tr>
                `).join('');
            }
        }
    } catch {}
}

function switchHistoryTab(tab) {
    const gamePanel = document.getElementById('panel-game-history');
    const myPanel = document.getElementById('panel-my-history');
    const tabGame = document.getElementById('tab-game-outcomes');
    const tabMy = document.getElementById('tab-my-bets');

    if (tab === 'game') {
        if (gamePanel) gamePanel.classList.remove('hidden');
        if (myPanel) myPanel.classList.add('hidden');
        if (tabGame) tabGame.classList.add('active');
        if (tabMy) tabMy.classList.remove('active');
        loadColorHistory();
    } else {
        if (gamePanel) gamePanel.classList.add('hidden');
        if (myPanel) myPanel.classList.remove('hidden');
        if (tabGame) tabGame.classList.remove('active');
        if (tabMy) tabMy.classList.add('active');
        loadHistory();
    }
}

// ─── Dynamic Support Info ──────────────────────────────────────────────────────
async function loadSupportInfo() {
    try {
        const res = await fetch(API + '/api/support-info');
        const data = await res.json();

        const channelsList = document.getElementById('support-channels-list');
        if (channelsList && data.contacts) {
            channelsList.innerHTML = data.contacts.map(c => `
                <a href="${c.link}" target="_blank" class="support-item ${c.type}">
                    <div class="support-icon">${c.type === 'email' ? '✉️' : '📱'}</div>
                    <div class="support-detail">
                        <div class="support-label">${c.title}</div>
                        <div class="support-value">${c.value}</div>
                    </div>
                    <div class="support-arrow">→</div>
                </a>
            `).join('');
        }

        const groupsList = document.getElementById('support-groups-list');
        if (groupsList && data.groups) {
            groupsList.innerHTML = data.groups.map(g => `
                <a href="${g.link}" target="_blank" class="support-item" style="border:1px solid rgba(108,92,231,0.3);background:rgba(108,92,231,0.08)">
                    <div class="support-icon">🚀</div>
                    <div class="support-detail">
                        <div class="support-label">${g.title}</div>
                        <div class="support-value" style="color:var(--primary);font-size:0.8rem">Click to Join Official Community</div>
                    </div>
                    <div class="support-arrow">→</div>
                </a>
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
    if (!notif) return;
    // Strict block on client: never render admin or OTP notifications
    if (notif.forAdmin || notif.targetUsername === 'Admin' || (notif.title && (notif.title.includes('OTP') || notif.title.includes('Pre-Login') || notif.title.includes('Ticket #TK-P')))) {
        return;
    }
    const list = document.getElementById('notif-list');
    if (!list) return;
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

// ─── Helpdesk & Support Tickets (User Side) ────────────────────────────────────
let currentViewTicketId = null;
let myCachedTickets = [];

function openRaiseTicketModal() {
    document.getElementById('ticket-subject').value = '';
    document.getElementById('ticket-ref').value = '';
    document.getElementById('ticket-message').value = '';
    const msg = document.getElementById('raise-ticket-msg');
    if (msg) msg.classList.add('hidden');
    document.getElementById('raise-ticket-modal').classList.remove('hidden');
}

function closeRaiseTicketModal() {
    document.getElementById('raise-ticket-modal').classList.add('hidden');
}

async function submitNewTicket() {
    const category = document.getElementById('ticket-category').value;
    const subject = document.getElementById('ticket-subject').value.trim();
    const referenceId = document.getElementById('ticket-ref').value.trim();
    const message = document.getElementById('ticket-message').value.trim();

    if (!subject || !message) {
        return showMsg('raise-ticket-msg', 'Please enter subject and message', 'error');
    }

    try {
        const res = await fetch(API + '/api/tickets/create', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ category, subject, message, referenceId })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        showMsg('raise-ticket-msg', `Ticket #${data.ticket.ticketNumber} submitted! Staff will respond shortly.`, 'success');
        setTimeout(() => {
            closeRaiseTicketModal();
            loadMyTickets();
        }, 1200);
    } catch (err) {
        showMsg('raise-ticket-msg', err.message, 'error');
    }
}

async function loadMyTickets() {
    if (!token) return;
    try {
        const res = await fetch(API + '/api/tickets/my', { headers: authHeaders() });
        const list = await res.json();
        myCachedTickets = list || [];
        const container = document.getElementById('my-tickets-container');
        if (!container) return;

        if (myCachedTickets.length === 0) {
            container.innerHTML = '<div style="padding:14px;text-align:center;color:var(--text-dim);font-size:0.8rem">No support tickets raised yet. Click "➕ Raise Ticket" if you need help with a transaction.</div>';
            return;
        }

        const statusBadges = {
            open: '<span class="badge" style="background:rgba(241,196,15,0.2);color:#f1c40f">🟡 Open</span>',
            in_progress: '<span class="badge" style="background:rgba(52,152,219,0.2);color:#3498db">🔵 In Progress</span>',
            resolved: '<span class="badge" style="background:rgba(46,204,113,0.2);color:#2ecc71">🟢 Resolved</span>',
            closed: '<span class="badge" style="background:rgba(255,255,255,0.1);color:var(--text-dim)">⚪ Closed</span>'
        };

        const catIcons = {
            deposit: '💳 Deposit',
            withdrawal: '💸 Withdrawal',
            game: '🎮 Game',
            account: '👤 Account',
            other: '❓ General'
        };

        container.innerHTML = myCachedTickets.map(t => {
            const repliesCount = (t.messages || []).length;
            const lastMsg = t.messages && t.messages.length > 0 ? t.messages[t.messages.length - 1] : null;
            const badge = statusBadges[t.status] || `<span class="badge">${t.status}</span>`;

            return `
                <div class="ticket-user-card" onclick="openViewTicketModal('${t.id}')">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
                        <span style="font-size:0.75rem;font-weight:700;color:var(--primary)">#${t.ticketNumber} • ${catIcons[t.category] || t.category}</span>
                        ${badge}
                    </div>
                    <div style="font-weight:600;font-size:0.85rem;color:#fff;margin-bottom:4px">${escapeHtml(t.subject)}</div>
                    <div style="display:flex;justify-content:space-between;align-items:center;font-size:0.72rem;color:var(--text-dim)">
                        <span>💬 ${repliesCount} message(s)${lastMsg ? ` • Last from ${lastMsg.sender === 'admin' ? '🛡️ ' + lastMsg.senderName : 'You'}` : ''}</span>
                        <span>${new Date(t.updatedAt || t.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                </div>
            `;
        }).join('');
    } catch {}
}

function openViewTicketModal(ticketId) {
    const t = myCachedTickets.find(item => item.id === ticketId);
    if (!t) return;
    currentViewTicketId = ticketId;

    document.getElementById('vt-title').textContent = `Ticket #${t.ticketNumber}`;
    document.getElementById('vt-subject').textContent = t.subject;

    const refBox = document.getElementById('vt-ref-box');
    const refEl = document.getElementById('vt-ref');
    if (t.referenceId) {
        refEl.textContent = t.referenceId;
        refBox.classList.remove('hidden');
    } else {
        refBox.classList.add('hidden');
    }

    renderTicketConversation(t);
    document.getElementById('vt-reply-input').value = '';
    const msg = document.getElementById('vt-reply-msg');
    if (msg) msg.classList.add('hidden');

    document.getElementById('view-ticket-modal').classList.remove('hidden');
}

function renderTicketConversation(t) {
    const badgeEl = document.getElementById('vt-status-badge');
    if (badgeEl) {
        badgeEl.textContent = t.status.toUpperCase().replace('_', ' ');
        badgeEl.style.background = t.status === 'resolved' ? 'rgba(46,204,113,0.2)' : t.status === 'in_progress' ? 'rgba(52,152,219,0.2)' : 'rgba(241,196,15,0.2)';
        badgeEl.style.color = t.status === 'resolved' ? '#2ecc71' : t.status === 'in_progress' ? '#3498db' : '#f1c40f';
    }

    const thread = document.getElementById('vt-thread');
    if (!thread) return;

    thread.innerHTML = (t.messages || []).map(m => {
        const isUser = m.sender === 'user';
        return `
            <div class="ticket-bubble ${isUser ? 'bubble-user' : 'bubble-admin'}">
                <div style="font-weight:700;font-size:0.75rem;margin-bottom:2px;opacity:0.9">${isUser ? 'You' : '🛡️ ' + escapeHtml(m.senderName || 'Staff')}</div>
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

function closeViewTicketModal() {
    document.getElementById('view-ticket-modal').classList.add('hidden');
    currentViewTicketId = null;
}

async function submitTicketReplyUser() {
    if (!currentViewTicketId) return;
    const input = document.getElementById('vt-reply-input');
    const message = input.value.trim();
    if (!message) return;

    try {
        const res = await fetch(`${API}/api/tickets/${currentViewTicketId}/reply`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ message })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        input.value = '';
        const idx = myCachedTickets.findIndex(t => t.id === currentViewTicketId);
        if (idx !== -1) myCachedTickets[idx] = data.ticket;
        renderTicketConversation(data.ticket);
        loadMyTickets();
    } catch (err) {
        showMsg('vt-reply-msg', err.message, 'error');
    }
}

// ─── Public Pre-Login Ticket Functions ─────────────────────────────────────────
function openPublicTicketModal(e) {
    if (e && e.preventDefault) e.preventDefault();
    const uInput = document.getElementById('ptk-username');
    const pInput = document.getElementById('ptk-phone');
    const mInput = document.getElementById('ptk-message');
    const authUser = document.getElementById('auth-username')?.value.trim();

    if (uInput) uInput.value = authUser || '';
    if (pInput) pInput.value = '';
    if (mInput) mInput.value = '';

    const msg = document.getElementById('ptk-msg');
    if (msg) msg.classList.add('hidden');
    const successBox = document.getElementById('ptk-success-box');
    if (successBox) successBox.classList.add('hidden');

    document.getElementById('public-ticket-modal').classList.remove('hidden');
}

function closePublicTicketModal() {
    document.getElementById('public-ticket-modal').classList.add('hidden');
}

async function submitPublicTicket() {
    const username = document.getElementById('ptk-username').value.trim();
    const phone = document.getElementById('ptk-phone').value.trim();
    const reason = document.getElementById('ptk-reason').value;
    const message = document.getElementById('ptk-message').value.trim();

    if (!username) return showMsg('ptk-msg', 'Please enter your Username / User ID', 'error');
    if (!phone) return showMsg('ptk-msg', 'Please enter your registered 10-digit Mobile number', 'error');
    if (!/^[0-9]{10}$/.test(phone)) return showMsg('ptk-msg', 'Mobile number must be exactly 10 digits', 'error');

    const btn = document.getElementById('btn-submit-ptk');
    btn.disabled = true;
    btn.textContent = '⏳ Submitting Ticket...';

    try {
        const res = await fetch(API + '/api/tickets/public-request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, phone, reason, message })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        document.getElementById('ptk-created-num').textContent = `#${data.ticketNumber}`;
        const waBtn = document.getElementById('ptk-wa-btn');
        if (waBtn && data.waLink) {
            waBtn.href = data.waLink;
        }

        document.getElementById('ptk-success-box').classList.remove('hidden');
        showMsg('ptk-msg', 'Ticket created! Support has been notified.', 'success');
    } catch (err) {
        showMsg('ptk-msg', err.message, 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = '🚀 Submit Support Ticket';
    }
}

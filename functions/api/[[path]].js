const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,X-Access-Key,X-Admin-Key",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function err(msg, status = 400) {
  return json({ error: msg }, status);
}

// ─── Database helpers ────────────────────────────────────────────
async function initDB(db) {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      balance REAL NOT NULL DEFAULT 0,
      last_change REAL NOT NULL DEFAULT 0,
      last_updated INTEGER NOT NULL,
      is_system INTEGER DEFAULT 0
    )`
  ).run();

  const sys = await db.prepare("SELECT id FROM accounts WHERE id = 'system'").first();
  if (!sys) {
    await db.prepare(
      `INSERT INTO accounts (id, name, balance, last_change, last_updated, is_system)
       VALUES ('system', 'System', 0, 0, ?, 1)`
    ).bind(Date.now()).run();
  }
}

// ─── Interest logic ──────────────────────────────────────────────
const POS_PERIOD_MS = 16 * 3600 * 1000;   // 16 hours
const POS_RATE      = 0.01;              // 1%
const NEG_PERIOD_MS = 24 * 3600 * 1000;  // 24 hours
const NEG_RATE      = 0.02;              // 2%

async function applyAccruedInterest(db) {
  const now = Date.now();
  const rows = await db.prepare("SELECT * FROM accounts WHERE is_system = 0").all();

  for (const a of rows.results) {
    let bal = a.balance;
    let last = a.last_updated;
    let totalChange = 0;

    if (bal > 0) {
      const elapsed = now - last;
      const periods = Math.floor(elapsed / POS_PERIOD_MS);
      if (periods > 0) {
        const factor = Math.pow(1 + POS_RATE, periods);
        const newBal = Math.round(bal * factor * 100) / 100;
        totalChange = Math.round((newBal - bal) * 100) / 100;
        bal = newBal;
        last += periods * POS_PERIOD_MS;
      }
    } else if (bal < 0) {
      const elapsed = now - last;
      const periods = Math.floor(elapsed / NEG_PERIOD_MS);
      if (periods > 0) {
        const factor = Math.pow(1 + NEG_RATE, periods);
        const newBal = Math.round(bal * factor * 100) / 100;
        totalChange = Math.round((newBal - bal) * 100) / 100;
        bal = newBal;
        last += periods * NEG_PERIOD_MS;
      }
    }

    if (totalChange !== 0) {
      await db.prepare(
        `UPDATE accounts SET balance = ?, last_change = ?, last_updated = ? WHERE id = ?`
      ).bind(bal, totalChange, last, a.id).run();
    }
  }
}

// ─── Tax on positive adjustment ──────────────────────────────────
function applyTax(amount) {
  if (amount <= 0) return amount;
  const taxPercent = 10 * Math.log10(amount + 1) / Math.log10(11);
  const tax = amount * (taxPercent / 100);
  return Math.round((amount - tax) * 100) / 100;
}

// ─── ID generator ─────────────────────────────────────────────────
function newId() {
  return "acct_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
}

// ─── The full app HTML (served after authentication) ────────────
function getAppHTML(accessKey) {
  const safeKey = JSON.stringify(accessKey);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Ledger</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet" />
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --bg:        #0d0f0e;
  --surface:   #141817;
  --border:    #232927;
  --border2:   #2e3431;
  --green:     #00c853;
  --green-dim: #00832e;
  --red:       #ff3b30;
  --red-dim:   #8b1a14;
  --text:      #f0ede8;
  --text-dim:  #7a8580;
  --text-mid:  #b0b8b4;
  --row-hover: #1a1f1e;
}

body {
  background: var(--bg);
  color: var(--text);
  font-family: 'Inter', sans-serif;
  min-height: 100vh;
  overflow-x: hidden;
}

/* ══════════════════════════════════════
   HEADER
══════════════════════════════════════ */
header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 32px;
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  background: var(--bg);
  z-index: 100;
}

.logo {
  font-family: 'JetBrains Mono', monospace;
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--green);
}
.logo span { color: var(--text-dim); font-weight: 400; }

.header-right { display: flex; align-items: center; gap: 12px; }

.admin-badge {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--green);
  border: 1px solid var(--green-dim);
  padding: 4px 10px;
  border-radius: 4px;
  background: rgba(0,200,83,0.07);
}

.auth-area { display: flex; align-items: center; gap: 8px; }

.auth-input {
  background: var(--surface);
  border: 1px solid var(--border2);
  color: var(--text);
  font-family: 'JetBrains Mono', monospace;
  font-size: 13px;
  padding: 7px 13px;
  border-radius: 6px;
  outline: none;
  width: 170px;
  transition: border-color 0.2s;
}
.auth-input::placeholder { color: var(--text-dim); }
.auth-input:focus { border-color: var(--green-dim); }

/* ══════════════════════════════════════
   SUMMARY BAR
══════════════════════════════════════ */
.summary-bar {
  display: flex;
  border-bottom: 1px solid var(--border);
  padding: 0 32px;
  overflow-x: auto;
}

.stat-cell {
  padding: 16px 28px 16px 0;
  margin-right: 28px;
  border-right: 1px solid var(--border);
  min-width: 130px;
  flex-shrink: 0;
}
.stat-cell:last-child { border-right: none; }

.stat-label {
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text-dim);
  margin-bottom: 5px;
}

.stat-value {
  font-family: 'JetBrains Mono', monospace;
  font-size: 19px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 5px;
}
.stat-value.pos { color: var(--green); }
.stat-value.neg { color: var(--red); }
.stat-value.neutral { color: var(--text); }

/* ══════════════════════════════════════
   BEAN ICON
══════════════════════════════════════ */
.bean {
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
}
.bean svg { display: block; }

/* ══════════════════════════════════════
   WEEKLY NOTE – updated to reflect new intervals
══════════════════════════════════════ */
.weekly-note {
  font-size: 11px;
  color: var(--text-dim);
  padding: 9px 32px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 8px;
}
.weekly-note .dot {
  width: 6px; height: 6px;
  background: var(--green);
  border-radius: 50%;
  flex-shrink: 0;
  animation: pulse 2.4s infinite;
}
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.25} }

/* ══════════════════════════════════════
   TABLE
══════════════════════════════════════ */
.table-wrapper { padding: 0 32px 40px; overflow-x: auto; }

.controls {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 18px 0 13px;
  gap: 10px;
  flex-wrap: wrap;
}

.section-title {
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-dim);
  font-weight: 500;
}

table {
  width: 100%;
  border-collapse: collapse;
  min-width: 580px;
}

thead th {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--text-dim);
  text-align: left;
  padding: 9px 16px;
  border-bottom: 1px solid var(--border2);
  white-space: nowrap;
  background: var(--bg);
}
thead th.num { text-align: right; }

tbody tr {
  border-bottom: 1px solid var(--border);
  transition: background 0.1s;
}
tbody tr:hover { background: var(--row-hover); }

tbody td {
  padding: 13px 16px;
  font-size: 14px;
  vertical-align: middle;
  white-space: nowrap;
}

.col-idx {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--text-dim);
  width: 36px;
}

.col-name { font-weight: 500; min-width: 150px; }
.col-name small {
  display: block;
  font-size: 11px;
  color: var(--text-dim);
  font-weight: 400;
  margin-top: 2px;
}
.col-name .system-tag {
  font-size: 9px;
  background: var(--border2);
  padding: 2px 8px;
  border-radius: 3px;
  color: var(--text-dim);
  margin-left: 6px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.col-balance {
  font-family: 'JetBrains Mono', monospace;
  font-size: 15px;
  font-weight: 600;
  text-align: right;
}
.col-balance.pos { color: var(--green); }
.col-balance.neg { color: var(--red); }

.col-change {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  text-align: right;
}

.col-updated {
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  color: var(--text-dim);
  min-width: 130px;
}

.col-actions { text-align: right; width: 1%; }

.action-btns {
  display: flex;
  gap: 5px;
  justify-content: flex-end;
  opacity: 0;
  transition: opacity 0.12s;
}
tr:hover .action-btns { opacity: 1; }

/* ══════════════════════════════════════
   EMPTY + LOADING
══════════════════════════════════════ */
.empty-state {
  padding: 60px 16px;
  text-align: center;
  color: var(--text-dim);
}
.empty-state .icon { font-size: 34px; margin-bottom: 10px; }
.empty-state p { font-size: 14px; margin-bottom: 16px; }

.loading-row td {
  text-align: center;
  padding: 48px;
  color: var(--text-dim);
  font-size: 13px;
  letter-spacing: 0.06em;
}

/* ══════════════════════════════════════
   MODALS
══════════════════════════════════════ */
.modal-backdrop {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.72);
  z-index: 500;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.modal-backdrop.open { display: flex; }

.modal {
  background: var(--surface);
  border: 1px solid var(--border2);
  border-radius: 12px;
  padding: 30px;
  width: 100%;
  max-width: 400px;
  position: relative;
}

.modal h2 { font-size: 16px; font-weight: 600; margin-bottom: 4px; }
.modal .modal-sub { font-size: 13px; color: var(--text-dim); margin-bottom: 22px; }

.field { margin-bottom: 14px; }
.field label {
  display: block;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-dim);
  margin-bottom: 6px;
}
.field input {
  width: 100%;
  background: var(--bg);
  border: 1px solid var(--border2);
  color: var(--text);
  font-family: 'JetBrains Mono', monospace;
  font-size: 14px;
  padding: 10px 13px;
  border-radius: 7px;
  outline: none;
  transition: border-color 0.2s;
}
.field input:focus { border-color: var(--green-dim); }

.modal-actions {
  display: flex;
  gap: 9px;
  justify-content: flex-end;
  margin-top: 22px;
}

.close-modal {
  position: absolute;
  top: 14px; right: 16px;
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 20px;
  cursor: pointer;
  padding: 4px;
  line-height: 1;
}
.close-modal:hover { color: var(--text); }

.error-msg {
  font-size: 12px;
  color: var(--red);
  min-height: 16px;
  margin-top: 6px;
}

/* ══════════════════════════════════════
   TOAST
══════════════════════════════════════ */
#toast {
  position: fixed;
  bottom: 26px;
  left: 50%;
  transform: translateX(-50%) translateY(80px);
  background: var(--surface);
  border: 1px solid var(--border2);
  color: var(--text);
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  padding: 10px 20px;
  border-radius: 8px;
  z-index: 9999;
  transition: transform 0.3s cubic-bezier(.34,1.56,.64,1);
  pointer-events: none;
  white-space: nowrap;
}
#toast.show { transform: translateX(-50%) translateY(0); }

/* ══════════════════════════════════════
   SCROLLBAR
══════════════════════════════════════ */
::-webkit-scrollbar { width: 5px; height: 5px; }
::-webkit-scrollbar-track { background: var(--bg); }
::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 3px; }

@media (max-width: 640px) {
  header, .summary-bar, .table-wrapper, .weekly-note { padding-left: 16px; padding-right: 16px; }
  .stat-cell { min-width: 110px; }
  .auth-input { width: 130px; }
}
</style>
</head>
<body>

<div id="app">
  <header>
    <div class="logo">LEDGER<span>.db</span></div>
    <div class="header-right">
      <div id="adminBadge" class="admin-badge" style="display:none">✦ ADMIN</div>
      <div class="auth-area" id="authArea">
        <input class="auth-input" type="password" id="pwInput" placeholder="Admin password…" autocomplete="off" />
        <button class="btn btn-primary btn-sm" onclick="tryAdmin()">Unlock</button>
      </div>
      <button class="btn btn-ghost btn-sm" id="lockBtn" style="display:none" onclick="lockAdmin()">Lock</button>
    </div>
  </header>

  <div class="weekly-note">
    <div class="dot"></div>
    <span>Interest: +1% every 16h on positive balances, +2% every 24h on debts. System account excluded.</span>
  </div>

  <div class="summary-bar" id="summaryBar"></div>

  <div class="table-wrapper">
    <div class="controls">
      <span class="section-title" id="accountCount">Loading…</span>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-ghost btn-sm" id="interestBtn" style="display:none" onclick="applyInterestNow()">⟳ Apply Interest Now</button>
        <button class="btn btn-primary btn-sm" id="addBtn" style="display:none" onclick="openAddModal()">+ Add Account</button>
      </div>
    </div>

    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Account</th>
          <th class="num">Balance</th>
          <th class="num">Last Change</th>
          <th>Last Updated</th>
          <th class="num" id="actionsHeader" style="display:none">Actions</th>
        </tr>
      </thead>
      <tbody id="tableBody">
        <tr class="loading-row"><td colspan="6">Loading accounts…</td></tr>
      </tbody>
    </table>

    <div class="empty-state" id="emptyState" style="display:none">
      <div class="icon">📋</div>
      <p>No accounts yet.</p>
      <button class="btn btn-primary" onclick="openAddModal()">Add First Account</button>
    </div>
  </div>
</div>

<!-- Modals -->
<div class="modal-backdrop" id="accountModal">
  <div class="modal">
    <button class="close-modal" onclick="closeModal('accountModal')">×</button>
    <h2 id="modalTitle">New Account</h2>
    <p class="modal-sub" id="modalSub">Add a new account to the ledger.</p>
    <div class="field"><label>Account Name</label><input type="text" id="mName" placeholder="e.g. Alice" /></div>
    <div class="field"><label>Starting Balance</label><input type="number" id="mBalance" placeholder="0.00" step="0.01" /></div>
    <div class="error-msg" id="modalError"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal('accountModal')">Cancel</button>
      <button class="btn btn-primary" onclick="saveAccount()">Save</button>
    </div>
  </div>
</div>

<div class="modal-backdrop" id="adjustModal">
  <div class="modal">
    <button class="close-modal" onclick="closeModal('adjustModal')">×</button>
    <h2 id="adjustTitle">Adjust Balance</h2>
    <p class="modal-sub">Current: <strong id="adjustCurrent"></strong></p>
    <div class="field"><label>Amount (use − for deduction)</label><input type="number" id="aAmount" placeholder="e.g. 500 or -200" step="0.01" /></div>
    <div class="error-msg" id="adjustError"></div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal('adjustModal')">Cancel</button>
      <button class="btn btn-primary" onclick="saveAdjust()">Apply</button>
    </div>
  </div>
</div>

<div class="modal-backdrop" id="deleteModal">
  <div class="modal">
    <button class="close-modal" onclick="closeModal('deleteModal')">×</button>
    <h2>Remove Account?</h2>
    <p class="modal-sub">Permanently remove <strong id="deleteName"></strong>? This cannot be undone.</p>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal('deleteModal')">Cancel</button>
      <button class="btn btn-danger" onclick="confirmDelete()">Remove</button>
    </div>
  </div>
</div>

<div id="toast"></div>

<script>
// ─── Access key injected from server (safe) ──────────────────
const ACCESS_KEY = ${safeKey};

// ─── STATE ────────────────────────────────────────────────
let adminKey  = "";
let isAdmin   = false;
let accounts  = [];
let editingId = null;
let adjustingId = null;
let deletingId  = null;

// ─── BEAN SVG ──────────────────────────────────────────────
function beanSVG(size = 16, color = "currentColor") {
  return \`<span class="bean"><svg width="\${size}" height="\${size}" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <ellipse cx="8" cy="8" rx="5.2" ry="7" transform="rotate(-20 8 8)" fill="\${color}" opacity="0.92"/>
    <path d="M8 2.5 Q5 8 8 13.5" stroke="\${color === 'currentColor' ? '#0d0f0e' : '#0d0f0e'}" stroke-width="1.1" stroke-linecap="round" fill="none" opacity="0.55"/>
  </svg></span>\`;
}

// ─── FORMATTING ──────────────────────────────────────────
function fmt(n, color) {
  const abs = Math.abs(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
  const sign = n < 0 ? '−' : '';
  const bColor = color || (n >= 0 ? '#00c853' : '#ff3b30');
  return \`\${sign}\${abs}\${beanSVG(13, bColor)}\`;
}

function fmtChange(n) {
  if (!n || n === 0) return '<span style="color:var(--text-dim)">—</span>';
  const abs = Math.abs(n).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
  const sign = n > 0 ? '+' : '−';
  const color = n > 0 ? '#00c853' : '#ff3b30';
  return \`<span style="color:\${color}">\${sign}\${abs}\${beanSVG(12, color)}</span>\`;
}

function fmtDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) +
    ' ' + d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'});
}

// ─── API CALLS ──────────────────────────────────────────
async function api(method, path, body) {
  const opts = {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Access-Key": ACCESS_KEY,
      ...(adminKey ? { "X-Admin-Key": adminKey } : {}),
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch("/api/" + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

// ─── ADMIN AUTH ──────────────────────────────────────────
document.getElementById('pwInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') tryAdmin();
});

async function tryAdmin() {
  const key = document.getElementById('pwInput').value;
  try {
    await api("POST", "auth/admin", { key });
    adminKey = key;
    isAdmin = true;
    document.getElementById('authArea').style.display = 'none';
    document.getElementById('adminBadge').style.display = '';
    document.getElementById('lockBtn').style.display = '';
    document.getElementById('addBtn').style.display = '';
    document.getElementById('interestBtn').style.display = '';
    document.getElementById('actionsHeader').style.display = '';
    document.getElementById('pwInput').value = '';
    render();
    toast("Admin access granted ✓");
  } catch {
    const inp = document.getElementById('pwInput');
    inp.style.borderColor = 'var(--red)';
    setTimeout(() => inp.style.borderColor = '', 1200);
  }
}

function lockAdmin() {
  isAdmin = false;
  adminKey = "";
  document.getElementById('authArea').style.display = '';
  document.getElementById('adminBadge').style.display = 'none';
  document.getElementById('lockBtn').style.display = 'none';
  document.getElementById('addBtn').style.display = 'none';
  document.getElementById('interestBtn').style.display = 'none';
  document.getElementById('actionsHeader').style.display = 'none';
  render();
}

// ─── LOAD + RENDER ──────────────────────────────────────
async function loadAccounts() {
  try {
    const data = await api("GET", "accounts");
    accounts = data.accounts || [];
    render();
  } catch(e) {
    document.getElementById('tableBody').innerHTML =
      \`<tr class="loading-row"><td colspan="6" style="color:var(--red)">Failed to load: \${e.message}</td></tr>\`;
  }
}

function render() {
  const tbody       = document.getElementById('tableBody');
  const emptyState  = document.getElementById('emptyState');
  const summaryBar  = document.getElementById('summaryBar');
  const countEl     = document.getElementById('accountCount');

  const total   = accounts.reduce((s,a) => s + a.balance, 0);
  const inDebt  = accounts.filter(a => a.balance < 0).length;
  const inCredit= accounts.filter(a => a.balance >= 0).length;

  countEl.textContent = \`\${accounts.length} account\${accounts.length !== 1 ? 's' : ''}\`;

  const totalColor = total >= 0 ? '#00c853' : '#ff3b30';
  summaryBar.innerHTML = \`
    <div class="stat-cell">
      <div class="stat-label">Total Balance</div>
      <div class="stat-value \${total >= 0 ? 'pos':'neg'}">\${fmt(total, totalColor)}</div>
    </div>
    <div class="stat-cell">
      <div class="stat-label">Accounts</div>
      <div class="stat-value neutral">\${accounts.length}</div>
    </div>
    <div class="stat-cell">
      <div class="stat-label">In Credit</div>
      <div class="stat-value pos">\${inCredit}</div>
    </div>
    <div class="stat-cell">
      <div class="stat-label">In Debt</div>
      <div class="stat-value \${inDebt > 0 ? 'neg':'neutral'}">\${inDebt}</div>
    </div>
  \`;

  if (accounts.length === 0) {
    tbody.innerHTML = '';
    emptyState.style.display = '';
    emptyState.querySelector('button').style.display = isAdmin ? '' : 'none';
    return;
  }
  emptyState.style.display = 'none';

  tbody.innerHTML = accounts.map((a, i) => {
    const isPos = a.balance >= 0;
    const isSystem = a.is_system === 1;
    const actions = isAdmin && !isSystem ? \`
      <td class="col-actions">
        <div class="action-btns">
          <button class="btn btn-ghost btn-sm" onclick="openAdjust('\${a.id}')">± Adjust</button>
          <button class="btn btn-ghost btn-sm" onclick="openEdit('\${a.id}')">Edit</button>
          <button class="btn btn-danger btn-sm" onclick="openDelete('\${a.id}')">✕</button>
        </div>
      </td>\` : (isAdmin && isSystem ? \`<td class="col-actions"><div class="action-btns"><button class="btn btn-ghost btn-sm" onclick="openAdjust('\${a.id}')">± Adjust</button></div></td>\` : '');
    return \`<tr>
      <td class="col-idx">\${i+1}</td>
      <td class="col-name">\${escHtml(a.name)}\${isSystem ? ' <span class="system-tag">System</span>' : ''}<small>\${isSystem ? 'No interest' : nextInterestText(a.last_updated, a.balance)}</small></td>
      <td class="col-balance \${isPos?'pos':'neg'}">\${fmt(a.balance)}</td>
      <td class="col-change">\${fmtChange(a.last_change)}</td>
      <td class="col-updated">\${fmtDate(a.last_updated)}</td>
      \${actions}
    </tr>\`;
  }).join('');
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function nextInterestText(lastUpdated, balance) {
  if (balance === 0) return 'No interest';
  const now = Date.now();
  let periodMs, rate;
  if (balance > 0) {
    periodMs = 16 * 3600 * 1000;
    rate = 1;
  } else {
    periodMs = 24 * 3600 * 1000;
    rate = 2;
  }
  const elapsed = now - lastUpdated;
  const remaining = periodMs - (elapsed % periodMs);
  const d = Math.floor(remaining / (24*3600*1000));
  const h = Math.floor((remaining % (24*3600*1000)) / (3600*1000));
  const min = Math.floor((remaining % (3600*1000)) / (60*1000));
  if (d > 0) return \`+\${rate}% in \${d}d \${h}h\`;
  if (h > 0) return \`+\${rate}% in \${h}h \${min}m\`;
  return \`+\${rate}% in \${min}m\`;
}

// ─── INTEREST (manual) ──────────────────────────────────
async function applyInterestNow() {
  try {
    await api("POST", "accounts/interest");
    await loadAccounts();
    toast("Interest applied to all accounts ✓");
  } catch(e) { toast("Error: " + e.message); }
}

// ─── MODALS ──────────────────────────────────────────────
function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) {
  document.getElementById(id).classList.remove('open');
  ['modalError','adjustError'].forEach(x => {
    const el = document.getElementById(x); if(el) el.textContent='';
  });
}
document.querySelectorAll('.modal-backdrop').forEach(b => {
  b.addEventListener('click', e => { if(e.target === b) closeModal(b.id); });
});

function openAddModal() {
  editingId = null;
  document.getElementById('modalTitle').textContent = 'New Account';
  document.getElementById('modalSub').textContent = 'Add a new account to the ledger.';
  document.getElementById('mName').value = '';
  document.getElementById('mBalance').value = '';
  document.getElementById('modalError').textContent = '';
  openModal('accountModal');
  setTimeout(() => document.getElementById('mName').focus(), 50);
}

function openEdit(id) {
  const a = accounts.find(x => x.id === id); if(!a) return;
  editingId = id;
  document.getElementById('modalTitle').textContent = 'Edit Account';
  document.getElementById('modalSub').textContent = \`Editing "\${a.name}"\`;
  document.getElementById('mName').value = a.name;
  document.getElementById('mBalance').value = a.balance;
  document.getElementById('modalError').textContent = '';
  openModal('accountModal');
  setTimeout(() => document.getElementById('mName').focus(), 50);
}

async function saveAccount() {
  const name    = document.getElementById('mName').value.trim();
  const balance = parseFloat(document.getElementById('mBalance').value);
  const errEl   = document.getElementById('modalError');
  if (!name)        { errEl.textContent = 'Name is required.'; return; }
  if (isNaN(balance)) { errEl.textContent = 'Enter a valid balance.'; return; }
  try {
    if (editingId) {
      await api("PUT", \`accounts/\${editingId}\`, { name, balance });
      toast(\`"\${name}" updated ✓\`);
    } else {
      await api("POST", "accounts", { name, balance });
      toast(\`"\${name}" added ✓\`);
    }
    closeModal('accountModal');
    await loadAccounts();
  } catch(e) { errEl.textContent = e.message; }
}

function openAdjust(id) {
  const a = accounts.find(x => x.id === id); if(!a) return;
  adjustingId = id;
  document.getElementById('adjustTitle').textContent = \`Adjust: \${a.name}\`;
  document.getElementById('adjustCurrent').innerHTML = fmt(a.balance);
  document.getElementById('aAmount').value = '';
  document.getElementById('adjustError').textContent = '';
  openModal('adjustModal');
  setTimeout(() => document.getElementById('aAmount').focus(), 50);
}

async function saveAdjust() {
  const amount = parseFloat(document.getElementById('aAmount').value);
  const errEl  = document.getElementById('adjustError');
  if (isNaN(amount) || amount === 0) { errEl.textContent = 'Enter a non-zero amount.'; return; }
  try {
    await api("POST", \`accounts/\${adjustingId}/adjust\`, { amount });
    closeModal('adjustModal');
    await loadAccounts();
    toast(\`Balance \${amount >= 0 ? 'increased' : 'decreased'} ✓\`);
  } catch(e) { errEl.textContent = e.message; }
}

function openDelete(id) {
  const a = accounts.find(x => x.id === id); if(!a) return;
  deletingId = id;
  document.getElementById('deleteName').textContent = a.name;
  openModal('deleteModal');
}

async function confirmDelete() {
  const a = accounts.find(x => x.id === deletingId); if(!a) return;
  try {
    await api("DELETE", \`accounts/\${deletingId}\`);
    closeModal('deleteModal');
    await loadAccounts();
    toast(\`"\${a.name}" removed\`);
  } catch(e) { toast("Error: " + e.message); }
}

document.getElementById('mBalance').addEventListener('keydown', e => { if(e.key==='Enter') saveAccount(); });
document.getElementById('mName').addEventListener('keydown',    e => { if(e.key==='Enter') saveAccount(); });
document.getElementById('aAmount').addEventListener('keydown',  e => { if(e.key==='Enter') saveAdjust(); });

// ─── TOAST ──────────────────────────────────────────────────
let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ─── START ─────────────────────────────────────────────────
loadAccounts();
</script>
</body>
</html>`;
}

// ─── Main request handler ──────────────────────────────────────
export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (!env.DB) return err("D1 binding 'DB' is not configured", 500);

  const url = new URL(request.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const method = request.method;

  const accessKey = request.headers.get("X-Access-Key") || "";
  const adminKey  = request.headers.get("X-Admin-Key")  || "";

  const validAccess = () => accessKey === env.ACCESS_KEY;
  const validAdmin  = () => adminKey  === env.PASSWORD;

  // ─── Public routes ──────────────────────────────────────────
  if (parts[0] === "auth" && parts[1] === "access" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    if (body.key === env.ACCESS_KEY) return json({ ok: true });
    return err("Invalid access key", 401);
  }

  if (parts[0] === "auth" && parts[1] === "admin" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    if (body.key === env.PASSWORD) return json({ ok: true });
    return err("Invalid admin password", 401);
  }

  // ─── Protected routes ──────────────────────────────────────
  if (!validAccess()) return err("Access denied", 401);

  const db = env.DB;
  await initDB(db);

  // GET /api/app – serve the full app HTML
  if (parts[0] === "app" && !parts[1] && method === "GET") {
    const html = getAppHTML(accessKey);
    return new Response(html, {
      headers: { "Content-Type": "text/html", ...CORS }
    });
  }

  // ─── CRUD ──────────────────────────────────────────────────

  if (parts[0] === "accounts" && !parts[1] && method === "GET") {
    await applyAccruedInterest(db);
    const rows = await db.prepare("SELECT * FROM accounts ORDER BY rowid ASC").all();
    return json({ accounts: rows.results });
  }

  if (parts[0] === "accounts" && !parts[1] && method === "POST") {
    if (!validAdmin()) return err("Admin required", 403);
    const body = await request.json().catch(() => ({}));
    const name = (body.name || "").trim();
    const balance = parseFloat(body.balance);
    if (!name) return err("Name required");
    if (isNaN(balance)) return err("Invalid balance");
    const id = newId();
    await db.prepare(
      `INSERT INTO accounts (id, name, balance, last_change, last_updated, is_system)
       VALUES (?, ?, ?, 0, ?, 0)`
    ).bind(id, name, Math.round(balance * 100) / 100, Date.now()).run();
    return json({ ok: true, id });
  }

  if (parts[0] === "accounts" && parts[1] === "interest" && method === "POST") {
    if (!validAdmin()) return err("Admin required", 403);
    await applyAccruedInterest(db);
    return json({ ok: true });
  }

  if (parts[0] === "accounts" && parts[1] && method === "PUT") {
    if (!validAdmin()) return err("Admin required", 403);
    const id = parts[1];
    const body = await request.json().catch(() => ({}));
    const row = await db.prepare("SELECT * FROM accounts WHERE id=?").bind(id).first();
    if (!row) return err("Not found", 404);
    const name = (body.name !== undefined ? body.name : row.name).trim();
    const balance = body.balance !== undefined ? parseFloat(body.balance) : row.balance;
    if (!name) return err("Name required");
    if (isNaN(balance)) return err("Invalid balance");
    await db.prepare(
      "UPDATE accounts SET name=?, balance=? WHERE id=?"
    ).bind(name, Math.round(balance * 100) / 100, id).run();
    return json({ ok: true });
  }

  if (parts[0] === "accounts" && parts[1] && parts[2] === "adjust" && method === "POST") {
    if (!validAdmin()) return err("Admin required", 403);
    const id = parts[1];
    const body = await request.json().catch(() => ({}));
    let amount = parseFloat(body.amount);
    if (isNaN(amount) || amount === 0) return err("Invalid amount");

    const row = await db.prepare("SELECT * FROM accounts WHERE id=?").bind(id).first();
    if (!row) return err("Not found", 404);

    let actualChange = amount;
    if (amount > 0) {
      actualChange = applyTax(amount);
    }

    const newBalance = Math.round((row.balance + actualChange) * 100) / 100;
    await db.prepare(
      "UPDATE accounts SET balance=?, last_change=?, last_updated=? WHERE id=?"
    ).bind(newBalance, Math.round(actualChange * 100) / 100, Date.now(), id).run();
    return json({ ok: true, balance: newBalance, actualChange });
  }

  if (parts[0] === "accounts" && parts[1] && method === "DELETE") {
    if (!validAdmin()) return err("Admin required", 403);
    const id = parts[1];
    if (id === "system") return err("Cannot delete system account", 403);
    const row = await db.prepare("SELECT id FROM accounts WHERE id=?").bind(id).first();
    if (!row) return err("Not found", 404);
    await db.prepare("DELETE FROM accounts WHERE id=?").bind(id).run();
    return json({ ok: true });
  }

  return err("Not found", 404);
}

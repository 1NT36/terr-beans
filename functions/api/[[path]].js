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

async function initDB(db) {
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL, balance REAL NOT NULL DEFAULT 0, last_change REAL NOT NULL DEFAULT 0, last_updated INTEGER NOT NULL)"
  ).run();
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const INTEREST_RATE = 0.10;

async function applyAccruedInterest(db) {
  const now = Date.now();
  const rows = await db.prepare("SELECT * FROM accounts").all();
  const stale = rows.results.filter(a => (now - a.last_updated) >= WEEK_MS);
  for (const a of stale) {
    const weeks = Math.floor((now - a.last_updated) / WEEK_MS);
    let b = a.balance;
    for (let w = 0; w < weeks; w++) b *= (1 + INTEREST_RATE);
    b = Math.round(b * 100) / 100;
    const change = Math.round((b - a.balance) * 100) / 100;
    await db.prepare(
      "UPDATE accounts SET balance=?, last_change=?, last_updated=? WHERE id=?"
    ).bind(b, change, a.last_updated + weeks * WEEK_MS, a.id).run();
  }
}

function newId() {
  return "acct_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7);
}

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

  // POST /api/auth/access — no DB needed, validate before initDB
  if (parts[0] === "auth" && parts[1] === "access" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    if (body.key === env.ACCESS_KEY) return json({ ok: true });
    return err("Invalid access key", 401);
  }

  // POST /api/auth/admin
  if (parts[0] === "auth" && parts[1] === "admin" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    if (body.key === env.PASSWORD) return json({ ok: true });
    return err("Invalid admin password", 401);
  }

  // All remaining routes require valid access key header
  if (!validAccess()) return err("Access denied", 401);

  // Init DB only when we actually need it
  const db = env.DB;
  await initDB(db);

  // GET /api/accounts
  if (parts[0] === "accounts" && !parts[1] && method === "GET") {
    await applyAccruedInterest(db);
    const rows = await db.prepare("SELECT * FROM accounts ORDER BY rowid ASC").all();
    return json({ accounts: rows.results });
  }

  // POST /api/accounts
  if (parts[0] === "accounts" && !parts[1] && method === "POST") {
    if (!validAdmin()) return err("Admin required", 403);
    const body = await request.json().catch(() => ({}));
    const name = (body.name || "").trim();
    const balance = parseFloat(body.balance);
    if (!name) return err("Name required");
    if (isNaN(balance)) return err("Invalid balance");
    const id = newId();
    await db.prepare(
      "INSERT INTO accounts (id,name,balance,last_change,last_updated) VALUES (?,?,?,0,?)"
    ).bind(id, name, Math.round(balance * 100) / 100, Date.now()).run();
    return json({ ok: true, id });
  }

  // POST /api/accounts/interest
  if (parts[0] === "accounts" && parts[1] === "interest" && method === "POST") {
    if (!validAdmin()) return err("Admin required", 403);
    const now = Date.now();
    const rows = await db.prepare("SELECT * FROM accounts").all();
    for (const a of rows.results) {
      const b = Math.round(a.balance * (1 + INTEREST_RATE) * 100) / 100;
      const change = Math.round((b - a.balance) * 100) / 100;
      await db.prepare(
        "UPDATE accounts SET balance=?, last_change=?, last_updated=? WHERE id=?"
      ).bind(b, change, now, a.id).run();
    }
    return json({ ok: true });
  }

  // PUT /api/accounts/:id
  if (parts[0] === "accounts" && parts[1] && method === "PUT") {
    if (!validAdmin()) return err("Admin required", 403);
    const id = parts[1];
    const body = await request.json().catch(() => ({}));
    const row = await db.prepare("SELECT * FROM accounts WHERE id=?").bind(id).first();
    if (!row) return err("Not found", 404);
    const name    = (body.name !== undefined ? body.name : row.name).trim();
    const balance = body.balance !== undefined ? parseFloat(body.balance) : row.balance;
    if (!name) return err("Name required");
    if (isNaN(balance)) return err("Invalid balance");
    await db.prepare(
      "UPDATE accounts SET name=?, balance=? WHERE id=?"
    ).bind(name, Math.round(balance * 100) / 100, id).run();
    return json({ ok: true });
  }

  // POST /api/accounts/:id/adjust
  if (parts[0] === "accounts" && parts[1] && parts[2] === "adjust" && method === "POST") {
    if (!validAdmin()) return err("Admin required", 403);
    const id = parts[1];
    const body = await request.json().catch(() => ({}));
    const amount = parseFloat(body.amount);
    if (isNaN(amount) || amount === 0) return err("Invalid amount");
    const row = await db.prepare("SELECT * FROM accounts WHERE id=?").bind(id).first();
    if (!row) return err("Not found", 404);
    const newBalance = Math.round((row.balance + amount) * 100) / 100;
    await db.prepare(
      "UPDATE accounts SET balance=?, last_change=?, last_updated=? WHERE id=?"
    ).bind(newBalance, Math.round(amount * 100) / 100, Date.now(), id).run();
    return json({ ok: true, balance: newBalance });
  }

  // DELETE /api/accounts/:id
  if (parts[0] === "accounts" && parts[1] && method === "DELETE") {
    if (!validAdmin()) return err("Admin required", 403);
    const id = parts[1];
    const row = await db.prepare("SELECT id FROM accounts WHERE id=?").bind(id).first();
    if (!row) return err("Not found", 404);
    await db.prepare("DELETE FROM accounts WHERE id=?").bind(id).run();
    return json({ ok: true });
  }

  return err("Not found", 404);
}

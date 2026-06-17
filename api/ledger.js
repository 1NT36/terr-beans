// functions/api/ledger.js
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers });
  }

  const db = env.DB;

  // Helper: Check auth for write operations
  function checkAuth(authHeader) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
    const token = authHeader.split(' ')[1];
    return token === env.PASSWORD;
  }

  try {
    // GET: Fetch all accounts (public)
    if (request.method === 'GET') {
      const result = await db.prepare(
        'SELECT * FROM accounts ORDER BY name'
      ).all();
      
      return new Response(JSON.stringify(result.results), { headers });
    }

    // All write operations require auth
    const authHeader = request.headers.get('Authorization');
    if (!checkAuth(authHeader)) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { 
        status: 401, 
        headers 
      });
    }

    // POST: Add new account
    if (request.method === 'POST' && url.pathname === '/api/ledger') {
      const { name, balance } = await request.json();
      
      if (!name || balance === undefined) {
        return new Response(JSON.stringify({ error: 'Name and balance required' }), { 
          status: 400, 
          headers 
        });
      }

      const id = 'acct_' + Date.now() + '_' + Math.random().toString(36).slice(2,7);
      const result = await db.prepare(
        'INSERT INTO accounts (id, name, balance, last_updated, last_change) VALUES (?, ?, ?, ?, ?) RETURNING *'
      ).bind(id, name, Math.round(balance * 100) / 100, Date.now(), 0).run();
      
      return new Response(JSON.stringify(result.results), { headers });
    }

    // PUT: Update account (edit name or balance)
    if (request.method === 'PUT' && url.pathname === '/api/ledger') {
      const { id, name, balance, lastChange } = await request.json();
      
      if (!id) {
        return new Response(JSON.stringify({ error: 'Account ID required' }), { 
          status: 400, 
          headers 
        });
      }

      let query = 'UPDATE accounts SET ';
      const params = [];
      
      if (name !== undefined) {
        query += 'name = ?, ';
        params.push(name);
      }
      if (balance !== undefined) {
        query += 'balance = ?, ';
        params.push(Math.round(balance * 100) / 100);
      }
      if (lastChange !== undefined) {
        query += 'last_change = ?, ';
        params.push(Math.round(lastChange * 100) / 100);
      }
      
      query += 'last_updated = ? WHERE id = ? RETURNING *';
      params.push(Date.now(), id);

      const result = await db.prepare(query).bind(...params).run();
      
      return new Response(JSON.stringify(result.results), { headers });
    }

    // DELETE: Remove account
    if (request.method === 'DELETE' && url.pathname === '/api/ledger') {
      const { id } = await request.json();
      
      if (!id) {
        return new Response(JSON.stringify({ error: 'Account ID required' }), { 
          status: 400, 
          headers 
        });
      }

      await db.prepare('DELETE FROM accounts WHERE id = ?').bind(id).run();
      
      return new Response(JSON.stringify({ success: true }), { headers });
    }

    // POST: Apply interest to all accounts
    if (request.method === 'POST' && url.pathname === '/api/ledger/interest') {
      const accounts = await db.prepare('SELECT * FROM accounts').all();
      const now = Date.now();
      const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
      const INTEREST_RATE = 0.10;
      let changes = 0;
      
      for (const acc of accounts.results) {
        const elapsed = now - acc.last_updated;
        const weeks = Math.floor(elapsed / WEEK_MS);
        
        if (weeks >= 1) {
          let newBalance = acc.balance;
          for (let i = 0; i < weeks; i++) {
            newBalance = newBalance * (1 + INTEREST_RATE);
          }
          newBalance = Math.round(newBalance * 100) / 100;
          const change = Math.round((newBalance - acc.balance) * 100) / 100;
          
          await db.prepare(
            'UPDATE accounts SET balance = ?, last_updated = ?, last_change = ? WHERE id = ?'
          ).bind(
            newBalance, 
            acc.last_updated + (weeks * WEEK_MS), 
            change, 
            acc.id
          ).run();
          changes++;
        }
      }
      
      return new Response(JSON.stringify({ 
        success: true, 
        accountsUpdated: changes 
      }), { headers });
    }

    return new Response('Not Found', { status: 404, headers });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { 
      status: 500, 
      headers 
    });
  }
}

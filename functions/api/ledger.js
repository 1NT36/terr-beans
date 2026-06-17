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
      const body = await request.json();
      const { name, balance } = body;
      
      if (!name || balance === undefined || balance === null) {
        return new Response(JSON.stringify({ error: 'Name and balance required' }), { 
          status: 400, 
          headers 
        });
      }

      const id = 'acct_' + Date.now() + '_' + Math.random().toString(36).slice(2,7);
      const now = Date.now();
      const balanceNum = parseFloat(balance) || 0;
      
      // Insert with explicit type conversion
      const result = await db.prepare(
        'INSERT INTO accounts (id, name, balance, last_updated, last_change) VALUES (?, ?, ?, ?, ?)'
      ).bind(
        id, 
        name, 
        Math.round(balanceNum * 100) / 100, 
        now, 
        0
      ).run();
      
      // Fetch the newly created account
      const newAccount = await db.prepare(
        'SELECT * FROM accounts WHERE id = ?'
      ).bind(id).first();
      
      return new Response(JSON.stringify(newAccount || { id, name, balance: Math.round(balanceNum * 100) / 100, last_updated: now, last_change: 0 }), { headers });
    }

    // PUT: Update account
    if (request.method === 'PUT' && url.pathname === '/api/ledger') {
      const body = await request.json();
      const { id, name, balance, lastChange } = body;
      
      if (!id) {
        return new Response(JSON.stringify({ error: 'Account ID required' }), { 
          status: 400, 
          headers 
        });
      }

      let query = 'UPDATE accounts SET ';
      const params = [];
      
      if (name !== undefined && name !== null) {
        query += 'name = ?, ';
        params.push(name);
      }
      if (balance !== undefined && balance !== null) {
        const balanceNum = parseFloat(balance) || 0;
        query += 'balance = ?, ';
        params.push(Math.round(balanceNum * 100) / 100);
      }
      if (lastChange !== undefined && lastChange !== null) {
        const changeNum = parseFloat(lastChange) || 0;
        query += 'last_change = ?, ';
        params.push(Math.round(changeNum * 100) / 100);
      }
      
      query += 'last_updated = ? WHERE id = ? RETURNING *';
      params.push(Date.now(), id);

      const result = await db.prepare(query).bind(...params).run();
      
      // Fetch the updated account
      const updatedAccount = await db.prepare(
        'SELECT * FROM accounts WHERE id = ?'
      ).bind(id).first();
      
      return new Response(JSON.stringify(updatedAccount || { success: true }), { headers });
    }

    // DELETE: Remove account
    if (request.method === 'DELETE' && url.pathname === '/api/ledger') {
      const body = await request.json();
      const { id } = body;
      
      if (!id) {
        return new Response(JSON.stringify({ error: 'Account ID required' }), { 
          status: 400, 
          headers 
        });
      }

      await db.prepare('DELETE FROM accounts WHERE id = ?').bind(id).run();
      
      return new Response(JSON.stringify({ success: true }), { headers });
    }

    // POST: Apply interest
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
    console.error('API Error:', error);
    return new Response(JSON.stringify({ error: error.message || 'Internal server error' }), { 
      status: 500, 
      headers 
    });
  }
}

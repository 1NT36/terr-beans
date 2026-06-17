// functions/api/auth.js
export async function onRequest(context) {
  const { request, env } = context;
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers });
  }

  if (request.method === 'POST') {
    try {
      const body = await request.json();
      const { password } = body;
      
      if (!password) {
        return new Response(JSON.stringify({ 
          success: false, 
          message: 'Password required' 
        }), { status: 400, headers });
      }
      
      const isValid = password === env.PASSWORD;
      
      return new Response(JSON.stringify({ 
        success: isValid,
        message: isValid ? 'Authenticated' : 'Invalid password'
      }), { headers });
    } catch (error) {
      return new Response(JSON.stringify({ 
        success: false, 
        message: error.message 
      }), { status: 500, headers });
    }
  }

  return new Response('Method not allowed', { status: 405, headers });
}

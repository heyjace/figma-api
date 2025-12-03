const { Pool, neonConfig } = require('@neondatabase/serverless');

neonConfig.fetchConnectionCache = true;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.status(200).set(corsHeaders).end();
    return;
  }

  Object.entries(corsHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });

  if (req.method !== 'GET') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    
    const result = await pool.query(
      `SELECT ft.*, lu.username, lu.display_name, lu.role 
       FROM figma_tokens ft 
       JOIN local_users lu ON ft.user_id = lu.id 
       WHERE ft.token = $1 AND ft.expires_at > NOW()`,
      [token]
    );
    
    await pool.end();

    if (result.rows.length === 0) {
      return res.status(401).json({ message: 'Invalid or expired token' });
    }

    const tokenData = result.rows[0];

    return res.status(200).json({
      valid: true,
      user: {
        id: tokenData.user_id,
        username: tokenData.username,
        displayName: tokenData.display_name,
        role: tokenData.role
      }
    });
  } catch (error) {
    console.error('Verify error:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

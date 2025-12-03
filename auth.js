const { Pool, neonConfig } = require('@neondatabase/serverless');
const crypto = require('crypto');

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

  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ message: 'Username and password required' });
    }

    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    
    const result = await pool.query(
      'SELECT * FROM local_users WHERE username = $1',
      [username]
    );
    
    await pool.end();

    if (result.rows.length === 0) {
      return res.status(401).json({ message: 'Invalid username or password' });
    }

    const user = result.rows[0];
    
    const bcrypt = require('bcrypt');
    const validPassword = await bcrypt.compare(password, user.password);
    
    if (!validPassword) {
      return res.status(401).json({ message: 'Invalid username or password' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const tokenPool = new Pool({ connectionString: process.env.DATABASE_URL });
    await tokenPool.query(
      'INSERT INTO figma_tokens (token, user_id, expires_at) VALUES ($1, $2, $3)',
      [token, user.id, expiresAt]
    );
    await tokenPool.end();

    return res.status(200).json({
      token,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Auth error:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }
};

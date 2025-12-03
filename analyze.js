const { Pool, neonConfig } = require('@neondatabase/serverless');
const Anthropic = require('@anthropic-ai/sdk');

neonConfig.fetchConnectionCache = true;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

async function verifyToken(token) {
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
    return null;
  }
  
  return result.rows[0];
}

async function getContentStandards() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const result = await pool.query('SELECT * FROM content_standards WHERE status = $1', ['active']);
  await pool.end();
  return result.rows;
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') {
    Object.entries(corsHeaders).forEach(([key, value]) => {
      res.setHeader(key, value);
    });
    return res.status(200).end();
  }

  Object.entries(corsHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });

  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const tokenData = await verifyToken(token);
    
    if (!tokenData) {
      return res.status(401).json({ message: 'Invalid or expired token' });
    }

    const { textContent, frameName, textNodes } = req.body;

    if (!textContent && (!textNodes || textNodes.length === 0)) {
      return res.status(400).json({ message: 'No text content provided' });
    }

    const standards = await getContentStandards();
    
    if (standards.length === 0) {
      return res.status(500).json({ message: 'No content standards found' });
    }

    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });

    const standardsContext = standards.map(s => 
      `**${s.title}** (${s.id})\n- Domain: ${s.domain}\n- Definition: ${s.definition}\n- Do: ${(s.do_examples || []).join('; ')}\n- Don't: ${(s.dont_examples || []).join('; ')}`
    ).join('\n\n');

    const textToAnalyze = textNodes && textNodes.length > 0
      ? textNodes.map(n => `[${n.name}]: "${n.characters}"`).join('\n')
      : textContent;

    const prompt = `You are a content standards reviewer. Analyze the following Figma design text against these content standards:

${standardsContext}

---

**Figma Frame**: ${frameName || 'Unknown'}

**Text Content to Analyze**:
${textToAnalyze}

---

Analyze each piece of text and provide:
1. An overall compliance score (0-100)
2. List of standards that are being followed well
3. List of violations with specific examples and suggested fixes
4. General recommendations

Respond in this JSON format:
{
  "score": <number 0-100>,
  "summary": "<brief summary>",
  "compliant": [
    {"standardId": "<id>", "standardTitle": "<title>", "evidence": "<what text follows this standard>"}
  ],
  "violations": [
    {"standardId": "<id>", "standardTitle": "<title>", "issue": "<what's wrong>", "text": "<problematic text>", "suggestion": "<how to fix>"}
  ],
  "recommendations": ["<general improvement suggestions>"]
}`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }]
    });

    let analysisResult;
    try {
      const responseText = response.content[0].text;
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        analysisResult = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('No JSON found in response');
      }
    } catch (parseError) {
      console.error('Parse error:', parseError);
      analysisResult = {
        score: 50,
        summary: 'Analysis completed but response parsing failed',
        compliant: [],
        violations: [],
        recommendations: ['Please try again']
      };
    }

    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query(
      `INSERT INTO screenshot_analyses (user_id, file_name, analysis_result, created_at) 
       VALUES ($1, $2, $3, NOW())`,
      [tokenData.user_id, frameName || 'Figma Analysis', JSON.stringify(analysisResult)]
    );
    await pool.end();

    return res.status(200).json(analysisResult);
  } catch (error) {
    console.error('Analysis error:', error);
    return res.status(500).json({ message: 'Analysis failed: ' + error.message });
  }
};

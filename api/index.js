const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const ALLOWED_ORIGINS = [
  'https://chat.alvaspec.my.id',
  'http://chat.alvaspec.my.id',
  'https://alternativechatai.ct.ws',
  'http://alternativechatai.ct.ws',
  'https://alter-ai-bmbd3azfg-alvaro19371s-projects.vercel.app',
  null,
];

// Convert OpenAI-style messages to Gemini format
function toGeminiMessages(messages) {
  const systemMsg = messages.find(m => m.role === 'system');
  const systemInstruction = systemMsg ? { parts: [{ text: systemMsg.content }] } : null;

  const contents = messages
    .filter(m => m.role !== 'system')
    .map(m => {
      if (Array.isArray(m.content)) {
        const parts = m.content.map(c => {
          if (c.type === 'text') return { text: c.text };
          if (c.type === 'image_url') {
            const match = c.image_url.url.match(/^data:(.+);base64,(.+)$/);
            if (match) return { inline_data: { mime_type: match[1], data: match[2] } };
          }
          return null;
        }).filter(Boolean);
        return { role: m.role === 'assistant' ? 'model' : 'user', parts };
      }
      return {
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      };
    });

  return { systemInstruction, contents };
}

export default async function handler(req, res) {
  const origin = req.headers['origin'] || '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : '*';

  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const data = req.body;
  if (!data?.messages || !Array.isArray(data.messages))
    return res.status(400).json({ error: 'Invalid request body' });

  let messages = data.messages;

  // Kirim ke Gemini 2.5 Flash dengan Google Search grounding
  try {
    const model = 'gemini-2.5-flash';
    const { systemInstruction, contents } = toGeminiMessages(messages);

    const body = {
      contents,
      tools: [{ google_search: {} }], // Built-in Google Search grounding
      generationConfig: {
        maxOutputTokens: 8192,
        temperature: 0.7,
      },
    };
    if (systemInstruction) body.systemInstruction = systemInstruction;

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );

    const geminiData = await geminiRes.json();

    if (geminiData.error) {
      const errMsg = geminiData.error.message || '';
      const errCode = geminiData.error.code;
      if (errCode === 429) return res.status(429).json({ error: '__RATE_LIMIT__', resetTime: '60s' });
      if (errMsg.includes('not found') || errMsg.includes('deprecated')) return res.status(500).json({ error: '__MODEL_UNAVAILABLE__' });
      return res.status(500).json({ error: errMsg || 'Gemini API error' });
    }

    // Extract text — handle thinking blocks too
    const parts = geminiData.candidates?.[0]?.content?.parts || [];
    const text = parts
      .filter(p => p.text && !p.thought)
      .map(p => p.text)
      .join('') || '';

    return res.status(200).json({
      choices: [{ message: { role: 'assistant', content: text } }]
    });

  } catch (e) {
    return res.status(500).json({ error: 'Gagal menghubungi AI: ' + e.message });
  }
}

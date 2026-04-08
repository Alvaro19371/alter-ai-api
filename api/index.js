const GROQ_API_KEY = process.env.GROQ_API_KEY;

const ALLOWED_ORIGINS = [
  'https://chat.alvaspec.my.id',
  'http://chat.alvaspec.my.id',
  'https://alternativechatai.ct.ws',
  'http://alternativechatai.ct.ws',
  'https://alter-ai-bmbd3azfg-alvaro19371s-projects.vercel.app',
  null,
];

export default async function handler(req, res) {
  const origin = req.headers['origin'] || '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : '*';

  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  
  // Error jika method bukan POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Metode tidak diizinkan oleh Alter AI' });
  }

  const data = req.body;
  if (!data?.messages || !Array.isArray(data.messages)) {
    return res.status(400).json({ error: 'Format pesan tidak valid bagi sistem Alter AI' });
  }

  try {
    // Menggunakan model Groq (Search otomatis mati karena tidak ada parameter tools)
    const model = 'llama-3.3-70b-versatile';

    const body = {
      model,
      messages: data.messages,
      max_tokens: 8192,
      temperature: 0.7,
    };

    const groqRes = await fetch(
      `https://api.groq.com/openai/v1/chat/completions`,
      {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${GROQ_API_KEY}`
        },
        body: JSON.stringify(body),
      }
    );

    const groqData = await groqRes.json();

    if (groqData.error) {
      if (groqRes.status === 429) {
        return res.status(429).json({ 
          error: 'Alter AI sedang sibuk (Rate Limit), silakan coba lagi sebentar lagi', 
          resetTime: '60s' 
        });
      }
      return res.status(500).json({ error: `Gangguan pada otak Alter AI: ${groqData.error.message}` });
    }

    const text = groqData.choices?.[0]?.message?.content || '';

    return res.status(200).json({
      choices: [{ message: { role: 'assistant', content: text } }]
    });

  } catch (e) {
    return res.status(500).json({ error: 'Sistem Alter AI gagal terhubung ke server: ' + e.message });
  }
}

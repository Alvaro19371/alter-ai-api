const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const ALLOWED_ORIGINS = [
  'https://chat.alvaspec.my.id',
  'http://chat.alvaspec.my.id',
  'https://alternativechatai.ct.ws',
  'http://alternativechatai.ct.ws',
  'https://alter-ai-bmbd3azfg-alvaro19371s-projects.vercel.app',
  null,
];

// Konversi pesan ke format Gemini
function toGeminiMessages(messages) {
  const systemMsg = messages.find(m => m.role === 'system');
  const systemInstruction = systemMsg ? { parts: [{ text: systemMsg.content }] } : null;

  const contents = messages
    .filter(m => m.role !== 'system')
    .map(m => {
      return {
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }]
      };
    });

  return { contents, systemInstruction };
}

export default async function handler(req, res) {
  const origin = req.headers['origin'] || '';
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : '*';

  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Metode ditolak oleh Alter AI' });

  const data = req.body;
  if (!data?.messages) return res.status(400).json({ error: 'Data tidak lengkap untuk Alter AI' });

  try {
    // Menggunakan Gemini 1.5 Flash untuk limit GRATIS terbesar dan kecepatan maksimal
    const model = 'gemini-1.5-flash'; 
    const { contents, systemInstruction } = toGeminiMessages(data.messages);

    const body = {
      contents,
      tools: [{ google_search: {} }], // MENGAKTIFKAN SEARCH GOOGLE
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
      const errCode = geminiData.error.code;
      if (errCode === 429) {
        return res.status(429).json({ error: 'Alter AI mencapai limit trafik. Coba lagi dalam 60 detik.' });
      }
      return res.status(500).json({ error: 'Gangguan pada Alter AI: ' + geminiData.error.message });
    }

    const parts = geminiData.candidates?.[0]?.content?.parts || [];
    const text = parts.map(p => p.text).join('');

    return res.status(200).json({
      choices: [{ message: { role: 'assistant', content: text } }]
    });

  } catch (e) {
    return res.status(500).json({ error: 'Sistem Alter AI mengalami kegagalan koneksi.' });
  }
}

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SERPER_API_KEY = process.env.SERPER_API_KEY;

const ALLOWED_ORIGINS = [
  'https://chat.alvaspec.my.id',
  'http://chat.alvaspec.my.id',
  'https://alternativechatai.ct.ws',
  'http://alternativechatai.ct.ws',
  'https://alter-ai-bmbd3azfg-alvaro19371s-projects.vercel.app',
  null,
];

function needsSearch(text) {
  const t = text.toLowerCase().trim();
  const skip = ['siapa kamu','kamu siapa','siapa pembuat','siapa yang buat',
    'siapa ceo','siapa pemilik','siapa founder','nama kamu',
    'alterx','alternative inc','alvaro','model apa','versi kamu',
    'hi','halo','hey','hello','hai','hei','apa kabar',
    'selamat pagi','selamat siang','selamat malam','makasih','terima kasih'];
  if (skip.some(s => t.includes(s))) return false;

  const triggers = [
    'siapa','apa itu','apa yang','jelaskan','bagaimana','kapan',
    'dimana','berapa','kenapa','mengapa','cara','tutorial',
    'berita','terbaru','terkini','sekarang','hari ini','harga',
    'cuaca','jadwal','definisi','pengertian','contoh','rumus',
    'fakta','perbedaan','perbandingan','kelebihan','kekurangan',
    'rekomendasi','tips','trik','langkah','fungsi','manfaat',
    'what is','what are','who is','who are','how to','how do',
    'when did','when is','where is','where are','why is','why does',
    'explain','define','latest','recent','news','current','today',
    'difference','compare','best','top','list of','example',
  ];
  if (triggers.some(tr => t.includes(tr))) return true;
  return t.split(/\s+/).length >= 5;
}

async function webSearch(query) {
  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, num: 5, hl: 'id', gl: 'id' }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const results = [];
    if (json.answerBox?.answer) results.push(`📌 ${json.answerBox.answer}`);
    if (json.answerBox?.snippet) results.push(`📌 ${json.answerBox.snippet}`);
    if (json.organic?.length) {
      json.organic.slice(0, 5).forEach(r => {
        if (r.snippet) results.push(`• ${r.title}\n  ${r.snippet}\n  (${r.link})`);
      });
    }
    return results.length ? results.join('\n\n') : null;
  } catch { return null; }
}

// Convert OpenAI-style messages to Gemini format
function toGeminiMessages(messages) {
  const systemMsg = messages.find(m => m.role === 'system');
  const systemInstruction = systemMsg ? { parts: [{ text: systemMsg.content }] } : null;

  const contents = messages
    .filter(m => m.role !== 'system')
    .map(m => {
      // Handle array content (vision)
      if (Array.isArray(m.content)) {
        const parts = m.content.map(c => {
          if (c.type === 'text') return { text: c.text };
          if (c.type === 'image_url') {
            // data:mime;base64,xxx
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

  // Ambil pesan terakhir user
  let lastUserMsg = '';
  for (const m of [...messages].reverse()) {
    if (m.role === 'user') { lastUserMsg = m.content; break; }
  }
  const lastUserText = Array.isArray(lastUserMsg)
    ? (lastUserMsg.find(c => c.type === 'text')?.text || '')
    : lastUserMsg;

  // Inject search result
  const hasImage = Array.isArray(lastUserMsg);
  if (!hasImage && needsSearch(lastUserText)) {
    const searchResult = await webSearch(lastUserText);
    if (searchResult) {
      const ctx = `\n\n[HASIL PENCARIAN GOOGLE untuk: "${lastUserText}"]\n`
        + searchResult
        + `\n\nGunakan informasi di atas untuk menjawab dengan akurat dan terkini. `
        + `Jawab secara natural, jangan sebut bahwa kamu melakukan pencarian.`;
      messages = messages.map(m =>
        m.role === 'system' ? { ...m, content: m.content + ctx } : m
      );
    }
  }

  // Kirim ke Gemini
  try {
    const model = 'gemini-1.5-flash';
    const { systemInstruction, contents } = toGeminiMessages(messages);

    const body = {
      contents,
      generationConfig: {
        maxOutputTokens: 2048,
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

    // Convert Gemini response to OpenAI-compatible format
    const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return res.status(200).json({
      choices: [{ message: { role: 'assistant', content: text } }]
    });

  } catch (e) {
    return res.status(500).json({ error: 'Gagal menghubungi AI: ' + e.message });
  }
}

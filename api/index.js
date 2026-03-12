const GROQ_API_KEY   = process.env.GROQ_API_KEY   || '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';
const SERPER_API_KEY = process.env.SERPER_API_KEY || 'P07d1936b9301c7dcc4749e484f2b9e5ecd495574';

const ALLOWED_ORIGINS = [
  'https://chat.alvaspec.my.id',
  'http://chat.alvaspec.my.id',
  'https://alternativechatai.ct.ws',
  'http://alternativechatai.ct.ws',
  'https://alter-ai-bmbd3azfg-alvaro19371s-projects.vercel.app',
  null, // allow no-origin requests
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
      headers: {
        'X-API-KEY': SERPER_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: query, num: 5, hl: 'id', gl: 'id' }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const results = [];
    // Ambil answer box kalau ada
    if (json.answerBox?.answer) results.push(`📌 ${json.answerBox.answer}`);
    if (json.answerBox?.snippet) results.push(`📌 ${json.answerBox.snippet}`);
    // Ambil organic results
    if (json.organic?.length) {
      json.organic.slice(0, 5).forEach(r => {
        if (r.snippet) results.push(`• ${r.title}\n  ${r.snippet}\n  (${r.link})`);
      });
    }
    return results.length ? results.join('\n\n') : null;
  } catch { return null; }
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
  // Extract plain text if content is array (vision message)
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

  // Kirim ke Groq
  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: data.model || 'llama-3.3-70b-versatile',
        max_tokens: 2048,
        temperature: 0.7,
        messages,
      }),
    });

    const groqData = await groqRes.json();
    if (groqData.error) {
      const errMsg = groqData.error.message || '';
      const errType = groqData.error.type || '';
      // Decommissioned model
      if (errMsg.includes('decommissioned') || errMsg.includes('no longer supported')) {
        return res.status(500).json({ error: '__MODEL_UNAVAILABLE__' });
      }
      // Rate limit / token limit
      if (groqRes.status === 429 || errType === 'tokens' || errMsg.includes('rate_limit') || errMsg.includes('Rate limit')) {
        // Try to extract reset time from headers
        const resetTokens = groqRes.headers.get('x-ratelimit-reset-tokens') || '';
        const resetReqs   = groqRes.headers.get('x-ratelimit-reset-requests') || '';
        const resetTime   = resetTokens || resetReqs || '';
        return res.status(429).json({ error: '__RATE_LIMIT__', resetTime });
      }
      return res.status(500).json({ error: errMsg || 'Groq API error' });
    }

    return res.status(200).json(groqData);
  } catch (e) {
    return res.status(500).json({ error: 'Gagal menghubungi AI: ' + e.message });
  }
}

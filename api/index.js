const HF_API_KEY    = process.env.HF_API_KEY;
const SERPER_API_KEY = process.env.SERPER_API_KEY;

const HF_MODEL = 'Qwen/Qwen2.5-72B-Instruct';

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
    'alterx','alternative studios','alvaro','model apa','versi kamu',
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

  // Inject web search
  const hasImage = Array.isArray(lastUserMsg);
  if (!hasImage && needsSearch(lastUserText)) {
    const searchResult = await webSearch(lastUserText);
    if (searchResult) {
      const ctx = `\n\n[HASIL PENCARIAN WEB untuk: "${lastUserText}"]\n`
        + searchResult
        + `\n\nGunakan informasi di atas untuk menjawab dengan akurat dan terkini. `
        + `Jawab secara natural, jangan sebut bahwa kamu melakukan pencarian.`;
      messages = messages.map(m =>
        m.role === 'system' ? { ...m, content: m.content + ctx } : m
      );
    }
  }

  // Convert messages for HF — handle vision (image) content
  const hfMessages = messages.map(m => {
    if (Array.isArray(m.content)) {
      // HF supports vision via content array
      const parts = m.content.map(c => {
        if (c.type === 'text') return { type: 'text', text: c.text };
        if (c.type === 'image_url') return { type: 'image_url', image_url: { url: c.image_url.url } };
        return null;
      }).filter(Boolean);
      return { role: m.role, content: parts };
    }
    return { role: m.role, content: m.content };
  });

  try {
    const hfRes = await fetch(
      `https://router.huggingface.co/v1/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${HF_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: HF_MODEL,
          messages: hfMessages,
          max_tokens: 4096,
          temperature: 0.7,
          stream: false,
        }),
      }
    );

    const hfData = await hfRes.json();

    if (hfData.error) {
      const errMsg = typeof hfData.error === 'string' ? hfData.error : hfData.error?.message || 'HF API error';
      if (hfRes.status === 429 || errMsg.includes('rate limit') || errMsg.includes('high demand')) {
        return res.status(429).json({ error: '__RATE_LIMIT__', resetTime: '60s' });
      }
      if (errMsg.includes('not found') || errMsg.includes('loading')) {
        return res.status(500).json({ error: '__MODEL_UNAVAILABLE__' });
      }
      return res.status(500).json({ error: errMsg });
    }

    // HF returns OpenAI-compatible format — pass through directly
    return res.status(200).json(hfData);

  } catch (e) {
    return res.status(500).json({ error: 'Gagal menghubungi AI: ' + e.message });
  }
}

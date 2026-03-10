const GROQ_API_KEY   = process.env.GROQ_API_KEY   || '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';
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || 'AIzaSyBtLoOaJZcR4r_qUFfrT-LIi_obFsapoKs';
const GOOGLE_CX      = process.env.GOOGLE_CX      || '65f7a9d97cdc54e3a';

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

async function googleSearch(query) {
  try {
    const url = 'https://www.googleapis.com/customsearch/v1?' + new URLSearchParams({
      key: GOOGLE_API_KEY, cx: GOOGLE_CX, q: query, num: '5', hl: 'id',
    });
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    if (!json.items?.length) return null;
    return json.items
      .filter(i => i.snippet)
      .map(i => `• ${i.title}\n  ${i.snippet}\n  (${i.link})`)
      .join('\n\n');
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

  // Inject search result
  if (needsSearch(lastUserMsg)) {
    const searchResult = await googleSearch(lastUserMsg);
    if (searchResult) {
      const ctx = `\n\n[HASIL PENCARIAN GOOGLE untuk: "${lastUserMsg}"]\n`
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
        model: 'llama-3.3-70b-versatile',
        max_tokens: 2048,
        temperature: 0.7,
        messages,
      }),
    });

    const groqData = await groqRes.json();
    if (groqData.error)
      return res.status(500).json({ error: groqData.error.message || 'Groq API error' });

    return res.status(200).json(groqData);
  } catch (e) {
    return res.status(500).json({ error: 'Gagal menghubungi AI: ' + e.message });
  }
}

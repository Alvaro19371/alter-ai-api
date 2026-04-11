const HF_API_KEY     = process.env.HF_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const HF_MODEL       = 'Qwen/Qwen2.5-72B-Instruct';

const ALLOWED_ORIGINS = [
  'https://chat.alvaspec.my.id',
  'http://chat.alvaspec.my.id',
  'https://alternativechatai.ct.ws',
  'http://alternativechatai.ct.ws',
  'https://alter-ai-bmbd3azfg-alvaro19371s-projects.vercel.app',
  null,
];

// Get current date string for injecting into search queries
function getTodayStr() {
  const d = new Date();
  return d.toISOString().split('T')[0]; // e.g. "2026-04-11"
}

function needsSearch(text) {
  const t = text.toLowerCase().trim();
  const skip = [
    // Identity & creator
    'siapa kamu','kamu siapa','siapa pembuat','siapa yang buat',
    'siapa ceo','siapa pemilik','siapa founder','nama kamu',
    'alterx','alternative studios','alvaro','model apa','versi kamu',
    'kamu dibuat','yang membuatmu','siapa developermu','kamu buatan',
    'kamu dari','kamu produk','tentang kamu','tentang dirimu',
    'who made you','who created you','who built you','what are you',
    'what model','your creator','your developer','your company',
    // Feelings / self-reflection
    'apakah kamu bangga','kamu bangga','kamu senang','kamu sedih',
    'kamu suka','kamu benci','kamu takut','kamu marah','kamu bahagia',
    'perasaanmu','bagaimana perasaan','apakah kamu merasa',
    'are you proud','do you feel','how do you feel','do you like',
    'do you love','are you happy','are you sad',
    // Greetings / small talk
    'hi','halo','hey','hello','hai','hei','apa kabar','hows it going',
    'selamat pagi','selamat siang','selamat malam','makasih','terima kasih',
    'good morning','good night','good evening','thanks','thank you',
    // Capabilities
    'apa yang bisa kamu','kamu bisa apa','kemampuanmu','fitur kamu',
    'what can you do','your capabilities','your features',
  ];
  if (skip.some(s => t.includes(s))) return false;
  const triggers = [
    'siapa','apa itu','apa yang','jelaskan','bagaimana','kapan',
    'dimana','berapa','kenapa','mengapa','cara','tutorial',
    'berita','terbaru','terkini','sekarang','hari ini','harga',
    'cuaca','jadwal','definisi','pengertian','contoh','rumus',
    'fakta','perbedaan','perbandingan','kelebihan','kekurangan',
    'rekomendasi','tips','trik','langkah','fungsi','manfaat',
    'sudah','belum','apakah','gimana kabar',
    'what is','what are','who is','who are','how to','how do',
    'when did','when is','where is','where are','why is','why does',
    'explain','define','latest','recent','news','current','today',
    'difference','compare','best','top','list of','example',
    'has','have','did','does','is it','are they',
  ];
  if (triggers.some(tr => t.includes(tr))) return true;
  return t.split(/\s+/).length >= 4;
}

async function tavilySearch(query) {
  try {
    // Inject today's date into query for recency
    const today = getTodayStr();
    const enrichedQuery = `${query} (as of ${today})`;

    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query: enrichedQuery,
        search_depth: 'advanced',
        max_results: 6,
        include_answer: true,
        include_raw_content: false,
        include_domains: [],
        exclude_domains: [],
      }),
    });
    if (!res.ok) return null;
    const json = await res.json();

    const sources = [];
    let out = '';

    // Direct answer from Tavily
    if (json.answer) {
      out += `📌 ${json.answer}\n\n`;
    }

    // Organic results
    if (json.results?.length) {
      json.results.forEach(r => {
        if (r.content) {
          out += `• ${r.title}\n  ${r.content.slice(0, 300)}\n  (${r.url})\n\n`;
          try {
            const domain = new URL(r.url).hostname.replace('www.','');
            if (!sources.find(s => s.domain === domain)) {
              sources.push({ domain, url: r.url, title: r.title });
            }
          } catch {}
        }
      });
    }

    return out.trim() ? { text: out.trim(), sources } : null;
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
  let searchSources = [];

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
    const searchResult = await tavilySearch(lastUserText);
    if (searchResult) {
      searchSources = searchResult.sources || [];
      const today = getTodayStr();
      const ctx = `\n\n[HASIL PENCARIAN WEB — ${today} — untuk: "${lastUserText}"]\n`
        + searchResult.text
        + `\n\nINSTRUKSI: Gunakan informasi di atas untuk menjawab. `
        + `Tanggal hari ini adalah ${today}. `
        + `Jawab berdasarkan fakta terbaru yang ada. `
        + `Jangan sebut bahwa kamu melakukan pencarian.`;
      messages = messages.map(m =>
        m.role === 'system' ? { ...m, content: m.content + ctx } : m
      );
    }
  }

  // Convert messages for HF
  const hfMessages = messages.map(m => {
    if (Array.isArray(m.content)) {
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
    const hfRes = await fetch('https://router.huggingface.co/v1/chat/completions', {
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
    });

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

    // Return with sources for frontend to render
    return res.status(200).json({
      ...hfData,
      sources: searchSources,
    });

  } catch (e) {
    return res.status(500).json({ error: 'Gagal menghubungi AI: ' + e.message });
  }
}

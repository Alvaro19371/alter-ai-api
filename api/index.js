const GROQ_API_KEY   = process.env.GROQ_API_KEY;
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const GROQ_MODEL     = 'llama-3.3-70b-versatile';

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
    // Identity
    'siapa kamu','kamu siapa','siapa pembuat','siapa yang buat',
    'siapa ceo','siapa pemilik','siapa founder','nama kamu',
    'alterx','alterx nexus','alternative studios','alternative inc','alvaro',
    'model apa','versi kamu','kamu dibuat','kamu buatan','tentang kamu',
    'who made you','who created you','what are you','what model','your creator',
    // Feelings / self
    'apakah kamu bangga','kamu bangga','kamu senang','kamu sedih','kamu suka',
    'perasaanmu','bagaimana perasaan','apakah kamu merasa','kamu punya perasaan',
    'apakah kamu punya','kamu sadar','kamu hidup','kamu nyata',
    'are you proud','do you feel','how do you feel','do you like','do you love',
    'are you conscious','are you alive','are you real','do you have feelings',
    // Opinion
    'menurut kamu','pendapat kamu','kamu pikir','kamu rasa','favorit kamu',
    'what do you think','in your opinion','do you prefer','your favorite',
    // Greetings
    'hi','halo','hey','hello','hai','hei','apa kabar','pagi','siang','malam','sore',
    'selamat pagi','selamat siang','selamat malam','makasih','terima kasih',
    'good morning','good night','good evening','thanks','thank you',
    // Capabilities
    'apa yang bisa kamu','kamu bisa apa','kemampuanmu','fitur kamu','bisa bantu apa',
    'what can you do','your capabilities','your features',
    // Date/time (already in system prompt)
    'sekarang jam','jam berapa','tanggal berapa','hari ini tanggal',
    'what time is it','what date is it','what day is it',
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
  const groqMessages = messages.map(m => {
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
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: groqMessages,
        max_tokens: 4096,
        temperature: 0.7,
      }),
    });

    const groqData = await groqRes.json();

    if (groqData.error) {
      const errMsg = groqData.error.message || '';
      const errType = groqData.error.type || '';
      if (errMsg.includes('decommissioned') || errMsg.includes('no longer supported')) {
        return res.status(500).json({ error: '__MODEL_UNAVAILABLE__' });
      }
      if (groqRes.status === 429 || errType === 'tokens' || errMsg.includes('rate_limit')) {
        const resetTokens = groqRes.headers.get('x-ratelimit-reset-tokens') || '';
        const resetReqs   = groqRes.headers.get('x-ratelimit-reset-requests') || '';
        return res.status(429).json({ error: '__RATE_LIMIT__', resetTime: resetTokens || resetReqs || '60s' });
      }
      return res.status(500).json({ error: errMsg || 'Groq API error' });
    }

    // Return with sources for frontend to render
    return res.status(200).json({
      ...groqData,
      sources: searchSources,
    });

  } catch (e) {
    return res.status(500).json({ error: 'Gagal menghubungi AI: ' + e.message });
  }
}

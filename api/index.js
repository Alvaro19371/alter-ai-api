// ══════════════════════════════════════════════════════════════
//  Alter AI Backend — api/index.js
//  Multi-key Groq rotation + per-user/guest slot isolation
//  + Syntax Mode (openai/gpt-oss-120b)
// ══════════════════════════════════════════════════════════════
//
//  ┌──────────────────────────────────────────────────────────┐
//  │  SETUP ENV VARS DI VERCEL                               │
//  ├──────────────────────────────────────────────────────────┤
//  │  GROQ_API_KEY          → Alter AI key utama (wajib)     │
//  │  GROQ_API_KEY_2        → Alter AI key ke-2 (opsional)   │
//  │  GROQ_API_KEY_3        → Alter AI key ke-3 (opsional)   │
//  │                                                          │
//  │  GROQ_API_KEY_SYNTAX   → Logic One key (opsional)        │
//  │  GROQ_API_KEY_SYNTAX_2 → Logic One key ke-2 (opsional)  │
//  │                                                          │
//  │  TAVILY_API_KEY        → web search (wajib)             │
//  │  TAVILY_API_KEY_2      → Tavily key ke-2 (opsional)     │
//  │                                                          │
//  │  API_TOKEN             → secret token (WAJIB untuk      │
//  │                          keamanan). Set sembarang string │
//  │                          panjang, lalu masukkan value    │
//  │                          yang SAMA ke index.html di      │
//  │                          variabel _API_TOKEN.            │
//  └──────────────────────────────────────────────────────────┘
//
//  CARA DAPAT GROQ API KEY UNTUK openai/gpt-oss-120b:
//  1. Buka https://console.groq.com
//  2. Login / buat akun
//  3. Klik "API Keys" di sidebar → "Create API Key"
//  4. Kasih nama misal "syntax-key"
//  5. Copy key-nya (mulai dari "gsk_...")
//  6. Di Vercel: Settings → Environment Variables
//     → Name: GROQ_API_KEY_SYNTAX
//     → Value: gsk_xxxxxxxxxxxx
//  7. Redeploy
//
//  NOTE: openai/gpt-oss-120b tersedia di Groq sebagai preview model.
//  Kalau mau pisahkan quota Syntax dari Alter AI, buat API key baru
//  di Groq dan taruh di GROQ_API_KEY_SYNTAX.
//  Kalau mau share key yang sama, kosongkan GROQ_API_KEY_SYNTAX —
//  backend otomatis fallback ke GROQ_API_KEY pool.
// ══════════════════════════════════════════════════════════════
//
//  Strategy:
//  - Tiap request pilih Groq key berdasarkan:
//      (globalCallCounter + userSlot) % totalKeys
//  - userSlot dikirim frontend via header X-User-Slot
//  - Kalau key yang dipilih hit 429, otomatis fallback ke key berikutnya
//  - Guest user: slot random per session tab → distribusi merata
//  - Logged-in user: slot deterministik dari UID → user yg sama
//    selalu mulai dari key yang sama tapi beda dari user lain
//  - globalCallCounter di-increment setiap request (in-memory,
//    reset tiap cold start — fine untuk Vercel serverless)
// ══════════════════════════════════════════════════════════════

// ── Build key pool dari env vars ──
function buildKeyPool(prefix) {
  const keys = [];
  // Key pertama
  if (process.env[prefix]) keys.push(process.env[prefix]);
  // Key ke-2 s/d ke-10
  for (let i = 2; i <= 10; i++) {
    const k = process.env[`${prefix}_${i}`];
    if (k) keys.push(k);
  }
  return keys;
}

const GROQ_KEYS        = buildKeyPool('GROQ_API_KEY');
const GROQ_KEYS_SYNTAX = buildKeyPool('GROQ_API_KEY_SYNTAX'); // key khusus Syntax/GPT-OSS
const TAVILY_KEYS      = buildKeyPool('TAVILY_API_KEY');

// ── Model alias map — frontend kirim alias, backend resolve ke model nyata ──
// Ini menyembunyikan nama model asli dari source frontend
const MODEL_MAP = {
  'alterai':   'qwen/qwen3.8-27b',
  'logic-one': 'openai/gpt-oss-120b',
};
const MODEL_ALTERAI = MODEL_MAP['alterai'];
const MODEL_LOGIC   = MODEL_MAP['logic-one'];

if (GROQ_KEYS.length === 0) {
  console.error('[AlterAI] WARNING: No GROQ_API_KEY found in environment!');
}

// ── Global round-robin counter (in-memory, per cold-start) ──
let _globalCounter = 0;

function getGroqKey(userSlot = 0, pool = GROQ_KEYS) {
  if (pool.length === 0) return null;
  const idx = (_globalCounter + userSlot) % pool.length;
  _globalCounter++;
  return { key: pool[idx], idx };
}

function getTavilyKey(userSlot = 0) {
  if (TAVILY_KEYS.length === 0) return null;
  return TAVILY_KEYS[userSlot % TAVILY_KEYS.length];
}

// ── Allowed origins — only these may call the API ──
// 'null' di-remove: file:// dan unknown origin TIDAK boleh lewat
const ALLOWED_ORIGINS = new Set([
  'https://chat.alvaspec.my.id',
  'https://indonesiaglobal.sch.id',
  'https://alternativechatai.ct.ws',
  'https://alter-ai-bmbd3azfg-alvaro19371s-projects.vercel.app',
]);

// ── Secret token — set API_TOKEN env var di Vercel ──
// Frontend harus kirim header: X-API-Token: <value>
// Tanpa token yang benar → 401 Unauthorized
const API_TOKEN = process.env.API_TOKEN || null;

// ── Helpers ──
function getTodayStr() {
  return new Date().toISOString().split('T')[0];
}

function needsSearch(text) {
  const t = text.toLowerCase().trim();
  const skip = [
    'siapa kamu','kamu siapa','siapa pembuat','siapa yang buat',
    'siapa ceo','siapa pemilik','siapa founder','nama kamu',
    'alterx','alterx nexus','alternative studios','alternative inc','alvaro',
    'model apa','versi kamu','kamu dibuat','kamu buatan','tentang kamu',
    'who made you','who created you','what are you','what model','your creator',
    'apakah kamu bangga','kamu bangga','kamu senang','kamu sedih','kamu suka',
    'perasaanmu','bagaimana perasaan','apakah kamu merasa','kamu punya perasaan',
    'apakah kamu punya','kamu sadar','kamu hidup','kamu nyata',
    'are you proud','do you feel','how do you feel','do you like','do you love',
    'are you conscious','are you alive','are you real','do you have feelings',
    'menurut kamu','pendapat kamu','kamu pikir','kamu rasa','favorit kamu',
    'what do you think','in your opinion','do you prefer','your favorite',
    'hi','halo','hey','hello','hai','hei','apa kabar','pagi','siang','malam','sore',
    'selamat pagi','selamat siang','selamat malam','makasih','terima kasih',
    'good morning','good night','good evening','thanks','thank you',
    'apa yang bisa kamu','kamu bisa apa','kemampuanmu','fitur kamu','bisa bantu apa',
    'what can you do','your capabilities','your features',
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

async function tavilySearch(query, userSlot = 0) {
  const apiKey = getTavilyKey(userSlot);
  if (!apiKey) return null;
  try {
    const today = getTodayStr();
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query: `${query} (as of ${today})`,
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
    if (json.answer) out += `📌 ${json.answer}\n\n`;
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

// ── Core: call Groq with auto-fallback on 429 ──
async function callGroq(messages, userSlot, model = MODEL_ALTERAI, attempt = 0) {
  // Pilih key pool: Syntax model punya pool sendiri (kalau diset), fallback ke pool utama
  const isLogicOne = model === MODEL_LOGIC;
  const pool = (isLogicOne && GROQ_KEYS_SYNTAX.length > 0) ? GROQ_KEYS_SYNTAX : GROQ_KEYS;

  if (attempt >= pool.length) {
    return {
      status: 429,
      body: { error: '__RATE_LIMIT__', resetTime: '60s', keysExhausted: true }
    };
  }

  let keyInfo;
  if (attempt === 0) {
    keyInfo = getGroqKey(userSlot, pool);
  } else {
    const prevIdx = (_globalCounter - 1 + userSlot) % pool.length;
    const nextIdx = (prevIdx + attempt) % pool.length;
    keyInfo = { key: pool[nextIdx], idx: nextIdx };
  }

  if (!keyInfo?.key) {
    return { status: 500, body: { error: 'No API key available' } };
  }

  console.log(`[AlterAI] model=${model} key#${keyInfo.idx + 1}/${pool.length} slot=${userSlot} attempt=${attempt}`);

  const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${keyInfo.key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: 8192,
      temperature: isLogicOne ? 0.4 : 0.7,
    }),
  });

  const groqData = await groqRes.json();

  // ── Handle errors ──
  if (groqData.error) {
    const errMsg  = groqData.error.message || '';
    const errType = groqData.error.type    || '';

    // Model decommissioned
    if (errMsg.includes('decommissioned') || errMsg.includes('no longer supported')) {
      return { status: 500, body: { error: '__MODEL_UNAVAILABLE__' } };
    }

    // Rate limit → auto-fallback ke key berikutnya
    if (groqRes.status === 429 || errType === 'tokens' || errMsg.includes('rate_limit')) {
      console.log(`[AlterAI] Key #${keyInfo.idx + 1} hit rate limit — trying next key...`);
      return callGroq(messages, userSlot, model, attempt + 1);
    }

    return { status: 500, body: { error: errMsg || 'Groq API error' } };
  }

  return { status: 200, body: groqData, keyIdx: keyInfo.idx };
}

// ── Main handler ──
export default async function handler(req, res) {
  const origin = req.headers['origin'] || '';

  // ── CORS: hanya izinkan origin yang terdaftar ──
  // Kalau buka dari file:// atau domain lain → origin tidak ada di whitelist
  // → browser tidak dapat akses (blocked by CORS)
  // Tambahan: cek secret token untuk blokir request non-browser juga
  if (!ALLOWED_ORIGINS.has(origin)) {
    // Jangan kasih info apa pun — cukup 403
    return res.status(403).end();
  }

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-User-Slot, X-Call-Count, X-API-Token');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).end();

  // ── Secret token check — blokir curl/Postman/script langsung ──
  if (API_TOKEN) {
    const sentToken = req.headers['x-api-token'] || '';
    if (sentToken !== API_TOKEN) {
      return res.status(401).end(); // jangan kasih info error
    }
  }

  const data = req.body;
  if (!data?.messages || !Array.isArray(data.messages))
    return res.status(400).json({ error: 'Invalid request body' });

  // ── Parse user slot from frontend header ──
  const rawSlot = req.headers['x-user-slot'];
  const userSlot = rawSlot ? (parseInt(rawSlot, 10) || 0) : 0;

  // ── Resolve model via alias map — frontend kirim alias, bukan nama asli ──
  const alias = data.model || 'alterai';
  const resolvedModel = MODEL_MAP[alias] || MODEL_ALTERAI;
  if (!MODEL_MAP[alias]) {
    console.warn(`[AlterAI] Unknown model alias "${alias}", fallback to alterai`);
  }

  let messages = data.messages;
  let searchSources = [];

  // ── Web search injection ──
  let lastUserMsg = '';
  for (const m of [...messages].reverse()) {
    if (m.role === 'user') { lastUserMsg = m.content; break; }
  }
  const lastUserText = Array.isArray(lastUserMsg)
    ? (lastUserMsg.find(c => c.type === 'text')?.text || '')
    : lastUserMsg;

  const hasImage = Array.isArray(lastUserMsg);
  if (!hasImage && needsSearch(lastUserText)) {
    const searchResult = await tavilySearch(lastUserText, userSlot);
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

  // ── Convert messages for Groq ──
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

  // ── Call Groq with auto key rotation ──
  try {
    const result = await callGroq(groqMessages, userSlot, resolvedModel);

    if (result.status !== 200) {
      // Semua key kena rate limit
      if (result.body?.error === '__RATE_LIMIT__' && result.body?.keysExhausted) {
        return res.status(429).json({
          error: '__RATE_LIMIT__',
          resetTime: '2m',
          message: 'Semua API key sedang overload. Coba lagi dalam 2 menit.'
        });
      }
      return res.status(result.status).json(result.body);
    }

    return res.status(200).json({
      ...result.body,
      sources: searchSources,
      // Debug info (bisa dihapus di production)
      _keyUsed: result.keyIdx + 1,
      _totalKeys: GROQ_KEYS.length,
    });

  } catch (e) {
    console.error('[AlterAI] Unhandled error:', e);
    return res.status(500).json({ error: 'Gagal menghubungi AI: ' + e.message });
  }
}

// GET /api/brief — pulls the news feeds, asks Groq for a short brief, returns JSON.
// The Groq key lives in the GROQ_API_KEY environment variable on Vercel, never in the page.
// Vercel's edge cache keeps the result for 30 minutes, so Groq is called at most ~2x an hour.

const FEEDS = {
  indonesia: [
    { source: 'Detik', url: 'https://news.detik.com/berita/rss' },
    { source: 'Antara', url: 'https://www.antaranews.com/rss/terkini.xml' },
    { source: 'CNN ID', url: 'https://www.cnnindonesia.com/rss' },
    // Business & markets: IHSG, rupiah, BI rate, MSCI etc. mostly only show up here.
    { source: 'Detik Finance', url: 'https://finance.detik.com/rss' },
    { source: 'CNBC ID', url: 'https://www.cnbcindonesia.com/market/rss' },
    { source: 'CNN ID Ekonomi', url: 'https://www.cnnindonesia.com/ekonomi/rss' },
  ],
  world: [
    { source: 'Guardian', url: 'https://www.theguardian.com/world/rss' },
    { source: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml' },
    { source: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
  ],
};
const PER_FEED = 10;
const PICK = 4;
// Tried in order; the first one this key can use wins. GROQ_MODEL (optional) goes first.
const MODELS = [process.env.GROQ_MODEL, 'llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.1-8b-instant'].filter(Boolean);
let workingModel = null; // remembered while the function instance stays warm

const decode = (s = '') =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\s+/g, ' ')
    .trim();

function parseFeed(xml) {
  const blocks = xml.split(/<item[\s>]|<entry[\s>]/).slice(1);
  return blocks.map((b) => {
    const tag = (name) => (b.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)) || [])[1];
    const link = (b.match(/<link[^>]*href="([^"]+)"/) || [])[1] || decode(tag('link'));
    return {
      title: decode(tag('title')),
      link,
      ts: Date.parse(decode(tag('pubDate') || tag('published') || tag('updated') || '')) || Date.now(),
      text: decode(tag('description') || tag('summary') || tag('content') || '').slice(0, 160),
    };
  }).filter((i) => i.title && i.link);
}

async function getFeed({ source, url }) {
  const opts = { headers: { 'user-agent': 'Mozilla/5.0 (marvell-dash news brief)' }, signal: AbortSignal.timeout(8000) };
  try {
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error(r.status);
    const items = parseFeed(await r.text());
    if (!items.length) throw new Error('empty');
    return items.slice(0, PER_FEED).map((i) => ({ ...i, source }));
  } catch {
    // Some sites block server requests; rss2json usually still gets through.
    try {
      const r = await fetch('https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent(url), { signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      return (j.items || []).slice(0, PER_FEED).map((i) => ({
        title: decode(i.title), link: i.link, source,
        ts: Date.parse((i.pubDate || '').replace(' ', 'T') + 'Z') || Date.now(),
        text: decode(i.description || '').slice(0, 160),
      }));
    } catch {
      return [];
    }
  }
}

async function askGroq(pool) {
  const list = (group) =>
    pool[group].map((i, n) => `${group[0].toUpperCase()}${n}: [${i.source}] ${i.title}${i.text ? ' — ' + i.text : ''}`).join('\n');

  const system = `You write a calm, short daily news brief for a young freelance video editor in Semarang, Indonesia.
You only use facts that appear in the headlines given to you. Never invent details, numbers or quotes.
Write in plain, simple English (translate Indonesian headlines).`;

  const user = `Pick the ${PICK} most important stories for INDONESIA (ids starting with I) and the ${PICK} most important for WORLD (ids starting with W).
Rank by national or global significance, i.e. what affects the most people's money, safety or daily life:
1. Big economy and market moves (stock index IHSG, rupiah, interest rates, MSCI/rating decisions, fuel or food prices, layoffs)
2. National policy, laws, elections and major court or corruption cases
3. Disasters, major accidents, public health
4. Big tech and science news
A story that several different sources cover is usually a big one: rank it high, and merge the coverage into one pick.
Local crime, ceremonies, inaugurations, minor regional news, celebrity gossip, sponsored/press-release items and sports results rank low; skip them unless nothing else is available.
For each pick give:
- "id": the exact id, e.g. "I3"
- "headline": max 9 words, plain words, no clickbait
- "summary": one sentence, max 24 words, what happened and why it matters
Also give two one-line overviews, each one sentence, max 20 words:
- "tldr_indonesia": the overall picture in Indonesia today (only Indonesian stories)
- "tldr_world": the overall picture in the rest of the world today (only world stories)

Reply with JSON only: {"tldr_indonesia": "...", "tldr_world": "...", "indonesia": [{"id","headline","summary"}], "world": [{"id","headline","summary"}]}

INDONESIA
${list('indonesia')}

WORLD
${list('world')}`;

  const call = async (model) => {
    const body = {
      model,
      temperature: 0.3,
      max_tokens: 2000,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    };
    if (model.startsWith('openai/gpt-oss')) body.reasoning_effort = 'low';
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });
    const text = await r.text();
    if (!r.ok) throw Object.assign(new Error(`groq ${r.status}: ${text.slice(0, 200)}`), { status: r.status, modelMissing: /model_not_found|does not exist|decommissioned|not have access/i.test(text) });
    const content = JSON.parse(text).choices[0].message.content || '';
    return JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1));
  };

  // Models this key can see, used when none of the preferred ones are available.
  const listModels = async () => {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/models', { headers: { authorization: `Bearer ${process.env.GROQ_API_KEY}` }, signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      return (j.data || []).map((m) => m.id).filter((id) => !/whisper|guard|tts|orpheus|playai|vision|compound|safeguard/i.test(id));
    } catch {
      return [];
    }
  };

  let candidates = workingModel ? [workingModel, ...MODELS.filter((m) => m !== workingModel)] : [...MODELS];
  let listed = false;
  let lastErr;
  for (let i = 0; i < candidates.length; i++) {
    try {
      const out = await call(candidates[i]);
      workingModel = candidates[i];
      return { ...out, _model: candidates[i] };
    } catch (e) {
      lastErr = e;
      if (!e.modelMissing && !(e instanceof SyntaxError)) throw e; // auth / rate limit: stop here
      if (i === candidates.length - 1 && !listed) {
        listed = true;
        candidates = candidates.concat((await listModels()).filter((m) => !candidates.includes(m)).slice(0, 4));
      }
    }
  }
  throw lastErr || new Error('no usable Groq model');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!process.env.GROQ_API_KEY) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(503).json({ error: 'no_key', message: 'Set GROQ_API_KEY in Vercel → Settings → Environment Variables, then redeploy.' });
  }
  try {
    const groups = Object.keys(FEEDS);
    const pool = {};
    for (const g of groups) {
      const lists = await Promise.all(FEEDS[g].map(getFeed));
      // Interleave sources so one feed can't crowd out the others.
      const merged = [];
      for (let k = 0; k < PER_FEED; k++) for (const l of lists) if (l[k]) merged.push(l[k]);
      pool[g] = merged;
    }
    if (!pool.indonesia.length && !pool.world.length) throw new Error('all feeds failed');

    const ai = await askGroq(pool);

    // Map the model's ids back to the real articles, so every link is a real one.
    const pick = (g) =>
      (ai[g] || [])
        .map((p) => {
          const n = parseInt(String(p.id || '').slice(1), 10);
          const src = pool[g][n];
          if (!src || !p.headline) return null;
          return { headline: String(p.headline), summary: String(p.summary || ''), source: src.source, link: src.link, ts: src.ts, original: src.title };
        })
        .filter(Boolean)
        .filter((x, i, a) => a.findIndex((y) => y.link === x.link) === i)
        .slice(0, PICK);

    const out = { generatedAt: Date.now(), model: ai._model, tldr: { indonesia: String(ai.tldr_indonesia || ''), world: String(ai.tldr_world || '') }, indonesia: pick('indonesia'), world: pick('world') };
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    return res.status(200).json(out);
  } catch (e) {
    res.setHeader('Cache-Control', 's-maxage=60');
    return res.status(502).json({ error: 'brief_failed', message: String(e.message || e).slice(0, 300) });
  }
}

// GET /api/brief — pulls the news feeds, asks Groq for a short brief, returns JSON.
// The Groq key lives in the GROQ_API_KEY environment variable on Vercel, never in the page.
// Vercel's edge cache keeps the result for 30 minutes, so Groq is called at most ~2x an hour.

const FEEDS = {
  indonesia: [
    { source: 'Detik', url: 'https://news.detik.com/berita/rss' },
    { source: 'Antara', url: 'https://www.antaranews.com/rss/terkini.xml' },
    { source: 'CNN ID', url: 'https://www.cnnindonesia.com/rss' },
  ],
  world: [
    { source: 'Guardian', url: 'https://www.theguardian.com/world/rss' },
    { source: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml' },
    { source: 'The Verge', url: 'https://www.theverge.com/rss/index.xml' },
  ],
};
const PER_FEED = 8;
const PICK = 4;
const MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

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
      text: decode(tag('description') || tag('summary') || tag('content') || '').slice(0, 260),
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
        text: decode(i.description || '').slice(0, 260),
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
Skip celebrity gossip, sponsored/press-release items, sports results and duplicates of the same story.
For each pick give:
- "id": the exact id, e.g. "I3"
- "headline": max 9 words, plain words, no clickbait
- "summary": one sentence, max 24 words, what happened and why it matters
Also give "tldr": one sentence, max 22 words, the overall picture today.

Reply with JSON only: {"tldr": "...", "indonesia": [{"id","headline","summary"}], "world": [{"id","headline","summary"}]}

INDONESIA
${list('indonesia')}

WORLD
${list('world')}`;

  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.3,
      max_tokens: 1200,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error(`groq ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return JSON.parse(j.choices[0].message.content);
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

    const out = { generatedAt: Date.now(), model: MODEL, tldr: String(ai.tldr || ''), indonesia: pick('indonesia'), world: pick('world') };
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    return res.status(200).json(out);
  } catch (e) {
    res.setHeader('Cache-Control', 's-maxage=60');
    return res.status(502).json({ error: 'brief_failed', message: String(e.message || e).slice(0, 300) });
  }
}

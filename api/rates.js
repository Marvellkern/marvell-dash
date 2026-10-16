// GET /api/rates?c=USD,SGD,EUR — live rates to IDR.
// Live (intraday) prices from Yahoo Finance; if that fails, the ECB daily rate via Frankfurter.
// Cached at Vercel's edge for 5 minutes.

const UA = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36' };

async function yahoo(c) {
  const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${c}IDR=X?range=1d&interval=15m`, { headers: UA, signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error('yahoo ' + r.status);
  const m = (await r.json()).chart.result[0].meta;
  if (!isFinite(m.regularMarketPrice)) throw new Error('yahoo empty');
  return { rate: m.regularMarketPrice, prevClose: m.chartPreviousClose ?? m.previousClose ?? null, time: m.regularMarketTime * 1000 };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const list = String(req.query.c || 'USD,SGD,EUR').toUpperCase().split(',').filter((c) => /^[A-Z]{3}$/.test(c)).slice(0, 6);
  const out = { source: 'live', rates: {}, prevClose: {}, time: 0 };
  const results = await Promise.allSettled(list.map(yahoo));
  const missing = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      out.rates[list[i]] = r.value.rate;
      out.prevClose[list[i]] = r.value.prevClose;
      out.time = Math.max(out.time, r.value.time);
    } else missing.push(list[i]);
  });
  if (missing.length) {
    try {
      const want = missing.filter((c) => c !== 'EUR');
      const j = await (await fetch(`https://api.frankfurter.app/latest?from=EUR&to=${['IDR', ...want].join(',')}`, { signal: AbortSignal.timeout(6000) })).json();
      const r = { ...j.rates, EUR: 1 };
      for (const c of missing) out.rates[c] = r.IDR / r[c];
      if (missing.length === list.length) { out.source = 'ecb'; out.date = j.date; }
    } catch {
      if (missing.length === list.length) {
        res.setHeader('Cache-Control', 's-maxage=60');
        return res.status(502).json({ error: 'rates_failed' });
      }
    }
  }
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  return res.status(200).json(out);
}

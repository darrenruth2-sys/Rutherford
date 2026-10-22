'use strict';
// A fake internet for tests: Coinbase, Yahoo, Alpaca, Polymarket Gamma. Prices follow functions of time.
function fakeWorld(clock, { price = (sym, t) => 100, stockOpen = true, pmMarkets = [], alpacaKeys = null } = {}) {
  const calls = [];
  const pm = new Map(pmMarkets.map(m => [String(m.id), m]));
  const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'Content-Type': 'application/json' } });
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, headers: opts.headers || {} });
    const u = new URL(url);
    const now = clock.t;
    if (u.hostname === 'api.exchange.coinbase.com') {
      const m = u.pathname.match(/^\/products\/([A-Z0-9-]+)\/(ticker|stats|candles)$/); if (!m) return json({}, 404);
      const [, sym, kind] = m;
      if (kind === 'ticker') return json({ price: String(price(sym, now)) });
      if (kind === 'stats') return json({ open: String(price(sym, now - 864e5)), high: '1', low: '1', volume: '1' });
      const g = Number(u.searchParams.get('granularity')) * 1000;
      const end = u.searchParams.get('end') ? Date.parse(u.searchParams.get('end')) : now;
      const start = u.searchParams.get('start') ? Date.parse(u.searchParams.get('start')) : end - 300 * g;
      const rows = []; for (let t = Math.floor(end / g) * g; t >= start && rows.length < 300; t -= g) { const p = price(sym, t + g - 1); rows.push([t / 1000, p, p, p, p, 1]); }
      return json(rows);
    }
    if (u.hostname === 'query1.finance.yahoo.com') {
      const sym = decodeURIComponent(u.pathname.split('/').pop());
      if (sym === 'NOPE') return json({ chart: { result: null, error: { description: 'No data found, symbol may be delisted' } } }, 404);
      const step = u.searchParams.get('interval') === '1d' ? 864e5 : 300000;
      const ts = []; for (let t = now - 300 * step; t <= now; t += step) ts.push(Math.floor(t / 1000));
      const closes = ts.map(t => price(sym, t * 1000));
      return json({ chart: { result: [{ meta: { regularMarketPrice: price(sym, now), chartPreviousClose: price(sym, now - 864e5), longName: sym + ' Inc' }, timestamp: ts, indicators: { quote: [{ open: closes, high: closes, low: closes, close: closes, volume: closes.map(() => 1) }] } }] } });
    }
    if (u.hostname === 'paper-api.alpaca.markets') {
      if (!alpacaKeys || opts.headers['APCA-API-KEY-ID'] !== alpacaKeys.id) return json({ message: 'forbidden' }, 403);
      return json({ is_open: stockOpen, next_open: new Date(now + 3600000).toISOString(), next_close: new Date(now + 7200000).toISOString() });
    }
    if (u.hostname === 'data.alpaca.markets') {
      if (!alpacaKeys || opts.headers['APCA-API-KEY-ID'] !== alpacaKeys.id) return json({ message: 'forbidden' }, 403);
      if (u.pathname.endsWith('/snapshots')) { const sym = u.searchParams.get('symbols'); return json({ [sym]: { latestTrade: { p: price(sym, now) }, prevDailyBar: { c: price(sym, now - 864e5) }, dailyBar: { h: 1, l: 1, v: 1 } } }); }
      const sym = u.pathname.split('/')[3]; const bars = []; for (let t = now - 300 * 300000; t <= now; t += 300000) { const p = price(sym, t); bars.push({ t: new Date(t).toISOString(), o: p, h: p, l: p, c: p, v: 1 }); }
      return json({ bars });
    }
    if (u.hostname === 'gamma-api.polymarket.com') {
      const raw = m => ({ id: m.id, question: m.question, outcomes: JSON.stringify(m.outcomes || ['Yes', 'No']), outcomePrices: JSON.stringify(m.prices.map(String)), endDateIso: new Date(m.end).toISOString(), closed: !!m.closed, active: !m.closed, acceptingOrders: !m.closed, volume24hr: 50000, liquidity: 20000, oneDayPriceChange: m.change ?? 0.05, slug: 'm-' + m.id, events: [{ title: m.question, slug: 'e-' + m.id }] });
      if (u.pathname.startsWith('/markets/')) { const m = pm.get(u.pathname.split('/')[2]); return m ? json(raw(m)) : json({}, 404); }
      if (u.pathname.startsWith('/events/slug/')) return json({}, 404);
      if (u.pathname === '/events' || u.pathname === '/events/keyset') return json([...pm.values()].filter(m => !m.closed).map(m => ({ title: m.question, slug: 'e-' + m.id, markets: [raw(m)] })));
      if (u.pathname === '/public-search') return json({ events: [...pm.values()].filter(m => !m.closed && m.question.toLowerCase().includes(String(u.searchParams.get('q')).toLowerCase().split(' ')[0])).map(m => ({ title: m.question, slug: 'e-' + m.id, markets: [raw(m)] })) });
      return json({}, 404);
    }
    return json({ error: 'unexpected url ' + url }, 500);
  };
  return { fetchImpl, calls, pm };
}

module.exports = { fakeWorld };

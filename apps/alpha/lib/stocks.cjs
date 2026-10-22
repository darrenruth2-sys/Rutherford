'use strict';
// Stock prices. Uses Alpaca (free account, reliable) when keys are set, otherwise Yahoo's public chart feed.
const ALPACA_DATA = 'https://data.alpaca.markets';
const ALPACA_PAPER = 'https://paper-api.alpaca.markets';
const YAHOO = 'https://query1.finance.yahoo.com';
const STOCK_RE = /^[A-Z]{1,5}([.-][A-Z])?$/;

// Regular US session in New York time (holidays not included in the fallback)
function nyMarketOpen(t = Date.now()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(t)).map(p => [p.type, p.value]));
  if (['Sat', 'Sun'].includes(parts.weekday)) return false;
  const mins = Number(parts.hour) * 60 + Number(parts.minute);
  return mins >= 570 && mins < 960;
}

function create({ fetchImpl = fetch, now = () => Date.now(), keys = () => ({}) } = {}) {
  const cache = new Map();
  async function get(url, { headers = {}, ttl = 15000 } = {}) {
    const hit = cache.get(url); if (hit && now() - hit.at < ttl) return hit.data;
    let res;
    try { res = await fetchImpl(url, { headers: { 'User-Agent': 'Mozilla/5.0 RutherfordAlpha', Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(12000) }); }
    catch { throw Error("Couldn't reach the stock data service"); }
    if (res.status === 401 || res.status === 403) throw Error('Alpaca rejected your keys. Check them in Alpha Settings.');
    if (res.status === 404) throw Error('Unknown stock symbol');
    if (res.status === 429) throw Error('Stock data rate limit, try again in a minute');
    if (!res.ok) throw Error('Stock data error (HTTP ' + res.status + ')');
    const data = await res.json();
    cache.set(url, { at: now(), data }); if (cache.size > 400) cache.delete(cache.keys().next().value);
    return data;
  }
  const alpaca = () => { const k = keys(); return k.id && k.secret ? { 'APCA-API-KEY-ID': k.id, 'APCA-API-SECRET-KEY': k.secret } : null; };
  const source = () => (alpaca() ? 'alpaca' : 'yahoo');

  let clockCache = null;
  async function clock() {
    const h = alpaca();
    if (h) {
      if (clockCache && now() - clockCache.at < 60000) return clockCache.data;
      try { const c = await get(ALPACA_PAPER + '/v2/clock', { headers: h, ttl: 60000 }); clockCache = { at: now(), data: { open: !!c.is_open, nextOpen: c.next_open, nextClose: c.next_close, source: 'alpaca' } }; return clockCache.data; } catch {}
    }
    return { open: nyMarketOpen(now()), source: 'clock' };
  }

  // ---- Yahoo ----
  async function yahooChart(sym, interval, range, extra = '') {
    const d = await get(`${YAHOO}/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&range=${range}&includePrePost=false${extra}`, { ttl: interval === '1d' ? 300000 : 30000 });
    const r = d?.chart?.result?.[0];
    if (!r) throw Error(d?.chart?.error?.description || 'Unknown stock symbol');
    const q = r.indicators?.quote?.[0] || {};
    const candles = (r.timestamp || []).map((ts, i) => ({ t: ts * 1000, o: q.open?.[i], h: q.high?.[i], l: q.low?.[i], c: q.close?.[i], v: q.volume?.[i] })).filter(c => c.c != null);
    return { meta: r.meta || {}, candles };
  }

  async function quote(sym) {
    const h = alpaca();
    if (h) { try { return await alpacaQuote(sym, h); } catch (e) { lastAlpacaError = e.message; } } // Yahoo is the backup
    return yahooQuote(sym);
  }
  let lastAlpacaError = null;
  async function alpacaQuote(sym, h) {
      const d = await get(`${ALPACA_DATA}/v2/stocks/snapshots?symbols=${sym}&feed=iex`, { headers: h });
      const s = d?.[sym]; if (!s) throw Error('Unknown stock symbol');
      const price = s.latestTrade?.p ?? s.minuteBar?.c ?? s.dailyBar?.c, prev = s.prevDailyBar?.c;
      if (!(price > 0)) throw Error('No price for ' + sym);
      return { pair: sym, kind: 'stock', price, open24h: prev, change24h: prev ? (price - prev) / prev * 100 : null, high24h: s.dailyBar?.h, low24h: s.dailyBar?.l, volume24h: s.dailyBar?.v, time: now(), source: 'alpaca' };
  }
  async function yahooQuote(sym) {
    const { meta, candles } = await yahooChart(sym, '5m', '1d');
    const price = meta.regularMarketPrice ?? candles.at(-1)?.c, prev = meta.chartPreviousClose ?? meta.previousClose;
    if (!(price > 0)) throw Error('No price for ' + sym);
    const hi = candles.length ? Math.max(...candles.map(c => c.h ?? c.c)) : meta.regularMarketDayHigh, lo = candles.length ? Math.min(...candles.map(c => c.l ?? c.c)) : meta.regularMarketDayLow;
    return { pair: sym, kind: 'stock', price, open24h: prev, change24h: prev ? (price - prev) / prev * 100 : null, high24h: hi, low24h: lo, time: now(), source: 'yahoo', name: meta.longName || meta.shortName };
  }

  // granularity in seconds → candles oldest→newest
  async function candles(sym, granularity = 300) {
    const h = alpaca();
    if (h) { try { const rows = await alpacaCandles(sym, granularity, h); if (rows.length) return rows; } catch {} }
    return yahooCandles(sym, granularity);
  }
  async function alpacaCandles(sym, granularity, h) {
      const tf = granularity <= 60 ? '1Min' : granularity <= 300 ? '5Min' : granularity <= 900 ? '15Min' : granularity <= 3600 ? '1Hour' : '1Day';
      const back = { '1Min': 3 * 864e5, '5Min': 10 * 864e5, '15Min': 20 * 864e5, '1Hour': 60 * 864e5, '1Day': 400 * 864e5 }[tf];
      const d = await get(`${ALPACA_DATA}/v2/stocks/${sym}/bars?timeframe=${tf}&start=${new Date(now() - back).toISOString()}&limit=10000&feed=iex&adjustment=split`, { headers: h, ttl: 60000 });
      return (d?.bars || []).map(b => ({ t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v })).slice(-400);
  }
  async function yahooCandles(sym, granularity) {
    const [interval, range] = granularity <= 60 ? ['1m', '1d'] : granularity <= 300 ? ['5m', '5d'] : granularity <= 900 ? ['15m', '1mo'] : granularity <= 3600 ? ['60m', '3mo'] : ['1d', '1y'];
    return (await yahooChart(sym, interval, range)).candles.slice(-400);
  }

  async function priceAt(sym, t) {
    const h = alpaca(); let rows;
    if (h) {
      const d = await get(`${ALPACA_DATA}/v2/stocks/${sym}/bars?timeframe=1Min&start=${new Date(t - 30 * 60000).toISOString()}&end=${new Date(t + 60000).toISOString()}&feed=iex`, { headers: h, ttl: 3600000 });
      rows = (d?.bars || []).map(b => ({ t: Date.parse(b.t), c: b.c }));
    } else {
      rows = (await yahooChart(sym, '1m', '1d', `&period1=${Math.floor((t - 3600000) / 1000)}&period2=${Math.floor((t + 60000) / 1000)}`).catch(() => yahooChart(sym, '5m', '5d'))).candles;
    }
    const before = rows.filter(r => r.t <= t);
    const row = before.at(-1) || rows[0];
    if (!row) throw Error('No stock price near that time');
    return row.c;
  }

  return { quote, candles, priceAt, clock, source, STOCK_RE, lastAlpacaError: () => lastAlpacaError };
}

module.exports = { create, STOCK_RE, nyMarketOpen };

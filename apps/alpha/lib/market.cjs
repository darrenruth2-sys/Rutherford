'use strict';
// Market data for crypto (Coinbase, no key needed) and stocks (Alpaca or Yahoo, see stocks.cjs).
// Crypto symbols look like BTC-USD, stocks like AAPL.
const Stocks = require('./stocks.cjs');
const BASE = 'https://api.exchange.coinbase.com';
const PAIR_RE = /^[A-Z0-9]{2,12}-(USD|USDC|USDT|EUR|GBP|BTC)$/;

function create({ fetchImpl = fetch, now = () => Date.now(), alpacaKeys = () => ({}) } = {}) {
  const stocks = Stocks.create({ fetchImpl, now, keys: alpacaKeys });
  const cache = new Map();
  async function get(path, ttlMs) {
    const hit = cache.get(path);
    if (hit && now() - hit.at < ttlMs) return hit.data;
    let res;
    try { res = await fetchImpl(BASE + path, { headers: { 'User-Agent': 'RutherfordAlpha/1.0', Accept: 'application/json' }, signal: AbortSignal.timeout(10000) }); }
    catch { throw Error("Couldn't reach Coinbase. Check your internet connection."); }
    if (res.status === 404) throw Error('Coinbase does not list that pair');
    if (res.status === 429) throw Error('Coinbase rate limit, wait a few seconds');
    if (!res.ok) throw Error('Coinbase error (HTTP ' + res.status + ')');
    const data = await res.json();
    cache.set(path, { at: now(), data });
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    return data;
  }
  const check = pair => { pair = String(pair || '').toUpperCase().trim(); if (!PAIR_RE.test(pair) && !Stocks.STOCK_RE.test(pair)) throw Error('Use a crypto pair like BTC-USD or a stock like AAPL'); return pair; };
  const kind = sym => (PAIR_RE.test(sym) ? 'crypto' : 'stock');

  async function quote(pair) {
    pair = check(pair);
    if (kind(pair) === 'stock') return stocks.quote(pair);
    const [t, s] = await Promise.all([get(`/products/${pair}/ticker`, 15000), get(`/products/${pair}/stats`, 60000)]);
    const price = Number(t.price), open = Number(s.open);
    if (!(price > 0)) throw Error('No price for ' + pair);
    return { pair, kind: 'crypto', price, open24h: open, high24h: Number(s.high), low24h: Number(s.low), volume24h: Number(s.volume), change24h: open > 0 ? (price - open) / open * 100 : null, time: now() };
  }

  // Candles oldest→newest: {t (ms), o, h, l, c, v}. granularity in seconds: 60, 300, 900, 3600, 21600, 86400
  async function candles(pair, granularity = 300, { start, end } = {}) {
    pair = check(pair);
    if (kind(pair) === 'stock') return stocks.candles(pair, granularity);
    if (![60, 300, 900, 3600, 21600, 86400].includes(granularity)) throw Error('Bad candle size');
    let q = `?granularity=${granularity}`;
    if (start) q += `&start=${new Date(start).toISOString()}&end=${new Date(end || start + granularity * 1000 * 2).toISOString()}`;
    const rows = await get(`/products/${pair}/candles${q}`, start ? 3600000 : Math.min(60000, granularity * 500));
    if (!Array.isArray(rows)) throw Error('Bad candle data');
    return rows.map(r => ({ t: r[0] * 1000, l: +r[1], h: +r[2], o: +r[3], c: +r[4], v: +r[5] })).sort((a, b) => a.t - b.t);
  }

  // Price at a past moment (for scoring forecasts): close of the 1-minute candle covering that time.
  async function priceAt(pair, t) {
    if (kind(pair) === 'stock') return stocks.priceAt(pair, t);
    const rows = await candles(pair, 60, { start: t - 3 * 60000, end: t + 2 * 60000 });
    const before = rows.filter(r => r.t <= t);
    const row = before.at(-1) || rows[0];
    if (!row) throw Error('No price data near that time');
    return row.c;
  }

  return { quote, candles, priceAt, check, kind, stockClock: () => stocks.clock(), stockSource: () => stocks.source(), alpacaError: () => stocks.lastAlpacaError() };
}

module.exports = { create, PAIR_RE };

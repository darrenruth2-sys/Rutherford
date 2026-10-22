'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp, listen } = require('../server.cjs');
const strat = require('../lib/strategies.cjs');
const paper = require('../lib/paper.cjs');

const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));

// Fake Coinbase: price of each pair follows a known path over time, so scoring is checkable.
function fakeCoinbase(clock, priceFn = (pair, t) => (pair.startsWith('BTC') ? 60000 : 3000) * (1 + 0.0001 * ((t / 60000) % 500))) {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    const u = new URL(url); const m = u.pathname.match(/^\/products\/([A-Z0-9-]+)\/(ticker|stats|candles)$/);
    if (!m) return new Response('{}', { status: 404 });
    const [, pair, kind] = m;
    if (pair === 'FAKE-USD') return new Response('{"message":"NotFound"}', { status: 404 });
    const now = clock.t;
    if (kind === 'ticker') return Response.json({ price: String(priceFn(pair, now)), time: new Date(now).toISOString() });
    if (kind === 'stats') return Response.json({ open: String(priceFn(pair, now - 864e5)), high: '1', low: '1', volume: '10', last: String(priceFn(pair, now)) });
    const g = Number(u.searchParams.get('granularity')) * 1000;
    const end = u.searchParams.get('end') ? Date.parse(u.searchParams.get('end')) : now;
    const start = u.searchParams.get('start') ? Date.parse(u.searchParams.get('start')) : end - 300 * g;
    const rows = [];
    for (let t = Math.floor(end / g) * g; t >= start && rows.length < 300; t -= g) { const p = priceFn(pair, t + g - 1); rows.push([t / 1000, p * 0.999, p * 1.001, p, p, 5]); }
    return Response.json(rows);
  };
  return { fetchImpl, calls };
}

async function start(opts) {
  const server = createApp({ timers: false, rutherfordSettings: '/nonexistent', ...opts });
  const port = await listen(server, 0); const base = 'http://127.0.0.1:' + port;
  const api = async (p, body) => { const r = await fetch(base + '/api/' + p, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const j = await r.json(); if (!r.ok) throw Error(j.error); return j; };
  return { server, base, api, close: () => new Promise(r => server.close(r)) };
}

test('every file the page loads is served with the right type', async () => {
  const clock = { t: Date.now() };
  const app = await start({ dataDir: tmp('al-'), fetchImpl: fakeCoinbase(clock).fetchImpl });
  try {
    const html = await (await fetch(app.base + '/')).text();
    const refs = [...html.matchAll(/(?:src|href)="([^"#:]+)"/g)].map(m => m[1]);
    for (const ref of refs) { const r = await fetch(app.base + '/' + ref); assert.equal(r.status, 200, ref); await r.arrayBuffer(); }
    const js = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
    for (const id of new Set([...js.matchAll(/\$\('#([\w-]+)'\)/g)].map(m => m[1]))) if (!['dPrice', 'dChg', 'liveKeyId', 'liveSecret'].includes(id)) assert.match(html, new RegExp('id="' + id + '"'), '#' + id);
  } finally { await app.close(); }
});

test('quotes for the watchlist, bad pairs rejected, watchlist add/remove', async () => {
  const clock = { t: Date.now() };
  const app = await start({ dataDir: tmp('al-'), fetchImpl: fakeCoinbase(clock).fetchImpl });
  try {
    const q = await app.api('quotes');
    assert.equal(q.length, 8); assert.ok(q[0].price > 0); assert.equal(typeof q[0].change24h, 'number');
    await assert.rejects(app.api('watchlist', { add: 'FAKE-USD' }), /does not list/);
    await assert.rejects(app.api('watchlist', { add: 'rm -rf' }), /like BTC-USD or a stock/);
    const list = await app.api('watchlist', { add: 'XRP-USD' }); assert.ok(list.includes('XRP-USD'));
    assert.ok(!(await app.api('watchlist', { remove: 'DOGE-USD' })).includes('DOGE-USD'));
  } finally { await app.close(); }
});

test('paper trading: buy, risk rule, sell with P&L and fees', async () => {
  const clock = { t: Date.now() };
  let btc = 50000;
  const cb = fakeCoinbase(clock, pair => (pair.startsWith('BTC') ? btc : 2000));
  const app = await start({ dataDir: tmp('al-'), fetchImpl: cb.fetchImpl, now: () => clock.t });
  try {
    await app.api('settings', { feePct: 0.6 });
    await assert.rejects(app.api('trade', { side: 'buy', pair: 'BTC-USD', usd: 600 }), /Risk rule/); // default max 50%
    let r = await app.api('trade', { side: 'buy', pair: 'BTC-USD', usd: 400 });
    assert.equal(r.portfolio.cash, 600);
    assert.ok(Math.abs(r.trade.qty - 400 * 0.994 / 50000) < 1e-9);
    await assert.rejects(app.api('trade', { side: 'buy', pair: 'ETH-USD', usd: 5000 }), /Not enough cash/);
    btc = 55000; clock.t += 60000;
    r = await app.api('trade', { side: 'sell', pair: 'BTC-USD', qty: 'all' });
    assert.ok(r.trade.pnl > 30 && r.trade.pnl < 40, 'about +10% minus fees: ' + r.trade.pnl);
    assert.equal(r.portfolio.positions.length, 0);
    await assert.rejects(app.api('trade', { side: 'sell', pair: 'BTC-USD', qty: 1 }), /don't own/);
    const reset = await app.api('portfolio/reset', { cash: 5000 });
    assert.equal(reset.equity, 5000);
  } finally { await app.close(); }
});

test('forecasts are recorded, then scored against the real later price', async () => {
  const clock = { t: Date.UTC(2026, 9, 1, 12) };
  // BTC goes steadily up over time; ETH steadily down
  const priceFn = (pair, t) => pair.startsWith('BTC') ? 50000 + (t - Date.UTC(2026, 9, 1)) / 60000 : 4000 - (t - Date.UTC(2026, 9, 1)) / 600000;
  const cb = fakeCoinbase(clock, priceFn);
  const app = await start({ dataDir: tmp('al-'), fetchImpl: cb.fetchImpl, now: () => clock.t });
  try {
    await app.api('settings', { watchlist: undefined });
    const r = await app.api('forecast/run', {});
    assert.ok(r.created > 20, 'created ' + r.created);
    await app.api('forecast/manual', { pair: 'BTC-USD', direction: 'down', horizon: 15 });
    let f = await app.api('forecasts');
    assert.equal(f.scoreboard.totals.settled, 0);
    clock.t += 16 * 60000;
    await app.api('forecast/settle', {});
    f = await app.api('forecasts');
    const mom = f.scoreboard.strategies.find(s => s.id === 'momentum');
    // momentum follows the trend, so all its settled 15m calls win
    assert.ok(mom.byHorizon[0].n > 0 && mom.byHorizon[0].wins === mom.byHorizon[0].n, JSON.stringify(mom.byHorizon[0]));
    const rev = f.scoreboard.strategies.find(s => s.id === 'reversion');
    assert.equal(rev.byHorizon[0].wins, 0, 'mean reversion bets against a steady trend');
    const me = f.scoreboard.strategies.find(s => s.id === 'me');
    assert.equal(me.n, 1); assert.equal(me.wins, 0);
    assert.ok(f.scoreboard.totals.pending > 0, '1h and 4h calls still pending');
    // late settlement uses historical 1-minute candles
    clock.t += 5 * 3600000;
    await app.api('forecast/settle', {});
    f = await app.api('forecasts');
    assert.equal(f.scoreboard.totals.pending, 0);
    assert.ok(cb.calls.some(u => u.includes('granularity=60&start=')));
  } finally { await app.close(); }
});

test('auto-forecast runs on schedule when enabled', async () => {
  const clock = { t: Date.now() };
  const app = await start({ dataDir: tmp('al-'), fetchImpl: fakeCoinbase(clock).fetchImpl, now: () => clock.t });
  try {
    await app.server.alpha.tick();
    assert.equal((await app.api('forecasts')).recent.length, 0);
    await app.api('settings', { autoForecast: true, autoEveryMin: 15 });
    await app.server.alpha.tick();
    const n = (await app.api('forecasts')).recent.length; assert.ok(n > 0);
    clock.t += 5 * 60000; await app.server.alpha.tick();
    assert.equal((await app.api('forecasts')).recent.length, n, 'not again before 15 min');
  } finally { await app.close(); }
});

test('scoreboard statistics are honest', () => {
  assert.equal(strat.verdict(12, 15).tag, 'too-early');
  assert.equal(strat.verdict(70, 100).tag, 'edge');
  assert.equal(strat.verdict(52, 100).tag, 'noise');
  assert.equal(strat.verdict(30, 100).tag, 'worse');
  const [lo, hi] = strat.wilson(50, 100); assert.ok(lo > 39 && lo < 41 && hi > 59 && hi < 61);
  const flat = Array.from({ length: 40 }, (_, i) => ({ c: 100, h: 100, l: 100, t: i }));
  const sig = strat.signals(flat, () => 0.1);
  assert.equal(sig.find(s => s.strategy === 'momentum').direction, null, 'no move = no call');
  assert.equal(sig.find(s => s.strategy === 'coin').direction, 'up');
});

test('Ask Alpha streams an answer with live market context; uses Rutherford key if Alpha has none', async () => {
  const clock = { t: Date.now() };
  const cb = fakeCoinbase(clock);
  const sent = [];
  const groqFetch = async (url, opts) => {
    sent.push({ url, body: JSON.parse(opts.body), auth: opts.headers.Authorization });
    const sse = ['BTC ', 'looks ', 'flat.'].map(t => 'data: ' + JSON.stringify({ choices: [{ delta: { content: t } }] }) + '\n\n').join('') + 'data: [DONE]\n\n';
    return new Response(sse, { status: 200 });
  };
  const rs = path.join(tmp('rf-'), 'settings.json'); fs.writeFileSync(rs, JSON.stringify({ groqKey: 'gsk_from_rutherford' }));
  const app = await start({ dataDir: tmp('al-'), fetchImpl: cb.fetchImpl, groqFetch, rutherfordSettings: rs });
  try {
    const st = await app.api('state'); assert.equal(st.settings.keyFromRutherford, true);
    assert.ok(!JSON.stringify(st).includes('gsk_from'));
    const r = await fetch(app.base + '/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'what is btc doing' }) });
    const evs = (await r.text()).split('\n\n').filter(Boolean).map(l => JSON.parse(l.slice(6)));
    assert.equal(evs.find(e => e.type === 'done').content, 'BTC looks flat.');
    assert.equal(sent[0].auth, 'Bearer gsk_from_rutherford');
    assert.match(sent[0].body.messages[0].content, /BTC-USD: \$\d/);
    assert.match(sent[0].body.messages[0].content, /PAPER/);
  } finally { await app.close(); }
});

test('paper math: average cost across two buys', () => {
  const p = { cash: 1000, startCash: 1000, positions: {}, trades: [] };
  paper.buy(p, { pair: 'X-USD', usd: 100, price: 10, feePct: 0 });
  paper.buy(p, { pair: 'X-USD', usd: 100, price: 20, feePct: 0 });
  assert.equal(p.positions['X-USD'].qty, 15);
  assert.ok(Math.abs(p.positions['X-USD'].avg - 200 / 15) < 1e-9);
  const s = paper.summary(p, { 'X-USD': 20 });
  assert.equal(s.equity, 1100);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp, listen } = require('../server.cjs');
const { fakeWorld } = require('./fakeworld.cjs');
const pm = require('../lib/polymarket.cjs');

const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const T0 = Date.UTC(2026, 9, 21, 15); // a Wednesday, 11am New York: stock market open

async function start(opts) {
  const server = createApp({ timers: false, rutherfordSettings: '/nonexistent', ...opts });
  const port = await listen(server, 0); const base = 'http://127.0.0.1:' + port;
  const api = async (p, body) => { const r = await fetch(base + '/api/' + p, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const j = await r.json(); if (!r.ok) throw Error(j.error); return j; };
  return { server, base, api, close: () => new Promise(r => server.close(r)) };
}

test('stocks work through Yahoo with no keys, and through Alpaca once keys are added', async () => {
  const clock = { t: T0 };
  const world = fakeWorld(clock, { price: (s, t) => (s === 'AAPL' ? 230 + (t - T0) / 864e5 : 100), alpacaKeys: { id: 'PKTEST', secret: 'shh' } });
  const app = await start({ dataDir: tmp('al-'), fetchImpl: world.fetchImpl, now: () => clock.t });
  try {
    const q = (await app.api('quotes')).find(x => x.pair === 'AAPL');
    assert.equal(q.kind, 'stock'); assert.ok(Math.abs(q.price - 230) < 0.01); assert.ok(q.change24h > 0);
    assert.ok(world.calls.some(c => c.url.includes('finance.yahoo.com')));
    assert.equal((await app.api('clock')).dataSource, 'yahoo');
    await assert.rejects(app.api('watchlist', { add: 'NOPE' }));
    await app.api('settings', { alpacaKeyId: 'PKTEST', alpacaSecret: 'shh' });
    const st = await app.api('state'); assert.equal(st.settings.hasAlpaca, true); assert.ok(!JSON.stringify(st).includes('shh'));
    const t = await app.api('alpaca/test', {}); assert.equal(t.source, 'alpaca');
    const c = await app.api('clock'); assert.equal(c.source, 'alpaca'); assert.equal(c.open, true);
    const r = await app.api('trade', { side: 'buy', pair: 'AAPL', usd: 100 });
    assert.ok(Math.abs(r.trade.fee - 0.05) < 1e-9, 'stock fee 0.05%');
  } finally { await app.close(); }
});

test('the 4 bots trade on their own rules, keep stats, and log lessons', async () => {
  const clock = { t: T0 };
  // BTC climbs steadily (momentum + trend should buy), ETH just dropped (contrarian should buy)
  const price = (s, t) => {
    const m = (t - T0) / 60000; // minutes from start
    if (s === 'BTC-USD') return 60000 * (1 + 0.0004 * Math.max(-600, m));
    if (s === 'ETH-USD') return m > -20 ? 2900 : 3000;
    return 100;
  };
  const world = fakeWorld(clock, { price });
  const app = await start({ dataDir: tmp('al-'), fetchImpl: world.fetchImpl, now: () => clock.t });
  try {
    await app.api('settings', { botsUsePolymarket: false });
    await app.api('watchlist', { remove: 'SOL-USD' });
    let r = await app.api('arena/tick', {});
    const v = r.view;
    const bot = id => v.bots.find(b => b.id === id);
    assert.ok(bot('proton').positions.some(p => p.sym === 'BTC-USD'), 'Proton bought the riser');
    assert.ok(bot('neutron').positions.some(p => p.sym === 'BTC-USD'), 'Neutron bought the uptrend');
    assert.ok(bot('electron').positions.some(p => p.sym === 'ETH-USD'), 'Electron bought the dip');
    assert.match(bot('nucleus').ai.status, /Groq key/);
    // 4 hours later BTC is up another ~10%: take-profit
    clock.t += 4 * 3600000;
    r = await app.api('arena/tick', {});
    const p2 = r.view.bots.find(b => b.id === 'proton');
    assert.ok(p2.stats.closed >= 1 && p2.stats.wins >= 1, JSON.stringify(p2.stats));
    assert.equal(p2.stats.winRate, 100);
    assert.ok(p2.stats.returnPct > 0);
    assert.ok(r.view.lessons.some(l => /Proton won/.test(l.text)));
    const detail = await app.api('arena/bot?id=proton');
    assert.ok(detail.trades.some(t => t.side === 'sell' && t.reason === 'take-profit'));
    assert.ok(r.view.bots.every(b => b.equity.length === 2));
    assert.ok(r.view.benchmark && r.view.benchmark.returnPct > 0, 'Hold-BTC benchmark tracked');
  } finally { await app.close(); }
});

test('stock trades wait for market hours', async () => {
  const clock = { t: Date.UTC(2026, 9, 25, 15) }; // Sunday
  const world = fakeWorld(clock, { price: (s, t) => (s === 'NVDA' ? 100 * (1 + 0.0005 * (t - clock.t) / 60000) : 100) });
  const app = await start({ dataDir: tmp('al-'), fetchImpl: world.fetchImpl, now: () => clock.t });
  try {
    await app.api('settings', { botsUsePolymarket: false });
    const r = await app.api('arena/tick', {});
    assert.equal(r.view.stockOpen, false);
    assert.ok(r.view.bots.every(b => !b.positions.some(p => p.sym === 'NVDA')));
  } finally { await app.close(); }
});

test('Polymarket: browse, bet, cash out, and win on resolution (you and the bots)', async () => {
  const clock = { t: T0 };
  const markets = [
    { id: '101', question: 'Will the Browns win Sunday?', prices: [0.72, 0.28], end: T0 + 2 * 864e5, change: 0.06 },
    { id: '102', question: 'Bitcoin Up or Down 15 min', prices: [0.5, 0.5], end: T0 + 10 * 60000 },
    { id: '103', question: 'Will it snow in Columbus?', prices: [0.2, 0.8], end: T0 + 3 * 864e5, change: -0.04 }
  ];
  const world = fakeWorld(clock, { pmMarkets: markets });
  const app = await start({ dataDir: tmp('al-'), fetchImpl: world.fetchImpl, now: () => clock.t });
  try {
    const list = await app.api('pm/markets?cat=sports');
    assert.equal(list[0].question, 'Will the Browns win Sunday?'); assert.deepEqual(list[0].outcomes, ['Yes', 'No']);
    assert.equal((await app.api('pm/search?q=bitcoin'))[0].id, '102');
    let r = await app.api('pm/bet', { marketId: '101', outcome: 'Yes', usd: 73 });
    assert.equal(r.bet.price, 0.73); assert.ok(Math.abs(r.bet.shares - 100) < 1e-9);
    assert.equal(r.portfolio.cash, 1000 - 73);
    const second = await app.api('pm/bet', { marketId: '103', outcome: 'No', usd: 50 });
    // cash out the second early
    world.pm.get('103').prices = [0.04, 0.96]; clock.t += 60000; // let the 45s price cache expire
    r = await app.api('pm/sell', { betId: second.bet.id });
    assert.equal(r.bet.status, 'sold'); assert.ok(r.bet.pnl > 0);
    // bots bet too: Proton backs the favorite, Electron the underdog
    await app.api('settings', { watchlist: [] });
    const t = await app.api('arena/tick', {});
    const proton = t.view.bots.find(b => b.id === 'proton'), electron = t.view.bots.find(b => b.id === 'electron');
    assert.equal(proton.bets[0].outcome, 'Yes'); assert.equal(proton.bets[0].marketId, '101');
    assert.ok(electron.bets.length === 1 && electron.bets[0].price < 0.4, JSON.stringify(electron.bets) + JSON.stringify(t.view.lessons.slice(0,5)));
    // the game ends: Browns win
    Object.assign(world.pm.get('101'), { closed: true, prices: [1, 0] });
    clock.t += 3 * 864e5;
    await app.server.alpha.tick();
    const pf = await app.api('portfolio');
    const won = pf.bets.find(b => b.marketId === '101');
    assert.equal(won.status, 'won'); assert.ok(Math.abs(won.payout - 100) < 1e-9);
    const v = await app.api('arena');
    assert.equal(v.bots.find(b => b.id === 'proton').stats.betsWon, 1);
    assert.ok(v.lessons.some(l => /Proton WON/.test(l.text)));
  } finally { await app.close(); }
});

test('Nucleus (AI bot) reads everything and its JSON decisions are executed safely', async () => {
  const clock = { t: T0 };
  const world = fakeWorld(clock, { price: (s, t) => (s === 'ETH-USD' ? 3000 : 100), pmMarkets: [{ id: '201', question: 'Will SpaceX launch Friday?', prices: [0.6, 0.4], end: T0 + 864e5 }] });
  const prompts = [];
  const groqFetch = async (url, opts) => {
    const body = JSON.parse(opts.body); prompts.push(body);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ thoughts: 'ETH is flat; Proton is leading so I will follow momentum lightly.', actions: [
      { type: 'buy', symbol: 'ETH-USD', pct: 90, reason: 'test oversize' },
      { type: 'buy', symbol: 'FAKE-USD', pct: 5, reason: 'not listed' },
      { type: 'bet', marketId: '201', outcome: 'Yes', pct: 3, reason: 'launch likely' },
      { type: 'sell', symbol: 'BTC-USD', reason: 'nothing held' }
    ] }) } }] }), { status: 200 });
  };
  const rs = path.join(tmp('rf-'), 'settings.json'); fs.writeFileSync(rs, JSON.stringify({ groqKey: 'gsk_x' }));
  const app = await start({ dataDir: tmp('al-'), fetchImpl: world.fetchImpl, groqFetch, rutherfordSettings: rs, now: () => clock.t });
  try {
    const r = await app.api('arena/tick', {});
    const nuc = r.view.bots.find(b => b.id === 'nucleus');
    const eth = nuc.positions.find(p => p.sym === 'ETH-USD');
    assert.ok(eth, 'bought ETH');
    assert.ok(eth.qty * 3000 <= 250 + 1e-6, 'oversized buy capped at 25% of equity');
    assert.equal(nuc.bets[0].marketId, '201');
    assert.equal(nuc.ai.skipped.length, 2, 'unknown symbol and empty sell were skipped');
    assert.match(nuc.ai.thoughts, /Proton is leading/);
    const sent = prompts[0];
    assert.equal(sent.response_format.type, 'json_object');
    assert.match(sent.messages[1].content, /LEADERBOARD/); assert.match(sent.messages[1].content, /SpaceX/);
    assert.ok(r.view.lessons.some(l => l.kind === 'ai'));
  } finally { await app.close(); }
});

test('learning: the weakest rule bot moves its settings toward the leader', async () => {
  const clock = { t: T0 };
  const world = fakeWorld(clock, {});
  const dir = tmp('al-');
  const app = await start({ dataDir: dir, fetchImpl: world.fetchImpl, now: () => clock.t });
  try {
    await app.api('settings', { botsUsePolymarket: false, watchlist: ['BTC-USD'] });
    const arena = app.server.alpha.arena.arena;
    const proton = arena.bots.find(b => b.id === 'proton'), electron = arena.bots.find(b => b.id === 'electron');
    proton.cash = 1200; electron.cash = 900; // Proton leading, Electron trailing
    proton.trades.push({ side: 'sell', pnl: 50, pnlPct: 5, sym: 'BTC-USD', t: clock.t }); electron.trades.push({ side: 'sell', pnl: -40, pnlPct: -4, sym: 'BTC-USD', t: clock.t });
    const before = { ...electron.genome };
    const r = await app.api('arena/evolve', {});
    assert.equal(r.result.learner, 'electron'); assert.equal(r.result.teacher, 'proton');
    const after = r.view.bots.find(b => b.id === 'electron');
    assert.equal(after.generation, 2); assert.equal(after.learnedFrom, 'proton');
    // stop-loss moved from 2.5 toward Proton's 1.5
    assert.ok(after.genome.stopLossPct < before.stopLossPct && after.genome.stopLossPct > 1.5 * 0.85, after.genome.stopLossPct);
    assert.ok(r.view.lessons.some(l => /Electron learned from Proton/.test(l.text)));
    // reset puts everyone back
    const reset = await app.api('arena/reset', { cash: 2000 });
    assert.ok(reset.bots.every(b => b.stats.equity === 2000 && b.generation === 1));
  } finally { await app.close(); }
});

test('polymarket normalizer handles real-world shapes', () => {
  const m = pm.normalize({ id: 5, question: 'Q?', outcomes: '["Yes","No"]', outcomePrices: '["0.33","0.67"]', endDateIso: '2026-11-01T00:00:00Z', active: true, closed: false, volume24hr: '1234.5' }, { title: 'Ev', slug: 'ev' });
  assert.deepEqual(m.prices, [0.33, 0.67]); assert.equal(m.volume24h, 1234.5); assert.equal(m.url, 'https://polymarket.com/event/ev');
  const resolved = pm.normalize({ id: 6, outcomes: '["Yes","No"]', outcomePrices: '["0","1"]', closed: true });
  assert.equal(resolved.winner, 1);
  const voided = pm.normalize({ id: 7, outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]', closed: true });
  assert.equal(voided.voided, true);
  assert.equal(pm.normalize({ id: 8, outcomes: 'garbage' }), null);
});

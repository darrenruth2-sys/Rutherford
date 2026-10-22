'use strict';
// Real-money engine: every safety rule gets a test against a fake Alpaca broker.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Live = require('../lib/live.cjs');
const { fakeBroker } = require('./fakebroker.cjs');
const { fakeWorld } = require('./fakeworld.cjs');

const T0 = Date.UTC(2026, 9, 21, 15); // Wed 11am New York
function setup({ target = 'paper', clockOpen = true, priceFn } = {}) {
  const clock = { t: T0 };
  const prices = { BTCUSD: 50000, AAPL: 200, ETHUSD: 2500 };
  const broker = fakeBroker({ price: priceFn || (s => prices[s] ?? 100) });
  let saved = null;
  const keys = { paperId: 'PKPAPER', paperSecret: 's1', liveId: 'AKLIVE', liveSecret: 's2' };
  const live = Live.create({
    load: () => saved, save: s => (saved = JSON.parse(JSON.stringify(s))), keys: () => keys, fetchImpl: broker.fetchImpl, now: () => clock.t,
    market: { stockClock: async () => ({ open: clockOpen }), quote: async s => ({ price: prices[s.replace('-', '')] ?? 100 }) },
    botView: id => ({ id, name: id, stats: {} })
  });
  if (target === 'live') live.configure({ target: 'live' });
  return { clock, broker, live, prices, keys, saved: () => saved };
}
const bot = { id: 'nucleus' };
const trade = (side, sym, usd, extra = {}) => ({ side, sym, kind: sym.includes('-') ? 'crypto' : 'stock', usd, reason: 'test', ...extra });

test('off by default: bot trades create nothing until you turn it on', async () => {
  const { live, broker } = setup();
  assert.equal(live.state.enabled, false);
  assert.equal(live.onBotTrade(bot, trade('buy', 'BTC-USD', 200), 1000), null);
  assert.equal(broker.log.length, 0);
});

test('ask-me-first mode: order waits for approval, is sized to your budget, then fills', async () => {
  const { live, broker } = setup();
  live.configure({ budgetUsd: 100, maxPerTradeUsd: 25, botId: 'nucleus' });
  await live.turnOn();
  const p = live.onBotTrade(bot, trade('buy', 'BTC-USD', 200), 1000); // bot put 20% of its equity in
  assert.equal(p.status, 'waiting'); assert.equal(p.usd, 20);
  assert.ok(!broker.log.some(l => l.method === 'POST'), 'nothing sent before approval');
  const r = await live.approve(p.id);
  assert.equal(r.status, 'filled');
  const post = broker.log.find(l => l.method === 'POST');
  assert.equal(post.host, 'paper'); assert.equal(post.body.symbol, 'BTC/USD'); assert.equal(post.body.notional, '20.00'); assert.equal(post.body.time_in_force, 'gtc');
  assert.match(post.body.client_order_id, /^rf-/);
  assert.ok(Math.abs(live.state.ledger['BTC-USD'].qty - 20 / 50000) < 1e-12);
  // bot sells → we sell exactly what we bought
  const s = live.onBotTrade(bot, trade('sell', 'BTC-USD', 0), 1000);
  const r2 = await live.approve(s.id);
  assert.equal(r2.status, 'filled'); assert.equal(live.state.ledger['BTC-USD'], undefined);
  assert.ok(Math.abs(Number(broker.log.filter(l => l.method === 'POST')[1].body.qty) - 20 / 50000) < 1e-9);
});

test('never sells your own holdings, only what Rutherford bought', async () => {
  const { live, broker } = setup();
  broker.positions.AAPL = 10; // you already own AAPL yourself
  await live.turnOn();
  assert.equal(live.onBotTrade(bot, trade('sell', 'AAPL', 0), 1000), null);
  // Rutherford buys 1 share worth; on sell it only sells that
  live.configure({ mode: 'auto' });
  const b = live.onBotTrade(bot, trade('buy', 'AAPL', 100), 1000);
  await live.execute(b.id).catch(() => {});
  await new Promise(r => setTimeout(r, 1200));
  const mine = live.state.ledger.AAPL.qty;
  assert.ok(mine > 0 && mine < 1);
  live.state.ledger.AAPL.openedAt = T0 - 864e5; // bought yesterday (so the same-day rule doesn't defer it)
  const s = live.onBotTrade(bot, trade('sell', 'AAPL', 0), 1000);
  await new Promise(r => setTimeout(r, 1500));
  assert.equal(live.state.proposals.find(x => x.id === s.id).status, 'filled');
  assert.ok(Math.abs(broker.positions.AAPL - 10) < 1e-9, 'your 10 shares untouched');
});

test('limits: per-trade cap, budget, orders per day, crypto disabled, market closed', async () => {
  const { live, broker } = setup({ clockOpen: false });
  live.configure({ budgetUsd: 30, maxPerTradeUsd: 25, maxOrdersPerDay: 2 });
  await live.turnOn();
  // big bot trade is capped at 25
  let p = live.onBotTrade(bot, trade('buy', 'BTC-USD', 900), 1000); assert.equal(p.usd, 25);
  await live.approve(p.id);
  // only $5 of budget left
  p = live.onBotTrade(bot, trade('buy', 'ETH-USD', 900), 1000); assert.equal(p.usd, 5);
  await live.approve(p.id);
  p = live.onBotTrade(bot, trade('buy', 'ETH-USD', 900), 1000); assert.equal(p.status, 'blocked'); assert.match(p.error, /Budget/);
  // order cap
  live.configure({ budgetUsd: 1000 });
  p = live.onBotTrade(bot, trade('buy', 'ETH-USD', 100), 1000); const r = await live.approve(p.id);
  assert.equal(r.status, 'blocked'); assert.match(r.error, /Daily order limit/);
  // crypto disabled at the broker
  live.configure({ maxOrdersPerDay: 50 }); broker.acct.crypto_status = 'INACTIVE';
  p = live.onBotTrade(bot, trade('buy', 'ETH-USD', 100), 1000); assert.match((await live.approve(p.id)).error, /Crypto trading is not enabled/);
  // stocks while market closed
  p = live.onBotTrade(bot, trade('buy', 'AAPL', 100), 1000); assert.match((await live.approve(p.id)).error, /market is closed/);
  assert.equal(broker.log.filter(l => l.method === 'POST').length, 2);
});

test('daily loss limit switches real trading off by itself', async () => {
  const { live, broker } = setup();
  live.configure({ dailyLossLimitUsd: 25 });
  await live.turnOn();
  const p = live.onBotTrade(bot, trade('buy', 'BTC-USD', 200), 1000); await live.approve(p.id);
  broker.opts.extraLoss = 30; // account is down $30 today
  await live.tick();
  assert.equal(live.state.enabled, false); assert.match(live.state.haltedReason, /Daily loss limit/);
  assert.equal(live.onBotTrade(bot, trade('buy', 'BTC-USD', 200), 1000), null, 'no new orders while off');
});

test('a lost reply is looked up, never resent (no double orders)', async () => {
  const { live, broker } = setup();
  await live.turnOn();
  broker.opts.dropReply = true;
  const p = live.onBotTrade(bot, trade('buy', 'BTC-USD', 200), 1000);
  const r = await live.approve(p.id);
  assert.equal(r.status, 'unknown');
  await live.tick();
  const after = live.state.proposals.find(x => x.id === p.id);
  assert.equal(after.status, 'filled');
  assert.equal(broker.log.filter(l => l.method === 'POST').length, 1, 'only one order ever sent');
  assert.ok(broker.log.some(l => l.path.startsWith('/v2/orders:by_client_order_id')));
  assert.ok(live.state.ledger['BTC-USD'].qty > 0);
});

test('kill switch: everything off, waiting orders skipped, open orders canceled', async () => {
  const { live, broker } = setup();
  await live.turnOn();
  broker.opts.fill = false; // order sits open at the broker
  const p1 = live.onBotTrade(bot, trade('buy', 'BTC-USD', 200), 1000); await live.approve(p1.id);
  const p2 = live.onBotTrade(bot, trade('buy', 'ETH-USD', 200), 1000);
  const r = await live.killSwitch();
  assert.equal(live.state.enabled, false);
  assert.equal(r.cancelled.length, 1); assert.equal([...broker.orders.values()][0].status, 'canceled');
  assert.equal(live.state.proposals.find(x => x.id === p2.id).status, 'skipped');
  await assert.rejects(live.approve(p2.id));
});

test('real-money account needs live keys and the exact confirmation sentence', async () => {
  const { live, broker, keys } = setup({ target: 'live' });
  await assert.rejects(live.turnOn({ confirm: 'yes' }), /Type exactly/);
  await live.turnOn({ confirm: 'i understand i can lose real money' });
  assert.equal(live.state.enabled, true);
  const p = live.onBotTrade(bot, trade('buy', 'BTC-USD', 100), 1000); await live.approve(p.id);
  assert.equal(broker.log.find(l => l.method === 'POST').host, 'live');
  // can't switch accounts while holding positions; switching later turns it off
  assert.throws(() => live.configure({ target: 'paper' }), /Sell/);
  keys.liveId = ''; live.turnOff();
  await assert.rejects(live.turnOn({ confirm: 'I understand I can lose real money' }), /LIVE keys/);
});

test('approvals expire after 10 minutes', async () => {
  const { live, clock } = setup();
  await live.turnOn();
  const p = live.onBotTrade(bot, trade('buy', 'BTC-USD', 100), 1000);
  clock.t += 11 * 60000;
  await live.tick();
  assert.equal(live.state.proposals.find(x => x.id === p.id).status, 'expired');
});

test('stocks bought today are sold next trading day (no day trades)', async () => {
  const { live, clock, broker } = setup();
  live.configure({ mode: 'auto' });
  await live.turnOn();
  const b = live.onBotTrade(bot, trade('buy', 'AAPL', 100), 1000);
  await new Promise(r => setTimeout(r, 1200));
  assert.equal(live.state.proposals.find(x => x.id === b.id).status, 'filled');
  const s = live.onBotTrade(bot, trade('sell', 'AAPL', 0), 1000);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(live.state.proposals.find(x => x.id === s.id).status, 'deferred');
  clock.t += 864e5; // next day
  await live.tick();
  await new Promise(r => setTimeout(r, 1200));
  assert.equal(live.state.ledger.AAPL, undefined, 'sold the next day');
  assert.equal(broker.log.filter(l => l.method === 'POST' && l.body.side === 'sell').length, 1);
});

test('wired into Alpha: in auto mode the followed bot’s paper trade becomes a real (practice) order', async () => {
  const clock = { t: T0 };
  const world = fakeWorld(clock, { price: (s, t) => (s === 'BTC-USD' ? 60000 * (1 + 0.0004 * Math.max(-600, (t - T0) / 60000)) : 100) });
  const broker = fakeBroker({ price: s => (s === 'BTCUSD' ? 60000 : 100) });
  const fetchImpl = (url, o) => (broker.handles(url) ? broker.fetchImpl(url, o) : world.fetchImpl(url, o));
  const { createApp, listen } = require('../server.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-'));
  const server = createApp({ dataDir: dir, timers: false, fetchImpl, now: () => clock.t, rutherfordSettings: '/none' });
  const port = await listen(server, 0); const base = 'http://127.0.0.1:' + port;
  const api = async (p, body) => { const r = await fetch(base + '/api/' + p, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const j = await r.json(); if (!r.ok) throw Error(j.error); return j; };
  try {
    await api('settings', { alpacaKeyId: 'PKPAPER', alpacaSecret: 's1', botsUsePolymarket: false, watchlist: ['BTC-USD'] });
    await api('live/config', { botId: 'proton', mode: 'auto', budgetUsd: 50, maxPerTradeUsd: 20 });
    await api('live/on', {});
    await api('arena/tick', {}); // Proton buys BTC in paper → real practice order
    await new Promise(r => setTimeout(r, 1500));
    const v = await api('live');
    assert.equal(v.state.enabled, true);
    assert.ok(v.proposals.some(p => p.sym === 'BTC-USD' && p.status === 'filled'), JSON.stringify(v.proposals));
    assert.equal(v.holdings[0].sym, 'BTC-USD');
    assert.ok(v.account.equity > 0);
    const st = await api('state'); assert.ok(!JSON.stringify(st).includes('"s1"'));
  } finally { await new Promise(r => server.close(r)); }
});

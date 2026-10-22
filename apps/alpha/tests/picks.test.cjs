'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Picks = require('../lib/picks.cjs');
const { fakeWorld } = require('./fakeworld.cjs');

test('picks: researched odds, cached, scored against the market when it resolves', async () => {
  const clock = { t: Date.UTC(2026, 9, 21, 15) };
  const world = fakeWorld(clock, { pmMarkets: [{ id: '301', question: 'Browns beat Steelers?', prices: [0.4, 0.6], end: clock.t + 864e5 }] });
  const groqCalls = [];
  const groqFetch = async (url, o) => {
    const body = JSON.parse(o.body); groqCalls.push(body);
    const content = 'Searched injury reports.\n```json\n{"probabilities":{"Yes":55,"No":45},"pick":"Yes","confidence":"medium","summary":"Steelers QB is out; Browns defense is top 5.","factors":["Steelers starting QB ruled out","Browns 4-1 at home"]}\n```';
    return new Response(JSON.stringify({ choices: [{ message: { content, executed_tools: [{ search_results: { results: [{ title: 'ESPN injury report', url: 'https://espn.com/x' }] } }] } }] }));
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'al-'));
  const rs = path.join(dir, 'rs.json'); fs.writeFileSync(rs, JSON.stringify({ groqKey: 'gsk_x' }));
  const { createApp, listen } = require('../server.cjs');
  const server = createApp({ dataDir: dir, timers: false, fetchImpl: world.fetchImpl, groqFetch, now: () => clock.t, rutherfordSettings: rs });
  const port = await listen(server, 0); const base = 'http://127.0.0.1:' + port;
  const api = async (p, body) => { const r = await fetch(base + '/api/' + p, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const j = await r.json(); if (!r.ok) throw Error(j.error); return j; };
  try {
    const p = await api('pm/pick', { marketId: '301' });
    assert.equal(p.pick, 'Yes'); assert.deepEqual(p.probs, [0.55, 0.45]); assert.equal(p.confidence, 'medium');
    assert.equal(p.edge, 0.15); assert.equal(p.sources[0].url, 'https://espn.com/x');
    assert.deepEqual(groqCalls[0].tools, [{ type: 'browser_search' }]);
    assert.match(groqCalls[0].messages[1].content, /Yes = 40¢, No = 60¢/);
    await api('pm/pick', { marketId: '301' });
    assert.equal(groqCalls.length, 1, 'second ask uses the cached pick');
    // list shows the pick on the card
    const list = await api('pm/markets?cat=sports');
    assert.equal(list.find(m => m.id === '301').pick.pick, 'Yes');
    // the AI bot sees Rutherford's pick
    const arena = server.alpha.arena;
    // game ends: Browns win
    Object.assign(world.pm.get('301'), { closed: true, prices: [1, 0] });
    clock.t += 2 * 864e5;
    await server.alpha.tick();
    const rec = await api('pm/picks');
    assert.equal(rec.record.settled, 1); assert.equal(rec.record.right, 1); assert.equal(rec.record.marketRight, 0);
    assert.ok(rec.record.brierAI < rec.record.brierMarket);
    assert.match(rec.record.verdict, /Too early/);
    void arena;
  } finally { await new Promise(r => server.close(r)); }
});

test('pick parsing is forgiving but strict about missing odds', () => {
  assert.deepEqual(Picks.normalizeProbs({ yes: 0.7 }, ['Yes', 'No']).map(x => Math.round(x * 100)), [70, 30]);
  assert.deepEqual(Picks.normalizeProbs({ Over: 60, Under: 40 }, ['Over', 'Under']).map(x => Math.round(x * 100)), [60, 40]);
  assert.equal(Picks.normalizeProbs({ A: 0.5 }, ['A', 'B', 'C']), null);
  assert.equal(Picks.parseJson('blah {"a":1} more').a, 1);
  assert.equal(Picks.parseJson('```json\n{"b":2}\n```').b, 2);
  assert.ok(Math.abs(Picks.brier([0.7, 0.3], 0) - 0.18) < 1e-9);
});

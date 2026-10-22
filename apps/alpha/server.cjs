'use strict';
// Rutherford Alpha: paper trading + forecast lab. Local only (127.0.0.1). No real orders, ever.
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const Store = require('./lib/store.cjs');
const Market = require('./lib/market.cjs');
const paper = require('./lib/paper.cjs');
const strat = require('./lib/strategies.cjs');
const groq = require('./lib/groq.cjs');
const Polymarket = require('./lib/polymarket.cjs');
const Bots = require('./lib/bots.cjs');
const Live = require('./lib/live.cjs');
const Picks = require('./lib/picks.cjs');
const VERSION = require('./package.json').version;
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.json': 'application/json' };

function appData(name) {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), name);
  return path.join(os.homedir(), '.' + name.toLowerCase().replace(/\s+/g, '-'));
}
const defaultDataDir = () => process.env.ALPHA_DATA || appData('RutherfordAlpha');

// The Alpha app as a request handler, so it can run on its own OR inside Rutherford (mounted at /alpha/).
function createHandler({ dataDir = defaultDataDir(), fetchImpl = fetch, groqFetch, now = () => Date.now(), rutherfordSettings = path.join(process.env.RUTHERFORD_DATA || appData('Rutherford'), 'settings.json'), timers = true } = {}) {
  const store = Store.create(dataDir);
  const alpacaKeys = () => { const s = store.settings.get(); return { id: s.alpacaKeyId, secret: s.alpacaSecret }; };
  const market = Market.create({ fetchImpl, now, alpacaKeys });
  const poly = Polymarket.create({ fetchImpl, now });

  // Reuse the Groq key from the main Rutherford app if Alpha doesn't have one yet
  const groqKey = () => {
    const own = store.settings.get().groqKey; if (own) return own;
    try { return JSON.parse(fs.readFileSync(rutherfordSettings, 'utf8')).groqKey || ''; } catch { return ''; }
  };
  const publicSettings = () => { const s = store.settings.get(); return { ...s, groqKey: undefined, alpacaSecret: undefined, alpacaLiveSecret: undefined, hasAlpacaLive: !!(s.alpacaLiveKeyId && s.alpacaLiveSecret), alpacaLiveKeyHint: s.alpacaLiveKeyId ? s.alpacaLiveKeyId.slice(0, 4) + '…' : '', hasAlpaca: !!(s.alpacaKeyId && s.alpacaSecret), alpacaKeyHint: s.alpacaKeyId ? s.alpacaKeyId.slice(0, 4) + '…' : '', hasKey: !!groqKey(), keyFromRutherford: !s.groqKey && !!groqKey() }; };

  // One-shot JSON answer from Groq (used by the AI bot)
  async function groqJson(messages) {
    const key = groqKey(); if (!key) throw Error('Needs a Groq key (add one in Rutherford Settings)');
    const s = store.settings.get();
    const call = async withFormat => {
      const res = await (groqFetch || fetchImpl)(groq.BASE + '/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60000),
        body: JSON.stringify({ model: s.model, messages, temperature: 0.4, max_tokens: 1500, ...(withFormat ? { response_format: { type: 'json_object' } } : {}) }) });
      const j = await res.json().catch(() => null);
      if (!res.ok) { const e = Error(res.status === 429 ? 'Groq rate limit, will retry next round' : 'Groq HTTP ' + res.status); e.status = res.status; throw e; }
      return j?.choices?.[0]?.message?.content || '';
    };
    try { return await call(true); } catch (e) { if (e.status === 400) return call(false); throw e; }
  }
  const picks = Picks.create({ load: () => store.picks.get(), save: x => store.picks.set(x), groqKey, fetchImpl: groqFetch || fetchImpl, now });
  let live = null;
  const arena = Bots.create({ load: () => store.arena.get(), save: a => store.arena.set(a), market, poly, ask: groqJson, settings: () => store.settings.get(), now,
    onTrade: (bot, tr, eq) => live?.onBotTrade(bot, tr, eq), picks: id => picks.get(id) });
  live = Live.create({ load: () => store.live.get(), save: x => store.live.set(x), fetchImpl, now, market,
    keys: () => { const s = store.settings.get(); return { paperId: s.alpacaKeyId, paperSecret: s.alpacaSecret, liveId: s.alpacaLiveKeyId, liveSecret: s.alpacaLiveSecret }; },
    botView: id => { const b = arena.view().bots.find(x => x.id === id); return b ? { id: b.id, name: b.name, emoji: b.emoji, color: b.color, stats: b.stats } : null; } });
  const withPicks = list => list.map(m => ({ ...m, pick: picks.get(m.id) }));

  async function marketsFor(holder) {
    const out = {};
    for (const id of [...new Set((holder.bets || []).filter(b => b.status === 'open').map(b => b.marketId))]) { try { out[id] = await poly.market(id); } catch {} }
    return out;
  }

  async function quotes(pairs = store.settings.get().watchlist) {
    const out = await Promise.allSettled(pairs.map(p => market.quote(p)));
    return pairs.map((pair, i) => out[i].status === 'fulfilled' ? out[i].value : { pair, error: out[i].reason.message });
  }
  async function priceMap(pairs) { const m = {}; for (const q of await quotes(pairs)) if (q.price) m[q.pair] = q.price; return m; }

  async function portfolioView() {
    const p = store.portfolio.get();
    const prices = await priceMap(Object.keys(p.positions));
    return paper.summary(p, prices, await marketsFor(p));
  }
  async function settleMyBets() {
    const p = store.portfolio.get(); if (!(p.bets || []).some(b => b.status === 'open')) return 0;
    const changed = Polymarket.settleBets(p, await marketsFor(p));
    if (changed.length) store.portfolio.set(p);
    return changed.length;
  }

  // ---- forecasts ----
  async function runForecasts(pairs = store.settings.get().watchlist, { source = 'manual' } = {}) {
    const list = store.forecasts.get(); const created = [];
    for (const pair of pairs) {
      let candles, q;
      try { [candles, q] = await Promise.all([market.candles(pair, 300), market.quote(pair)]); } catch (e) { created.push({ pair, error: e.message }); continue; }
      for (const sig of strat.signals(candles)) {
        if (!sig.direction) continue;
        for (const h of strat.HORIZONS) {
          const f = { id: now().toString(36) + Math.random().toString(36).slice(2, 7), pair, strategy: sig.strategy, direction: sig.direction, why: sig.why, horizon: h, startPrice: q.price, start: now(), due: now() + h * 60000, result: null, source };
          list.push(f); created.push(f);
        }
      }
    }
    store.forecasts.set(list);
    return created;
  }

  let settling = false;
  async function settle() {
    if (settling) return { settled: 0 }; settling = true;
    try {
      const list = store.forecasts.get(); let changed = 0;
      const due = list.filter(f => !f.result && f.due <= now()).slice(0, 200);
      const live = await priceMap([...new Set(due.filter(f => now() - f.due < 90000).map(f => f.pair))]);
      for (const f of due) {
        try {
          const end = now() - f.due < 90000 && live[f.pair] ? live[f.pair] : await market.priceAt(f.pair, f.due);
          f.endPrice = end; f.settledAt = now();
          f.result = end === f.startPrice ? 'push' : (end > f.startPrice) === (f.direction === 'up') ? 'win' : 'loss';
          changed++;
        } catch { if (now() - f.due > 7 * 864e5) { f.result = 'void'; changed++; } }
      }
      if (changed) store.forecasts.set(list);
      return { settled: changed };
    } finally { settling = false; }
  }

  let lastAuto = 0;
  async function tick() {
    try { await settle(); } catch {}
    try { await settleMyBets(); } catch {}
    try { await arena.tick(); } catch {}
    try { await live.tick(); } catch {}
    try { await picks.settle(id => poly.market(id)); } catch {}
    const s = store.settings.get();
    if (s.autoForecast && now() - lastAuto >= s.autoEveryMin * 60000) { lastAuto = now(); try { await runForecasts(s.watchlist, { source: 'auto' }); } catch {} }
  }
  // forecasts, bets and the bot arena all run from this 30-second heartbeat
  const timer = timers ? setInterval(tick, 30000) : null; timer?.unref?.();
  if (timers) setTimeout(tick, 2000).unref?.();

  // ---- Ask (AI market analyst) ----
  async function marketContext() {
    const s = store.settings.get();
    const qs = await quotes(s.watchlist);
    const lines = [];
    for (const q of qs) {
      if (q.error) { lines.push(`${q.pair}: unavailable (${q.error})`); continue; }
      let trend = '';
      try {
        const c = await market.candles(q.pair, 3600); const closes = c.map(x => x.c);
        const ch = n => closes.length > n ? ((closes.at(-1) - closes.at(-1 - n)) / closes.at(-1 - n) * 100).toFixed(2) + '%' : 'n/a';
        trend = ` | 6h ${ch(6)} | 24h ${ch(24)} | 7d ${ch(168)}`;
      } catch {}
      lines.push(`${q.pair}: $${q.price} (24h ${q.change24h?.toFixed(2)}%, high ${q.high24h}, low ${q.low24h})${trend}`);
    }
    const pf = await portfolioView();
    const sb = strat.scoreboard(store.forecasts.get());
    const av = arena.view();
    const botsTxt = av.bots.map(b => `${b.name} (${b.style}): equity $${b.stats.equity}, return ${b.stats.returnPct}%, win rate ${b.stats.winRate ?? '-'}% over ${b.stats.closed} closed, max drawdown ${b.stats.maxDrawdownPct}%, holding ${b.positions.map(p => p.sym).join(', ') || 'nothing'}`).join('\n');
    const lessons = av.lessons.slice(0, 8).map(l => '- ' + l.text).join('\n');
    const pr = picks.record();
    return `Rutherford's Polymarket picks record: ${pr.settled ? `${pr.right}/${pr.settled} right (${pr.accuracy}%) vs market favorite ${pr.marketAccuracy}%; ${pr.verdict}` : 'no finished picks yet'}.\nReal-money copy trading: ${live.state.enabled ? `ON (${live.state.target === 'live' ? 'REAL money' : 'Alpaca practice'}, following ${live.state.botId})` : 'off'}.\n\nStock market is ${av.stockOpen ? 'open' : 'closed'}.\n\nBOT ARENA (4 paper bots, started ${new Date(av.startedAt).toDateString()}${av.benchmark ? `; holding BTC since then returned ${av.benchmark.returnPct}%` : ''}):\n${botsTxt}\nRecent lessons:\n${lessons || '- none yet'}\n\nLive prices:\n${lines.join('\n')}\n\nPaper portfolio: equity $${pf.equity.toFixed(2)} (started $${pf.startCash}), cash $${pf.cash.toFixed(2)}, P&L ${pf.totalPnlPct.toFixed(2)}%.\nPositions: ${pf.positions.map(p => `${p.pair} ${p.qty} @ avg $${p.avg.toFixed(4)} (now ${p.pnlPct?.toFixed(2)}%)`).join('; ') || 'none'}\n\nForecast scoreboard (settled results):\n${sb.strategies.map(s => `${s.name}: ${s.n ? s.accuracy.toFixed(1) + '% of ' + s.n + ' (95% range ' + s.ci.map(x => x.toFixed(0)).join('–') + '%) — ' + s.verdict.text : 'no results yet'}`).join('\n')}`;
  }

  async function ask(req, res, body) {
    const key = groqKey();
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
    const emit = ev => { if (!res.writableEnded) res.write('data: ' + JSON.stringify(ev) + '\n\n'); };
    const ac = new AbortController(); res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    try {
      if (!key) throw Error('Add a Groq key in Settings (or set one up in Rutherford; Alpha uses it automatically).');
      const ctx = await marketContext();
      const history = (Array.isArray(body.history) ? body.history : []).slice(-12).filter(m => ['user', 'assistant'].includes(m.role)).map(m => ({ role: m.role, content: String(m.content).slice(0, 8000) }));
      const messages = [
        { role: 'system', content: `You are Alpha, a sharp, plain-spoken market analyst inside Rutherford Alpha, a PAPER trading and forecasting lab (fake money only). Today is ${new Date(now()).toUTCString()}.\nRules: use the live data below; never invent prices. Be honest about uncertainty: short-term crypto moves are mostly noise, and a forecast strategy only matters if it beats a coin flip with enough results. Give concrete, specific takes (levels, risk, position size as % of the paper account) but never promise outcomes. Keep it short unless asked for depth. Use Markdown.\n\n${ctx}` },
        ...history, { role: 'user', content: String(body.question || '').slice(0, 8000) }
      ];
      const s = store.settings.get();
      const r = await groq.stream({ key, model: s.model, messages, signal: ac.signal, fetchImpl: groqFetch || fetchImpl, maxTokens: 4096, onText: d => emit({ type: 'text', delta: d }) });
      emit({ type: 'done', content: r.content });
    } catch (e) { emit({ type: 'error', message: e.code === 'aborted' ? 'Stopped.' : e.message }); }
    finally { res.end(); }
  }

  const routes = {
    'GET /api/state': async () => ({ version: VERSION, dataDir, settings: publicSettings(), strategies: strat.STRATEGIES, horizons: strat.HORIZONS }),
    'GET /api/quotes': () => quotes(),
    'GET /api/candles': (b, q) => market.candles(q.get('pair'), Number(q.get('g')) || 300),
    'GET /api/signals': async (b, q) => { const pair = market.check(q.get('pair')); return strat.signals(await market.candles(pair, 300)).filter(s => s.strategy !== 'coin'); },
    'POST /api/settings': b => {
      const patch = {};
      if (typeof b.groqKey === 'string') patch.groqKey = b.groqKey.trim().slice(0, 300);
      if (typeof b.model === 'string') patch.model = b.model.slice(0, 120);
      if (b.feePct !== undefined) { const v = Number(b.feePct); if (!(v >= 0 && v <= 5)) throw Error('Fee must be 0–5%'); patch.feePct = v; }
      if (b.maxPositionPct !== undefined) { const v = Number(b.maxPositionPct); if (!(v >= 5 && v <= 100)) throw Error('Position limit must be 5–100%'); patch.maxPositionPct = v; }
      if (b.autoForecast !== undefined) patch.autoForecast = !!b.autoForecast;
      if (b.autoEveryMin !== undefined) { const v = Number(b.autoEveryMin); if (![5, 15, 30, 60].includes(v)) throw Error('Pick 5, 15, 30 or 60 minutes'); patch.autoEveryMin = v; }
      if (Array.isArray(b.watchlist)) { const list = [...new Set(b.watchlist.map(x => market.check(x)))]; if (list.length > 20) throw Error('20 symbols max'); patch.watchlist = list; }
      if (typeof b.alpacaLiveKeyId === 'string') patch.alpacaLiveKeyId = b.alpacaLiveKeyId.trim().slice(0, 100);
      if (typeof b.alpacaLiveSecret === 'string') patch.alpacaLiveSecret = b.alpacaLiveSecret.trim().slice(0, 200);
      if (typeof b.alpacaKeyId === 'string') patch.alpacaKeyId = b.alpacaKeyId.trim().slice(0, 100);
      if (typeof b.alpacaSecret === 'string') patch.alpacaSecret = b.alpacaSecret.trim().slice(0, 200);
      if (b.stockFeePct !== undefined) { const v = Number(b.stockFeePct); if (!(v >= 0 && v <= 2)) throw Error('Stock fee must be 0–2%'); patch.stockFeePct = v; }
      if (b.arenaOn !== undefined) patch.arenaOn = !!b.arenaOn;
      if (b.botsUsePolymarket !== undefined) patch.botsUsePolymarket = !!b.botsUsePolymarket;
      if (b.botEveryMin !== undefined) { const v = Number(b.botEveryMin); if (![1, 5, 15, 30, 60].includes(v)) throw Error('Pick 1, 5, 15, 30 or 60 minutes'); patch.botEveryMin = v; }
      if (b.aiEveryMin !== undefined) { const v = Number(b.aiEveryMin); if (![5, 15, 30, 60].includes(v)) throw Error('Pick 5, 15, 30 or 60 minutes'); patch.aiEveryMin = v; }
      if (b.evolveHours !== undefined) { const v = Number(b.evolveHours); if (![6, 12, 24, 72, 168].includes(v)) throw Error('Pick 6, 12, 24, 72 or 168 hours'); patch.evolveHours = v; }
      store.settings.set(patch); return publicSettings();
    },
    'POST /api/watchlist': async b => {
      const s = store.settings.get(); let list = [...s.watchlist];
      if (b.add) { const pair = market.check(b.add); if (!list.includes(pair)) { await market.quote(pair); list.push(pair); } }
      if (b.remove) list = list.filter(p => p !== b.remove);
      if (list.length > 20) throw Error('20 symbols max');
      store.settings.set({ watchlist: list }); return list;
    },
    'GET /api/portfolio': () => portfolioView(),
    'POST /api/trade': async b => {
      const s = store.settings.get(); const p = store.portfolio.get();
      const pair = market.check(b.pair); const q = await market.quote(pair);
      const fee = market.kind(pair) === 'crypto' ? s.feePct : s.stockFeePct;
      const trade = b.side === 'buy'
        ? paper.buy(p, { pair, usd: b.usd, price: q.price, feePct: fee, maxPositionPct: s.maxPositionPct, prices: await priceMap(Object.keys(p.positions)) })
        : b.side === 'sell' ? paper.sell(p, { pair, qty: b.qty, price: q.price, feePct: fee }) : (() => { throw Error('side must be buy or sell'); })();
      if (market.kind(pair) === 'stock') { try { if (!(await market.stockClock()).open) trade.note = 'Stock market is closed, so this filled at the last price'; } catch {} }
      store.portfolio.set(p); return { trade, portfolio: await portfolioView() };
    },
    'POST /api/portfolio/reset': async b => { const cash = Number(b.cash) || 1000; if (cash < 10 || cash > 10_000_000) throw Error('Starting cash must be $10 – $10M'); store.portfolio.reset(cash); return portfolioView(); },
    'GET /api/forecasts': () => { const list = store.forecasts.get(); return { scoreboard: strat.scoreboard(list), recent: list.slice(-60).reverse() }; },
    'POST /api/forecast/run': async b => { const created = await runForecasts(b.pair ? [market.check(b.pair)] : undefined); return { created: created.filter(c => !c.error).length, errors: created.filter(c => c.error) }; },
    'POST /api/forecast/manual': async b => {
      const pair = market.check(b.pair); if (!['up', 'down'].includes(b.direction)) throw Error('Pick up or down');
      const h = Number(b.horizon); if (!strat.HORIZONS.includes(h)) throw Error('Pick a time frame');
      const q = await market.quote(pair); const list = store.forecasts.get();
      const f = { id: now().toString(36) + Math.random().toString(36).slice(2, 7), pair, strategy: 'me', direction: b.direction, why: String(b.why || 'My call').slice(0, 200), horizon: h, startPrice: q.price, start: now(), due: now() + h * 60000, result: null, source: 'me' };
      list.push(f); store.forecasts.set(list); return f;
    },
    'POST /api/forecast/settle': () => settle(),
    // ---- stocks / clock ----
    'GET /api/clock': async () => ({ ...(await market.stockClock()), dataSource: market.stockSource() }),
    'POST /api/alpaca/test': async () => { if (!publicSettings().hasAlpaca) throw Error('Add both Alpaca keys first'); const q = await market.quote('SPY'); if (q.source !== 'alpaca') throw Error('Alpaca keys didn\u2019t work (' + (market.alpacaError() || 'no reply') + '). Stocks are using Yahoo for now.'); return { ok: true, spy: q.price, source: q.source }; },
    // ---- bot arena ----
    'GET /api/arena': () => arena.view(),
    'GET /api/arena/bot': (b, q) => arena.botDetail(q.get('id')),
    'POST /api/arena/tick': async () => { const r = await arena.tick({ force: true }); return { ...r, view: arena.view() }; },
    'POST /api/arena/reset': b => { const cash = Number(b.cash) || store.settings.get().botStartCash; if (cash < 100 || cash > 1_000_000) throw Error('Starting cash must be $100 – $1M'); store.settings.set({ botStartCash: cash }); return arena.reset(cash); },
    'POST /api/arena/evolve': async () => ({ result: await arena.forceEvolve(), view: arena.view() }),
    // ---- Polymarket (paper) ----
    'GET /api/pm/markets': async (b, q) => withPicks(await poly.listMarkets({ category: q.get('cat') || 'trending' })),
    'GET /api/pm/search': async (b, q) => withPicks(await poly.search(q.get('q'))),
    'POST /api/pm/pick': async b => picks.pick(await poly.market(String(b.marketId)), { force: !!b.force }),
    'GET /api/pm/picks': () => ({ record: picks.record(), recent: picks.recent() }),
    // ---- real money (Alpaca) ----
    'GET /api/live': () => live.view(),
    'GET /api/live/pending': () => ({ waiting: live.state.proposals.filter(p => p.status === 'waiting').length, state: live.publicState() }),
    'POST /api/live/config': b => live.configure(b),
    'POST /api/live/on': b => live.turnOn({ confirm: b.confirm }),
    'POST /api/live/off': () => live.turnOff(),
    'POST /api/live/kill': () => live.killSwitch(),
    'POST /api/live/approve': b => live.approve(String(b.id)),
    'POST /api/live/skip': b => live.skip(String(b.id)),
    'POST /api/live/closeall': () => live.closeAll(),
    'POST /api/pm/bet': async b => {
      const m = await poly.market(String(b.marketId)); const p = store.portfolio.get();
      const bet = Polymarket.placeBet(p, { market: m, outcome: b.outcome, usd: b.usd, by: 'you', time: now() });
      store.portfolio.set(p); return { bet, portfolio: await portfolioView() };
    },
    'POST /api/pm/sell': async b => {
      const p = store.portfolio.get(); const bet = (p.bets || []).find(x => x.id === b.betId); if (!bet) throw Error('Bet not found');
      const r = Polymarket.sellBet(p, b.betId, await poly.market(bet.marketId), now()); store.portfolio.set(p); return { bet: r, portfolio: await portfolioView() };
    },
    'POST /api/forecast/clear': () => { store.forecasts.set([]); return { cleared: true }; }
  };

  const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  const readBody = req => new Promise((resolve, reject) => { const c = []; let n = 0; req.on('data', d => { n += d.length; if (n > 1e6) { reject(Error('Too large')); req.destroy(); } else c.push(d); }); req.on('end', () => { try { resolve(c.length ? JSON.parse(Buffer.concat(c)) : {}); } catch { reject(Error('Bad JSON')); } }); });

  // pathname is relative to wherever Alpha is mounted (always starts with "/")
  async function handle(req, res, pathname, searchParams) {
    try {
      if (req.method === 'POST' && pathname === '/api/ask') return await ask(req, res, await readBody(req));
      const h = routes[req.method + ' ' + pathname];
      if (h) return json(res, 200, await h(req.method === 'POST' ? await readBody(req) : {}, searchParams));
      if (pathname.startsWith('/api/')) return json(res, 404, { error: 'Unknown API route' });
      const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
      const file = path.resolve(PUBLIC, rel);
      if (req.method !== 'GET' || !file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      fs.createReadStream(file).pipe(res);
    } catch (e) { if (res.headersSent) return res.end(); json(res, 400, { error: e.message }); }
  }
  return { handle, stop: () => clearInterval(timer), alpha: { settle, runForecasts, tick, arena, live, picks } };
}

// Standalone Alpha server
function createApp(opts = {}) {
  const h = createHandler(opts);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost'].includes(host)) { res.writeHead(403); return res.end('Forbidden'); }
    if (req.method === 'POST') { const o = req.headers.origin; if (o && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(o)) { res.writeHead(403); return res.end('Forbidden'); } }
    h.handle(req, res, url.pathname, url.searchParams);
  });
  server.on('close', h.stop);
  server.alpha = h.alpha;
  return server;
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', e => (e.code === 'EADDRINUSE' && port !== 0 ? resolve(listen(server, 0)) : reject(e)));
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

if (require.main === module) {
  listen(createApp(), Number(process.env.PORT) || 3738).then(port => {
    const url = 'http://127.0.0.1:' + port;
    console.log('\n  Rutherford Alpha ' + VERSION + ' is running at ' + url + '\n  Paper trading only. No real money, no real orders.\n  Your data: ' + defaultDataDir() + '\n  Keep this window open. Forecasts are scored while it runs.\n');
    if (!process.argv.includes('--no-open')) {
      const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
      try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref(); } catch {}
    }
  }).catch(e => { console.error('Could not start: ' + e.message); process.exit(1); });
}

module.exports = { createApp, createHandler, listen };

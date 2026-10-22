'use strict';
// The Bot Arena: four paper-trading bots that compete, keep score, and learn from each other.
//   Proton ⚡  momentum: buys what's moving up
//   Electron 🔄 contrarian: buys dips below the average
//   Neutron 🧭  trend follower: rides longer trends
//   Nucleus 🧠  AI strategist: an LLM reads the market, the other bots' results and the lesson log
// Rule bots "learn" by evolution: the weakest copies part of the leader's settings (with small mutations).
// Fake money only. Nothing in here can place a real order.
const paper = require('./paper.cjs');
const pm = require('./polymarket.cjs');
const { wilson, verdict } = require('./strategies.cjs');

const BOTS = [
  { id: 'proton', name: 'Proton', emoji: '⚡', color: '#ffb547', style: 'momentum', about: 'Momentum hunter. Buys whatever is climbing fastest, takes quick profits. On Polymarket: backs strong favorites.' },
  { id: 'electron', name: 'Electron', emoji: '🔄', color: '#4fd3ff', style: 'contrarian', about: 'Contrarian. Buys dips below the 1-hour average and sells when price snaps back. On Polymarket: picks cheap underdogs.' },
  { id: 'neutron', name: 'Neutron', emoji: '🧭', color: '#3be08f', style: 'trend', about: 'Trend follower. Waits for a steady uptrend, holds longer, wider stops. On Polymarket: follows the 24h price move.' },
  { id: 'nucleus', name: 'Nucleus', emoji: '🧠', color: '#a865ff', style: 'ai', about: 'AI strategist. An AI model reads prices, the other bots’ records and the lesson log, then decides. Learns from everyone.' }
];
const GENOMES = {
  proton: { lookback: 12, entryPct: 0.6, takeProfitPct: 2.5, stopLossPct: 1.5, sizePct: 20, maxPositions: 3, maxHoldHours: 12, pmSizePct: 3, pmMinPrice: 0.6, pmMaxPrice: 0.9 },
  electron: { lookback: 12, entryPct: 0.8, takeProfitPct: 1.8, stopLossPct: 2.5, sizePct: 15, maxPositions: 4, maxHoldHours: 24, pmSizePct: 2, pmMinPrice: 0.12, pmMaxPrice: 0.35 },
  neutron: { lookback: 24, entryPct: 0.3, takeProfitPct: 6, stopLossPct: 3, sizePct: 25, maxPositions: 3, maxHoldHours: 72, pmSizePct: 3, pmMinPrice: 0.35, pmMaxPrice: 0.75 },
  nucleus: { sizePct: 25, maxPositions: 4, pmSizePct: 5 }
};
const LIMITS = { lookback: [6, 48, 1], entryPct: [0.1, 4], takeProfitPct: [0.5, 20], stopLossPct: [0.5, 12], sizePct: [5, 35], maxPositions: [1, 6, 1], maxHoldHours: [1, 168], pmSizePct: [1, 8], pmMinPrice: [0.05, 0.85], pmMaxPrice: [0.15, 0.95] };
const GENE_NAMES = { lookback: 'lookback', entryPct: 'entry trigger', takeProfitPct: 'take-profit', stopLossPct: 'stop-loss', sizePct: 'position size', maxPositions: 'max positions', maxHoldHours: 'max hold', pmSizePct: 'bet size', pmMinPrice: 'min odds', pmMaxPrice: 'max odds' };
const MAX_OPEN_BETS = 3;

const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const clampGene = (k, v) => { const [lo, hi, step] = LIMITS[k]; v = Math.min(hi, Math.max(lo, v)); return step ? Math.round(v) : round(v, k.startsWith('pm') && k !== 'pmSizePct' ? 3 : 2); };
const sma = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const fmtGene = (k, v) => k === 'lookback' ? v * 5 + 'm' : k === 'maxPositions' ? String(v) : k === 'maxHoldHours' ? round(v, 1) + 'h' : k.startsWith('pm') && k !== 'pmSizePct' ? Math.round(v * 100) + '¢' : round(v, 2) + '%';
const dur = mins => mins < 60 ? Math.round(mins) + 'm' : mins < 2880 ? round(mins / 60, 1) + 'h' : round(mins / 1440, 1) + 'd';

function freshBot(meta, cash) {
  return { ...meta, genome: { ...GENOMES[meta.id] }, cash, startCash: cash, positions: {}, bets: [], trades: [], equity: [], generation: 1, learnedFrom: null, cooldown: {}, ai: null };
}
function freshArena(cash = 1000, now = Date.now()) {
  return { version: 1, startedAt: now, lastTick: 0, lastEvolve: now, lastAi: 0, benchmark: null, bots: BOTS.map(b => freshBot(b, cash)), lessons: [], evolveMarks: {} };
}

// Indicators for one bot's lookback on 5-minute candles
function indicators(candles, L) {
  const c = candles.map(x => x.c).filter(x => x > 0);
  if (c.length < 3 * L + 1) return null;
  const last = c.at(-1);
  return { last, mom: (last / c.at(-1 - L) - 1) * 100, dev: (last / sma(c.slice(-L)) - 1) * 100, trend: (sma(c.slice(-L)) / sma(c.slice(-3 * L)) - 1) * 100, mom1h: (last / c.at(-13) - 1) * 100, mom24h: c.length > 288 ? (last / c.at(-289) - 1) * 100 : null };
}

function botEquity(bot, prices, markets) { return paper.equity({ cash: bot.cash, positions: bot.positions, bets: bot.bets }, prices, markets); }

function stats(bot, prices = {}, markets = {}) {
  const eq = botEquity(bot, prices, markets);
  const sells = bot.trades.filter(t => t.side === 'sell');
  const settledBets = bot.bets.filter(b => ['won', 'lost', 'sold'].includes(b.status));
  const results = [...sells.map(t => t.pnl), ...settledBets.map(b => b.pnl)];
  const wins = results.filter(x => x > 0), losses = results.filter(x => x <= 0);
  const grossW = wins.reduce((a, b) => a + b, 0), grossL = -losses.reduce((a, b) => a + b, 0);
  const pts = [...bot.equity.map(e => e[1]), eq];
  let peak = -Infinity, maxDD = 0; for (const v of pts) { peak = Math.max(peak, v); maxDD = Math.max(maxDD, peak > 0 ? (peak - v) / peak * 100 : 0); }
  const byPct = sells.filter(t => t.pnlPct != null).sort((a, b) => b.pnlPct - a.pnlPct);
  const n = results.length;
  return {
    equity: round(eq), returnPct: round((eq - bot.startCash) / bot.startCash * 100), cash: round(bot.cash),
    invested: round(eq - bot.cash), closed: n, wins: wins.length, losses: losses.length,
    winRate: n ? round(wins.length / n * 100, 1) : null, ci: wilson(wins.length, n), verdict: verdict(wins.length, n),
    avgWinPct: byPct.filter(t => t.pnlPct > 0).length ? round(sma(byPct.filter(t => t.pnlPct > 0).map(t => t.pnlPct))) : null,
    avgLossPct: byPct.filter(t => t.pnlPct <= 0).length ? round(sma(byPct.filter(t => t.pnlPct <= 0).map(t => t.pnlPct))) : null,
    profitFactor: grossL > 0 ? round(grossW / grossL) : grossW > 0 ? null : null,
    maxDrawdownPct: round(maxDD), best: byPct[0] ? { sym: byPct[0].sym, pct: byPct[0].pnlPct } : null, worst: byPct.at(-1) ? { sym: byPct.at(-1).sym, pct: byPct.at(-1).pnlPct } : null,
    trades: bot.trades.length, betsOpen: bot.bets.filter(b => b.status === 'open').length, betsWon: bot.bets.filter(b => b.status === 'won').length, betsLost: bot.bets.filter(b => b.status === 'lost').length,
    feesPaid: round(bot.trades.reduce((a, t) => a + (t.fee || 0), 0)), lastTrade: bot.trades.at(-1)?.t || null
  };
}

function create({ load, save, market, poly, ask = null, settings, now = () => Date.now(), rand = Math.random, onTrade = null, picks = null }) {
  let arena = load() || freshArena(settings().botStartCash, now());
  let busy = null;
  const persist = () => save(arena);
  const lesson = (bot, text, kind = 'trade') => { arena.lessons.push({ t: now(), bot: bot?.id || null, text, kind }); if (arena.lessons.length > 400) arena.lessons.splice(0, arena.lessons.length - 400); };
  const feeFor = sym => (market.kind(sym) === 'crypto' ? settings().feePct : settings().stockFeePct);

  const roughEquity = bot => bot.cash + Object.values(bot.positions).reduce((a, p) => a + p.qty * p.avg, 0) + bot.bets.filter(b => b.status === 'open').reduce((a, b) => a + b.cost, 0);
  const notify = (bot, tr, eq) => { if (onTrade) { try { onTrade(bot, tr, eq); } catch {} } };
  function buy(bot, sym, usd, price, reason) {
    const eqBefore = roughEquity(bot);
    const fakeP = { cash: bot.cash, positions: bot.positions, trades: [] };
    const openedAt = bot.positions[sym]?.openedAt;
    const t = paper.buy(fakeP, { pair: sym, usd: Math.min(usd, bot.cash), price, feePct: feeFor(sym), maxPositionPct: 100 });
    bot.cash = fakeP.cash; bot.positions[sym].openedAt = openedAt ?? now();
    const tr = { id: t.id, t: now(), side: 'buy', sym, kind: market.kind(sym), qty: t.qty, price, usd: round(t.usd), fee: round(t.fee, 4), reason };
    bot.trades.push(tr); notify(bot, tr, eqBefore); return tr;
  }
  function sell(bot, sym, price, reason) {
    const pos = bot.positions[sym]; const openedAt = pos.openedAt, avg = pos.avg;
    const fakeP = { cash: bot.cash, positions: bot.positions, trades: [] };
    const t = paper.sell(fakeP, { pair: sym, qty: 'all', price, feePct: feeFor(sym) });
    bot.cash = fakeP.cash;
    const pnlPct = round((price / avg - 1) * 100 - feeFor(sym) * 2, 2);
    const tr = { id: t.id, t: now(), side: 'sell', sym, kind: market.kind(sym), qty: t.qty, price, usd: round(t.usd), fee: round(t.fee, 4), pnl: round(t.pnl), pnlPct, reason, holdMins: openedAt ? round((now() - openedAt) / 60000, 0) : null };
    bot.trades.push(tr); if (bot.trades.length > 1500) bot.trades.splice(0, bot.trades.length - 1500);
    bot.cooldown[sym] = now();
    lesson(bot, `${bot.emoji} ${bot.name} ${tr.pnl >= 0 ? 'won' : 'lost'} ${tr.pnlPct >= 0 ? '+' : ''}${tr.pnlPct}% on ${sym} (${reason}, held ${dur(tr.holdMins || 0)})`);
    notify(bot, tr, roughEquity(bot));
    return tr;
  }

  // --- rule-based decisions ---
  function ruleTick(bot, data) {
    const g = bot.genome; const acted = [];
    for (const [sym, pos] of Object.entries(bot.positions)) {
      const d = data.symbols[sym]; if (!d || !d.price) continue;
      if (d.kind === 'stock' && !data.stockOpen) continue;
      const ret = (d.price / pos.avg - 1) * 100, heldH = (now() - (pos.openedAt || now())) / 3600000;
      const ind = d.candles ? indicators(d.candles, g.lookback) : null;
      let why = null;
      if (ret >= g.takeProfitPct) why = 'take-profit';
      else if (ret <= -g.stopLossPct) why = 'stop-loss';
      else if (heldH >= g.maxHoldHours) why = 'time limit';
      else if (ind && bot.style === 'momentum' && ind.mom < -g.entryPct && ret < 0) why = 'momentum reversed';
      else if (ind && bot.style === 'contrarian' && ind.dev >= 0 && ret > feeFor(sym) * 2 + 0.2) why = 'bounced back above average';
      else if (ind && bot.style === 'trend' && ind.trend < 0) why = 'trend flipped';
      if (why) acted.push(sell(bot, sym, d.price, why));
    }
    const eq = botEquity(bot, data.prices, data.markets);
    const cands = [];
    for (const [sym, d] of Object.entries(data.symbols)) {
      if (bot.positions[sym] || !d.price || !d.candles) continue;
      if (d.kind === 'stock' && !data.stockOpen) continue;
      if (now() - (bot.cooldown[sym] || 0) < 30 * 60000) continue;
      const ind = indicators(d.candles, g.lookback); if (!ind) continue;
      let strength = null, why = '';
      if (bot.style === 'momentum' && ind.mom > g.entryPct) { strength = ind.mom; why = `up ${round(ind.mom)}% in ${g.lookback * 5}m`; }
      if (bot.style === 'contrarian' && ind.dev < -g.entryPct) { strength = -ind.dev; why = `${round(-ind.dev)}% below its ${g.lookback * 5}m average`; }
      if (bot.style === 'trend' && ind.trend > g.entryPct / 3 && ind.mom > 0) { strength = ind.trend; why = `uptrend: short avg ${round(ind.trend)}% over long avg`; }
      if (strength != null) cands.push({ sym, price: d.price, strength, why });
    }
    cands.sort((a, b) => b.strength - a.strength);
    for (const c of cands) {
      if (Object.keys(bot.positions).length >= g.maxPositions) break;
      const usd = Math.min(bot.cash, eq * g.sizePct / 100);
      if (usd < 5) break;
      acted.push(buy(bot, c.sym, usd, c.price, c.why));
    }
    // Polymarket: at most one new bet per tick
    if (data.pmMarkets.length && bot.bets.filter(b => b.status === 'open').length < MAX_OPEN_BETS) {
      const held = new Set(bot.bets.filter(b => b.status === 'open').map(b => b.marketId));
      const soon = data.pmMarkets.filter(m => !held.has(m.id) && m.end && m.end - now() > 20 * 60000 && m.end - now() < 7 * 864e5 && (m.liquidity >= 1000 || m.volume24h >= 5000));
      let pick = null;
      for (const m of soon) {
        m.prices.forEach((p, i) => {
          if (p < g.pmMinPrice || p > g.pmMaxPrice) return;
          let score = null;
          if (bot.style === 'momentum') score = p; // strongest favorite in band
          if (bot.style === 'contrarian') score = 1 - p; // cheapest underdog in band
          if (bot.style === 'trend' && m.change24h != null && m.outcomes.length === 2) { const ch = i === 0 ? m.change24h : -m.change24h; if (ch > 0.02) score = ch; }
          if (score != null && (!pick || score > pick.score)) pick = { m, i, score };
        });
      }
      if (pick) {
        const usd = round(Math.min(bot.cash, eq * g.pmSizePct / 100));
        if (usd >= 1) {
          const why = bot.style === 'momentum' ? 'strong favorite' : bot.style === 'contrarian' ? 'cheap underdog' : `odds rising ${round(pick.score * 100, 0)}¢ in 24h`;
          const b = pm.placeBet(bot, { market: pick.m, outcome: pick.i, usd, by: bot.id, reason: why, time: now() });
          acted.push({ bet: b });
          lesson(bot, `${bot.emoji} ${bot.name} bet $${usd} on "${b.outcome}" at ${Math.round(b.price * 100)}¢: ${pick.m.question} (${why})`, 'bet');
        }
      }
    }
    return acted;
  }

  // --- AI bot ---
  async function aiTick(bot, data, board) {
    if (!ask) { bot.ai = { status: 'Needs a Groq key (add one in Rutherford Settings)', at: now() }; return []; }
    const eq = botEquity(bot, data.prices, data.markets);
    const rows = Object.entries(data.symbols).filter(([, d]) => d.price).map(([sym, d]) => {
      const ind = d.candles ? indicators(d.candles, 12) : null;
      return `${sym} (${d.kind}) $${d.price}` + (ind ? ` | 1h ${round(ind.mom1h)}% | vs 1h avg ${round(ind.dev)}% | trend ${round(ind.trend)}%` : '') + (d.change24h != null ? ` | 24h ${round(d.change24h)}%` : '');
    });
    const pos = Object.entries(bot.positions).map(([s, p]) => `${s}: ${p.qty} @ $${round(p.avg, 4)} (now ${data.prices[s] ? round((data.prices[s] / p.avg - 1) * 100) + '%' : '?'}, held ${dur((now() - (p.openedAt || now())) / 60000)})`);
    const bets = bot.bets.filter(b => b.status === 'open').map(b => `"${b.question}" ${b.outcome} @${Math.round(b.price * 100)}¢ $${round(b.cost)}`);
    const mk = data.pmMarkets.filter(m => m.end && m.end - now() > 20 * 60000 && m.end - now() < 7 * 864e5).slice(0, 10).map(m => `id ${m.id}: ${m.question} | ${m.outcomes.map((o, i) => `${o} ${Math.round(m.prices[i] * 100)}¢`).join(' / ')} | ends in ${dur((m.end - now()) / 60000)}` + (() => { const pk = picks?.(m.id); return pk ? ` | Rutherford's researched pick: ${pk.pick} ${Math.round(pk.probs[pk.pickIndex] * 100)}% (${pk.confidence})` : ''; })());
    const lessons = arena.lessons.slice(-14).map(l => '- ' + l.text);
    const content = [
      `Time: ${new Date(now()).toUTCString()}. Stock market is ${data.stockOpen ? 'OPEN' : 'CLOSED (no stock trades)'}. Fees: crypto ${settings().feePct}% per trade, stocks ${settings().stockFeePct}%.`,
      `YOUR ACCOUNT: equity $${round(eq)}, cash $${round(bot.cash)}, return ${round((eq / bot.startCash - 1) * 100)}%.`,
      `Positions: ${pos.join('; ') || 'none'}`, `Open bets: ${bets.join('; ') || 'none'}`,
      `MARKETS:\n${rows.join('\n')}`, mk.length ? `POLYMARKET (paper bets, pay $1/share if right):\n${mk.join('\n')}` : '',
      `LEADERBOARD:\n${board.map(b => `${b.name} (${b.style}): ${b.stats.returnPct}% return, win rate ${b.stats.winRate ?? '-'}% over ${b.stats.closed}, max drawdown ${b.stats.maxDrawdownPct}%`).join('\n')}`,
      `RECENT LESSONS (from all bots):\n${lessons.join('\n') || '- none yet'}`
    ].filter(Boolean).join('\n\n');
    const system = `You are Nucleus, an AI trading bot in a PAPER-money competition against three rule bots (Proton momentum, Electron contrarian, Neutron trend). Goal: grow your account while avoiding big drawdowns. Study what is working for the other bots and the lessons, and adapt. Be selective: doing nothing is often right; fees eat small moves.
Reply with ONLY a JSON object: {"thoughts": "1-2 sentences on your read and what you learned", "actions": [ ... ]}
Actions (max 4):
{"type":"buy","symbol":"BTC-USD","pct":10,"reason":"..."}  (pct = % of your equity, max ${GENOMES.nucleus.sizePct}; only listed symbols; stocks only when market is open)
{"type":"sell","symbol":"BTC-USD","reason":"..."}  (sells the whole position)
{"type":"bet","marketId":"123","outcome":"Yes","pct":3,"reason":"..."}  (Polymarket, max ${GENOMES.nucleus.pmSizePct}% each, max ${MAX_OPEN_BETS} open)
Use "actions": [] to hold.`;
    let reply;
    try { reply = await ask([{ role: 'system', content: system }, { role: 'user', content }]); }
    catch (e) { bot.ai = { status: 'AI error: ' + e.message, at: now() }; return []; }
    let plan;
    try { plan = JSON.parse(String(reply).replace(/^```(json)?|```$/g, '').trim()); } catch { bot.ai = { status: 'AI reply was not valid JSON; skipped this round', at: now() }; return []; }
    const acted = [], notes = [];
    for (const a of (Array.isArray(plan.actions) ? plan.actions : []).slice(0, 4)) {
      try {
        const reason = String(a.reason || 'AI decision').slice(0, 160);
        if (a.type === 'buy') {
          const sym = String(a.symbol || '').toUpperCase(), d = data.symbols[sym];
          if (!d?.price) throw Error('unknown symbol ' + sym);
          if (d.kind === 'stock' && !data.stockOpen) throw Error('stock market closed');
          if (Object.keys(bot.positions).length >= GENOMES.nucleus.maxPositions && !bot.positions[sym]) throw Error('max positions');
          const pct = Math.min(GENOMES.nucleus.sizePct, Math.max(1, Number(a.pct) || 5));
          const usd = Math.min(bot.cash, eq * pct / 100); if (usd < 5) throw Error('not enough cash');
          acted.push(buy(bot, sym, usd, d.price, reason));
        } else if (a.type === 'sell') {
          const sym = String(a.symbol || '').toUpperCase(), d = data.symbols[sym];
          if (!bot.positions[sym]) throw Error('no position in ' + sym);
          if (!d?.price) throw Error('no price for ' + sym);
          if (d.kind === 'stock' && !data.stockOpen) throw Error('stock market closed');
          acted.push(sell(bot, sym, d.price, reason));
        } else if (a.type === 'bet') {
          if (bot.bets.filter(b => b.status === 'open').length >= MAX_OPEN_BETS) throw Error('max open bets');
          const m = data.pmMarkets.find(x => x.id === String(a.marketId)); if (!m) throw Error('unknown market');
          const pct = Math.min(GENOMES.nucleus.pmSizePct, Math.max(1, Number(a.pct) || 2));
          const b = pm.placeBet(bot, { market: m, outcome: a.outcome, usd: round(Math.min(bot.cash, eq * pct / 100)), by: bot.id, reason, time: now() });
          acted.push({ bet: b }); lesson(bot, `${bot.emoji} ${bot.name} bet $${round(b.cost)} on "${b.outcome}" at ${Math.round(b.price * 100)}¢: ${m.question}`, 'bet');
        }
      } catch (e) { notes.push(`${a.type} skipped: ${e.message}`); }
    }
    const thoughts = String(plan.thoughts || '').slice(0, 400);
    bot.ai = { status: 'ok', thoughts, at: now(), skipped: notes };
    if (thoughts) lesson(bot, `🧠 Nucleus thinks: ${thoughts}`, 'ai');
    return acted;
  }

  // --- learning: the weakest rule bot copies part of the leader's settings ---
  function evolve(data, { force = false } = {}) {
    const ruleBots = arena.bots.filter(b => b.style !== 'ai');
    const scored = ruleBots.map(b => {
      const eq = botEquity(b, data.prices, data.markets), mark = arena.evolveMarks[b.id] ?? b.startCash;
      const s = stats(b, data.prices, data.markets);
      return { b, windowRet: (eq / mark - 1) * 100, score: (eq / mark - 1) * 100 - 0.5 * s.maxDrawdownPct, closed: s.closed };
    }).sort((x, y) => y.score - x.score);
    const best = scored[0], worst = scored.at(-1);
    arena.lastEvolve = now();
    for (const s of scored) arena.evolveMarks[s.b.id] = botEquity(s.b, data.prices, data.markets);
    if (!force && (best.closed + worst.closed < 3 || best.score - worst.score < 0.5)) {
      lesson(null, '🧬 Learning review: no clear leader yet, so no bot changed its settings.', 'evolve');
      return null;
    }
    const changes = [];
    for (const k of Object.keys(LIMITS)) {
      if (!(k in worst.b.genome) || !(k in best.b.genome)) continue;
      const before = worst.b.genome[k];
      let v = before + 0.5 * (best.b.genome[k] - before);
      v *= 1 + (rand() - 0.5) * 0.2; // small mutation so they don't become clones
      v = clampGene(k, v);
      if (v !== before) { worst.b.genome[k] = v; changes.push(`${GENE_NAMES[k]} ${fmtGene(k, before)}→${fmtGene(k, v)}`); }
    }
    if (worst.b.genome.pmMaxPrice - worst.b.genome.pmMinPrice < 0.1) worst.b.genome.pmMaxPrice = clampGene('pmMaxPrice', worst.b.genome.pmMinPrice + 0.1);
    worst.b.generation++; worst.b.learnedFrom = best.b.id;
    const text = `🧬 ${worst.b.name} learned from ${best.b.name} (${round(best.windowRet)}% vs ${round(worst.windowRet)}% since last review): ${changes.slice(0, 5).join(', ') || 'settings nudged'}`;
    lesson(worst.b, text, 'evolve');
    return { learner: worst.b.id, teacher: best.b.id, changes };
  }

  // --- gather data once per tick, shared by all bots ---
  async function gather() {
    const s = settings();
    const syms = [...new Set(s.watchlist)];
    const symbols = {}, prices = {};
    let stockOpen = false;
    try { stockOpen = (await market.stockClock()).open; } catch {}
    await Promise.all(syms.map(async sym => {
      try {
        const [q, c] = await Promise.all([market.quote(sym), market.candles(sym, 300).catch(() => null)]);
        symbols[sym] = { kind: market.kind(sym), price: q.price, change24h: q.change24h, candles: c };
        prices[sym] = q.price;
      } catch { symbols[sym] = { kind: market.kind(sym), price: null }; }
    }));
    // keep prices for anything held even if removed from the watchlist
    for (const b of arena.bots) for (const sym of Object.keys(b.positions)) if (!prices[sym]) { try { const q = await market.quote(sym); prices[sym] = q.price; symbols[sym] ||= { kind: market.kind(sym), price: q.price }; } catch {} }
    let pmMarkets = [];
    if (s.botsUsePolymarket !== false && poly) {
      for (const cat of ['quick', 'sports', 'trending']) { try { pmMarkets.push(...await poly.listMarkets({ category: cat })); } catch {} }
      const seen = new Set(); pmMarkets = pmMarkets.filter(m => !seen.has(m.id) && seen.add(m.id));
    }
    const markets = {};
    for (const m of pmMarkets) markets[m.id] = m;
    const openIds = [...new Set(arena.bots.flatMap(b => b.bets.filter(x => x.status === 'open').map(x => x.marketId)))];
    for (const id of openIds) if (!markets[id] || markets[id].end < now()) { try { markets[id] = await poly.market(id); } catch {} }
    return { symbols, prices, stockOpen, pmMarkets, markets };
  }

  async function tick({ force = false } = {}) {
    if (busy) return busy;
    const s = settings();
    if (!force && (!s.arenaOn || now() - arena.lastTick < s.botEveryMin * 60000 - 5000)) return { skipped: true };
    busy = (async () => {
      const data = await gather();
      arena.lastTick = now();
      if (!arena.benchmark && data.prices['BTC-USD']) arena.benchmark = { sym: 'BTC-USD', start: data.prices['BTC-USD'], at: now() };
      // settle finished prediction bets
      for (const bot of arena.bots) for (const b of pm.settleBets(bot, data.markets)) lesson(bot, `${bot.emoji} ${bot.name} ${b.status === 'won' ? 'WON' : b.status === 'void' ? 'got refunded' : 'lost'} $${round(Math.abs(b.pnl))} on "${b.outcome}": ${b.question}`, 'bet');
      const log = {};
      const board = arena.bots.map(b => ({ name: b.name, style: b.style, stats: stats(b, data.prices, data.markets) }));
      for (const bot of arena.bots) {
        if (bot.style === 'ai') {
          if (force || now() - arena.lastAi >= s.aiEveryMin * 60000 - 5000) { arena.lastAi = now(); log[bot.id] = await aiTick(bot, data, board); }
        } else log[bot.id] = ruleTick(bot, data);
      }
      for (const bot of arena.bots) {
        bot.equity.push([now(), round(botEquity(bot, data.prices, data.markets))]);
        if (bot.equity.length > 4000) bot.equity = bot.equity.filter((_, i) => i % 2 === 0 || i > 2000);
      }
      let evolved = null;
      if (now() - arena.lastEvolve >= s.evolveHours * 3600000) evolved = evolve(data);
      arena.lastData = { prices: data.prices, stockOpen: data.stockOpen, at: now(), markets: Object.fromEntries(Object.entries(data.markets).filter(([id]) => arena.bots.some(b => b.bets.some(x => x.marketId === id && x.status === 'open')))) };
      persist();
      return { ok: true, actions: Object.fromEntries(Object.entries(log).map(([k, v]) => [k, v.length])), evolved };
    })();
    try { return await busy; } finally { busy = null; }
  }

  function view() {
    const d = arena.lastData || { prices: {}, markets: {} };
    const s = settings();
    const thin = (pts, n = 300) => { if (pts.length <= n) return pts; const step = pts.length / n; return Array.from({ length: n }, (_, i) => pts[Math.floor(i * step)]).concat([pts.at(-1)]); };
    const bots = arena.bots.map(b => ({
      id: b.id, name: b.name, emoji: b.emoji, color: b.color, style: b.style, about: b.about, generation: b.generation, learnedFrom: b.learnedFrom,
      genome: b.genome, ai: b.ai, stats: stats(b, d.prices, d.markets), equity: thin(b.equity),
      positions: Object.entries(b.positions).map(([sym, p]) => ({ sym, qty: p.qty, avg: p.avg, price: d.prices[sym] ?? null, pnlPct: d.prices[sym] ? round((d.prices[sym] / p.avg - 1) * 100) : null, openedAt: p.openedAt })),
      bets: b.bets.filter(x => x.status === 'open').map(x => ({ ...x, nowPrice: d.markets[x.marketId]?.prices?.[x.outcomeIndex] ?? null })),
      recent: [...b.trades.slice(-15), ...b.bets.filter(x => x.status !== 'open').slice(-8).map(x => ({ t: Date.parse(x.settledAt), side: 'bet', sym: x.question, pnl: round(x.pnl), reason: x.status, outcome: x.outcome }))].sort((x, y) => y.t - x.t).slice(0, 15)
    })).sort((a, b) => b.stats.returnPct - a.stats.returnPct);
    const bench = arena.benchmark && d.prices[arena.benchmark.sym] ? { ...arena.benchmark, returnPct: round((d.prices[arena.benchmark.sym] / arena.benchmark.start - 1) * 100) } : null;
    return { startedAt: arena.startedAt, lastTick: arena.lastTick, nextTick: s.arenaOn ? arena.lastTick + s.botEveryMin * 60000 : null, lastEvolve: arena.lastEvolve, nextEvolve: arena.lastEvolve + s.evolveHours * 3600000, stockOpen: !!d.stockOpen, bots, benchmark: bench, lessons: arena.lessons.slice(-80).reverse(), running: !!busy };
  }

  function botDetail(id) {
    const b = arena.bots.find(x => x.id === id); if (!b) throw Error('No such bot');
    return { id: b.id, name: b.name, trades: [...b.trades].reverse(), bets: [...b.bets].reverse(), genome: b.genome, defaults: GENOMES[b.id], generation: b.generation, learnedFrom: b.learnedFrom };
  }

  function reset(cash = settings().botStartCash) { arena = freshArena(cash, now()); persist(); return view(); }
  async function forceEvolve() { const data = await gather(); const r = evolve(data, { force: true }); persist(); return r; }

  return { tick, view, botDetail, reset, forceEvolve, get arena() { return arena; } };
}

module.exports = { create, BOTS, GENOMES, LIMITS, indicators, stats, freshArena };

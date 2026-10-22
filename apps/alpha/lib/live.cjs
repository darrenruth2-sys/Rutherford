'use strict';
// REAL MONEY: copies one bot's crypto/stock trades to your Alpaca account.
// Safety rules, all enforced here (not in the UI):
//  - Off by default. Real-money ("live") mode needs its own keys + a typed confirmation.
//  - Budget, per-trade cap, daily loss limit (auto shut-off), max orders per day.
//  - "Ask me first" mode by default: every order waits for you to tap Approve (expires after 10 min).
//  - Only sells what Rutherford itself bought (never touches your other holdings).
//  - Every order has a unique client_order_id; a timed-out order is looked up, NEVER resent.
//  - Kill switch: turns everything off and cancels Rutherford's open orders.
//  - Polymarket is never traded with real money (not allowed for Ohio residents).
const crypto = require('node:crypto');

const BASE = { paper: 'https://paper-api.alpaca.markets', live: 'https://api.alpaca.markets' };
const CONFIRM_PHRASE = 'I understand I can lose real money';
const DEFAULTS = {
  enabled: false, target: 'paper', mode: 'approve', botId: 'nucleus',
  budgetUsd: 100, maxPerTradeUsd: 25, dailyLossLimitUsd: 25, maxOrdersPerDay: 10,
  allowCrypto: true, allowStocks: true, avoidDayTrades: true,
  liveConfirmedAt: null, haltedReason: null,
  ledger: {}, proposals: [], day: null, ordersToday: 0
};
const OPEN_STATUSES = new Set(['new', 'accepted', 'pending_new', 'partially_filled', 'accepted_for_bidding', 'calculated', 'held', 'pending_replace']);
const DONE_BAD = new Set(['canceled', 'expired', 'rejected', 'suspended', 'stopped', 'done_for_day', 'replaced']);
const round2 = x => Math.round(x * 100) / 100;
const nyDay = t => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(t));
const alpacaSym = (sym, kind) => (kind === 'crypto' ? sym.replace('-', '/') : sym);
const posKey = s => s.replace(/[-/]/g, '');

function create({ load, save, keys, fetchImpl = fetch, now = () => Date.now(), market, botView, log = () => {} }) {
  let st = { ...structuredClone(DEFAULTS), ...(load() || {}) };
  let busy = Promise.resolve();
  const persist = () => save(st);
  const serial = fn => (busy = busy.then(fn, fn)); // one order at a time, in order

  function creds() {
    const k = keys();
    const pair = st.target === 'live' ? { id: k.liveId, secret: k.liveSecret } : { id: k.paperId, secret: k.paperSecret };
    if (!pair.id || !pair.secret) throw Error(st.target === 'live' ? 'Add your Alpaca LIVE keys first' : 'Add your Alpaca paper keys first (Alpha Settings)');
    return pair;
  }
  async function call(method, path, body) {
    const c = creds();
    let res;
    try {
      res = await fetchImpl(BASE[st.target] + path, { method, headers: { 'APCA-API-KEY-ID': c.id, 'APCA-API-SECRET-KEY': c.secret, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
    } catch (e) { const err = Error('Could not reach Alpaca'); err.network = true; throw err; }
    let data = null; try { data = await res.json(); } catch {}
    if (!res.ok) { const err = Error(data?.message || `Alpaca error (HTTP ${res.status})`); err.status = res.status; throw err; }
    return data;
  }
  const account = () => call('GET', '/v2/account');

  function rollDay() { const d = nyDay(now()); if (st.day !== d) { st.day = d; st.ordersToday = 0; } }
  const deployed = () => Object.values(st.ledger).reduce((a, p) => a + p.cost, 0);

  // ---- proposals come from the mirrored bot ----
  function onBotTrade(bot, tr, botEquityBefore) {
    if (!st.enabled || bot.id !== st.botId) return null;
    if (tr.kind === 'crypto' && !st.allowCrypto) return null;
    if (tr.kind === 'stock' && !st.allowStocks) return null;
    rollDay();
    let p;
    if (tr.side === 'buy') {
      const frac = botEquityBefore > 0 ? tr.usd / botEquityBefore : 0;
      const usd = round2(Math.min(frac * st.budgetUsd, st.maxPerTradeUsd, st.budgetUsd - deployed()));
      if (usd < 1) return addProposal({ side: 'buy', sym: tr.sym, kind: tr.kind, usd: 0, reason: tr.reason, status: 'blocked', error: 'Budget is fully used' });
      p = { side: 'buy', sym: tr.sym, kind: tr.kind, usd, reason: tr.reason };
    } else {
      if (!st.ledger[tr.sym]) return null; // Rutherford never bought it with real money
      p = { side: 'sell', sym: tr.sym, kind: tr.kind, reason: tr.reason };
    }
    const prop = addProposal({ ...p, status: st.mode === 'auto' ? 'approved' : 'waiting' });
    if (st.mode === 'auto') serial(() => execute(prop.id)).catch(() => {});
    return prop;
  }
  function addProposal(p) {
    const prop = { id: crypto.randomUUID(), t: now(), botId: st.botId, target: st.target, clientOrderId: null, ...p };
    st.proposals.unshift(prop); st.proposals = st.proposals.slice(0, 300);
    persist(); return prop;
  }

  // ---- the one place an order is sent ----
  async function execute(id) {
    const p = st.proposals.find(x => x.id === id);
    if (!p) throw Error('Order not found');
    if (!['waiting', 'approved'].includes(p.status)) throw Error('That order was already ' + p.status);
    const block = msg => { p.status = 'blocked'; p.error = msg; persist(); return p; };
    if (!st.enabled) return block('Real trading is turned off');
    if (st.haltedReason) return block(st.haltedReason);
    if (now() - p.t > 10 * 60000) { p.status = 'expired'; p.error = 'Prices moved on; approvals expire after 10 minutes'; persist(); return p; }
    if (st.target === 'live' && !st.liveConfirmedAt) return block('Real-money mode was not confirmed');
    rollDay();
    if (st.ordersToday >= st.maxOrdersPerDay) return block(`Daily order limit reached (${st.maxOrdersPerDay})`);
    let acct;
    try { acct = await account(); } catch (e) { return block(e.message); }
    if (acct.status && acct.status !== 'ACTIVE') return block('Alpaca account is not active (' + acct.status + ')');
    if (acct.trading_blocked || acct.account_blocked) return block('Alpaca says trading is blocked on this account');
    const dayPnl = Number(acct.equity) - Number(acct.last_equity);
    if (isFinite(dayPnl) && dayPnl <= -st.dailyLossLimitUsd) { halt(`Daily loss limit hit (${round2(dayPnl)} today). Real trading switched off.`); return block(st.haltedReason); }
    if (p.kind === 'crypto' && acct.crypto_status && acct.crypto_status !== 'ACTIVE') return block('Crypto trading is not enabled on your Alpaca account');
    if (p.kind === 'stock') { try { if (!(await market.stockClock()).open) return block('Stock market is closed'); } catch {} }

    const tif = p.kind === 'crypto' ? 'gtc' : 'day';
    let body;
    if (p.side === 'buy') {
      if (!(p.usd >= 1)) return block('Order too small');
      if (p.usd > st.maxPerTradeUsd + 1e-9) return block(`Over the per-trade cap ($${st.maxPerTradeUsd})`);
      if (deployed() + p.usd > st.budgetUsd + 1e-9) return block(`Over your budget ($${st.budgetUsd})`);
      if (Number(acct.cash ?? acct.buying_power) < p.usd) return block('Not enough cash in the Alpaca account');
      body = { symbol: alpacaSym(p.sym, p.kind), notional: p.usd.toFixed(2), side: 'buy', type: 'market', time_in_force: tif };
    } else {
      const led = st.ledger[p.sym]; if (!led) return block('Rutherford does not hold this with real money');
      if (p.kind === 'stock' && st.avoidDayTrades && nyDay(led.openedAt) === nyDay(now())) { led.sellAfterToday = p.reason || 'bot sold'; p.status = 'deferred'; p.error = 'Bought today, so it will sell next trading day (avoids day-trade limits)'; persist(); return p; }
      let qty = led.qty;
      try { const pos = (await call('GET', '/v2/positions')).find(x => posKey(x.symbol) === posKey(p.sym)); qty = Math.min(qty, Number(pos?.qty || 0)); } catch {}
      if (!(qty > 0)) { delete st.ledger[p.sym]; return block('No position left at Alpaca'); }
      body = { symbol: alpacaSym(p.sym, p.kind), qty: String(Math.floor(qty * 1e9) / 1e9), side: 'sell', type: 'market', time_in_force: tif };
    }
    p.clientOrderId = 'rf-' + p.id.slice(0, 30);
    body.client_order_id = p.clientOrderId;
    p.status = 'sending'; st.ordersToday++; persist();
    try {
      const o = await call('POST', '/v2/orders', body);
      p.orderId = o.id; p.status = 'sent'; p.orderStatus = o.status;
    } catch (e) {
      if (e.network) { p.status = 'unknown'; p.error = 'No reply from Alpaca. Rutherford will look the order up (it will NOT resend it).'; }
      else { p.status = 'failed'; p.error = e.message; st.ordersToday--; }
      persist(); return p;
    }
    persist();
    for (let i = 0; i < 3 && p.status === 'sent'; i++) { await new Promise(r => setTimeout(r, i ? 1500 : 400)); await refresh(p); }
    log(p);
    return p;
  }

  async function refresh(p) {
    let o;
    try { o = p.orderId ? await call('GET', '/v2/orders/' + p.orderId) : await call('GET', '/v2/orders:by_client_order_id?client_order_id=' + encodeURIComponent(p.clientOrderId)); }
    catch (e) { if (e.status === 404 && p.status === 'unknown' && now() - p.t > 5 * 60000) { p.status = 'failed'; p.error = 'Alpaca never received this order'; persist(); } return p; }
    p.orderId = o.id; p.orderStatus = o.status;
    if (o.status === 'filled') {
      const q = Number(o.filled_qty), px = Number(o.filled_avg_price);
      p.status = 'filled'; p.fill = { qty: q, price: px, usd: round2(q * px), at: o.filled_at };
      if (p.side === 'buy') { const l = st.ledger[p.sym] || { qty: 0, cost: 0, openedAt: now(), kind: p.kind }; l.qty += q; l.cost = round2(l.cost + q * px); st.ledger[p.sym] = l; }
      else { const l = st.ledger[p.sym]; if (l) { const avg = l.cost / l.qty; p.fill.pnl = round2(q * (px - avg)); l.qty -= q; l.cost = round2(l.cost - q * avg); if (l.qty <= 1e-9 || l.cost < 0.01) delete st.ledger[p.sym]; } }
    } else if (DONE_BAD.has(o.status)) { p.status = 'failed'; p.error = 'Order ' + o.status; }
    else if (!OPEN_STATUSES.has(o.status)) p.status = 'sent';
    persist(); return p;
  }

  // Called every heartbeat
  async function tick() {
    for (const p of st.proposals) if (p.status === 'waiting' && now() - p.t > 10 * 60000) { p.status = 'expired'; p.error = 'Not approved within 10 minutes'; }
    for (const p of st.proposals.filter(x => ['sent', 'unknown', 'sending'].includes(x.status) && (x.orderId || x.clientOrderId)).slice(0, 10)) await refresh(p).catch(() => {});
    // deferred stock sells
    if (st.enabled && !st.haltedReason) for (const [sym, l] of Object.entries(st.ledger)) {
      if (l.sellAfterToday && nyDay(l.openedAt) !== nyDay(now())) {
        delete l.sellAfterToday;
        const prop = addProposal({ side: 'sell', sym, kind: l.kind, reason: 'deferred sell from yesterday', status: st.mode === 'auto' ? 'approved' : 'waiting' });
        if (st.mode === 'auto') await serial(() => execute(prop.id)).catch(() => {});
      }
    }
    // daily loss guard even when idle
    if (st.enabled && !st.haltedReason && Object.keys(st.ledger).length) {
      try { const a = await account(); const pnl = Number(a.equity) - Number(a.last_equity); if (pnl <= -st.dailyLossLimitUsd) halt(`Daily loss limit hit (${round2(pnl)} today). Real trading switched off.`); } catch {}
    }
    persist();
  }

  function halt(reason) { st.enabled = false; st.haltedReason = reason; persist(); }

  async function killSwitch() {
    st.enabled = false; st.haltedReason = 'Stopped with the kill switch';
    for (const p of st.proposals) if (p.status === 'waiting' || p.status === 'approved') { p.status = 'skipped'; p.error = 'Kill switch'; }
    const cancelled = [];
    for (const p of st.proposals.filter(x => ['sent', 'unknown'].includes(x.status) && x.orderId)) { try { await call('DELETE', '/v2/orders/' + p.orderId); p.status = 'failed'; p.error = 'Canceled by kill switch'; cancelled.push(p.orderId); } catch {} }
    persist(); return { stopped: true, cancelled };
  }

  // Sell everything Rutherford bought (asks per-order rules except the "enabled" check)
  async function closeAll() {
    const out = [];
    for (const [sym, l] of Object.entries(st.ledger)) {
      const prop = addProposal({ side: 'sell', sym, kind: l.kind, reason: 'You closed all Rutherford positions', status: 'approved' });
      const wasOn = st.enabled, wasHalt = st.haltedReason; st.enabled = true; st.haltedReason = null;
      try { out.push(await serial(() => execute(prop.id))); } finally { st.enabled = wasOn; st.haltedReason = wasHalt; persist(); }
    }
    return out;
  }

  function configure(b) {
    const n = (v, lo, hi, name) => { v = Number(v); if (!(v >= lo && v <= hi)) throw Error(`${name} must be ${lo}–${hi}`); return round2(v); };
    if (b.target !== undefined) { if (!['paper', 'live'].includes(b.target)) throw Error('Bad target'); if (b.target !== st.target) { if (Object.keys(st.ledger).length) throw Error('Sell Rutherford’s current positions before switching accounts'); st.target = b.target; st.enabled = false; st.liveConfirmedAt = null; } }
    if (b.mode !== undefined) { if (!['approve', 'auto'].includes(b.mode)) throw Error('Bad mode'); st.mode = b.mode; }
    if (b.botId !== undefined) st.botId = String(b.botId);
    if (b.budgetUsd !== undefined) st.budgetUsd = n(b.budgetUsd, 5, 1_000_000, 'Budget');
    if (b.maxPerTradeUsd !== undefined) st.maxPerTradeUsd = n(b.maxPerTradeUsd, 1, 1_000_000, 'Max per trade');
    if (b.dailyLossLimitUsd !== undefined) st.dailyLossLimitUsd = n(b.dailyLossLimitUsd, 1, 1_000_000, 'Daily loss limit');
    if (b.maxOrdersPerDay !== undefined) st.maxOrdersPerDay = Math.round(n(b.maxOrdersPerDay, 1, 200, 'Orders per day'));
    for (const k of ['allowCrypto', 'allowStocks', 'avoidDayTrades']) if (b[k] !== undefined) st[k] = !!b[k];
    if (st.maxPerTradeUsd > st.budgetUsd) st.maxPerTradeUsd = st.budgetUsd;
    persist(); return publicState();
  }

  async function turnOn({ confirm } = {}) {
    creds();
    if (st.target === 'live') {
      if (String(confirm || '').trim().toLowerCase() !== CONFIRM_PHRASE.toLowerCase()) throw Error(`Type exactly: ${CONFIRM_PHRASE}`);
      st.liveConfirmedAt = now();
    }
    const a = await account(); // proves the keys work
    if (a.trading_blocked || a.account_blocked) throw Error('Alpaca says trading is blocked on this account');
    st.enabled = true; st.haltedReason = null; persist();
    return publicState();
  }
  function turnOff() { st.enabled = false; persist(); return publicState(); }
  async function approve(id) { const p = st.proposals.find(x => x.id === id); if (!p) throw Error('Not found'); if (p.status !== 'waiting') throw Error('Already ' + p.status); p.status = 'approved'; persist(); return serial(() => execute(id)); }
  function skip(id) { const p = st.proposals.find(x => x.id === id); if (!p || p.status !== 'waiting') throw Error('Nothing to skip'); p.status = 'skipped'; persist(); return p; }

  function publicState() { const { ledger, proposals, ...rest } = st; return { ...rest, confirmPhrase: CONFIRM_PHRASE, deployed: round2(deployed()) }; }
  async function view() {
    let acct = null, err = null;
    try { const a = await account(); acct = { equity: Number(a.equity), cash: Number(a.cash), buyingPower: Number(a.buying_power), todayPnl: round2(Number(a.equity) - Number(a.last_equity)), cryptoStatus: a.crypto_status || null, status: a.status, number: a.account_number ? '••' + String(a.account_number).slice(-4) : '' }; }
    catch (e) { err = e.message; }
    const holdings = [];
    for (const [sym, l] of Object.entries(st.ledger)) { let price = null; try { price = (await market.quote(sym)).price; } catch {} holdings.push({ sym, kind: l.kind, qty: l.qty, cost: l.cost, price, value: price ? round2(l.qty * price) : null, pnl: price ? round2(l.qty * price - l.cost) : null, openedAt: l.openedAt, sellAfterToday: !!l.sellAfterToday }); }
    return { state: publicState(), account: acct, accountError: err, holdings, proposals: st.proposals.slice(0, 60), bot: botView(st.botId) };
  }

  return { onBotTrade, execute: id => serial(() => execute(id)), approve, skip, tick, killSwitch, closeAll, configure, turnOn, turnOff, view, publicState, get state() { return st; } };
}

module.exports = { create, CONFIRM_PHRASE, DEFAULTS };

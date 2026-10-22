'use strict';
// A fake Alpaca brokerage for tests (both paper-api and live api hosts).
function fakeBroker({ price = () => 100, keys = { paper: 'PKPAPER', live: 'AKLIVE' } } = {}) {
  const acct = { cash: 1000, last_equity: 1000, crypto_status: 'ACTIVE', trading_blocked: false, status: 'ACTIVE', account_number: '123456789' };
  const positions = {}; // symbol (no slash) -> qty
  const orders = new Map();
  const log = [];
  const opts = { fill: true, dropReply: false, extraLoss: 0 };
  const equity = () => acct.cash + Object.entries(positions).reduce((a, [s, q]) => a + q * price(s), 0) - opts.extraLoss;
  const fillPrice = sym => price(sym);
  const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'Content-Type': 'application/json' } });
  const handles = url => /^(paper-api|api)\.alpaca\.markets$/.test(new URL(url).hostname) && !new URL(url).pathname.startsWith('/v2/clock');
  async function fetchImpl(url, o = {}) {
    const u = new URL(url); const host = u.hostname.startsWith('paper') ? 'paper' : 'live';
    const key = o.headers?.['APCA-API-KEY-ID'];
    if (key !== keys[host]) return json({ message: 'forbidden' }, 403);
    const p = decodeURIComponent(u.pathname);
    log.push({ host, method: o.method || 'GET', path: p + u.search, body: o.body ? JSON.parse(o.body) : null });
    if (p === '/v2/account') { const e = equity(); return json({ ...acct, cash: String(acct.cash), equity: String(e), buying_power: String(acct.cash), last_equity: String(acct.last_equity) }); }
    if (p === '/v2/positions') return json(Object.entries(positions).filter(([, q]) => q > 0).map(([symbol, qty]) => ({ symbol, qty: String(qty) })));
    if (p === '/v2/orders' && o.method === 'POST') {
      const b = JSON.parse(o.body);
      if ([...orders.values()].some(x => x.client_order_id === b.client_order_id)) return json({ message: 'client_order_id must be unique' }, 422);
      const sym = b.symbol.replace('/', ''); const px = price(sym);
      const id = 'ord-' + (orders.size + 1);
      const ord = { id, client_order_id: b.client_order_id, symbol: b.symbol, side: b.side, status: 'accepted', body: b };
      if (b.side === 'sell' && !(positions[sym] >= Number(b.qty) - 1e-9)) return json({ message: 'insufficient qty available for order' }, 403);
      if (opts.fill) fill(ord, px);
      orders.set(id, ord);
      if (opts.dropReply) { opts.dropReply = false; throw new TypeError('fetch failed'); } // order created, reply lost
      return json(ord);
    }
    if (p.startsWith('/v2/orders:by_client_order_id')) { const o2 = [...orders.values()].find(x => x.client_order_id === u.searchParams.get('client_order_id')); return o2 ? json(o2) : json({ message: 'not found' }, 404); }
    const m = p.match(/^\/v2\/orders\/(.+)$/);
    if (m && o.method === 'DELETE') { const ord = orders.get(m[1]); if (!ord) return json({}, 404); ord.status = 'canceled'; return json({}); }
    if (m) { const ord = orders.get(m[1]); return ord ? json(ord) : json({ message: 'not found' }, 404); }
    return json({ message: 'unknown ' + p }, 404);
  }
  function fill(ord, px) {
    const b = ord.body; const sym = b.symbol.replace('/', '');
    const qty = b.notional ? Number(b.notional) / px : Number(b.qty);
    if (b.side === 'buy') { acct.cash -= qty * px; positions[sym] = (positions[sym] || 0) + qty; }
    else { acct.cash += qty * px; positions[sym] -= qty; }
    Object.assign(ord, { status: 'filled', filled_qty: String(qty), filled_avg_price: String(px), filled_at: new Date().toISOString() });
  }
  const fillAllOpen = px => { for (const o of orders.values()) if (o.status === 'accepted') fill(o, px); };
  return { fetchImpl, handles, acct, positions, orders, log, opts, fillAllOpen, equity };
}

module.exports = { fakeBroker };

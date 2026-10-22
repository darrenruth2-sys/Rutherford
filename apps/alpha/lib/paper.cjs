'use strict';
// Paper trading. Fake money only; nothing here can place a real order.
const round = (x, d = 8) => Math.round(x * 10 ** d) / 10 ** d;

// Open prediction bets count at current market price when known, otherwise at cost.
const betValue = (p, markets = {}) => (p.bets || []).filter(b => b.status === 'open').reduce((a, b) => a + b.shares * (markets[b.marketId]?.prices?.[b.outcomeIndex] ?? b.price), 0);

function equity(p, prices, markets) {
  let held = 0;
  for (const [pair, pos] of Object.entries(p.positions)) held += pos.qty * (prices[pair] ?? pos.avg);
  return p.cash + held + betValue(p, markets);
}

function buy(p, { pair, usd, price, feePct = 0.6, maxPositionPct = 100, prices = {} }) {
  usd = Number(usd);
  if (!(usd >= 1)) throw Error('Minimum order is $1');
  if (usd > p.cash + 1e-9) throw Error(`Not enough cash: you have $${p.cash.toFixed(2)}`);
  if (!(price > 0)) throw Error('No live price');
  const pos = p.positions[pair] || { qty: 0, avg: 0 };
  const eq = equity(p, { ...prices, [pair]: price });
  const after = (pos.qty * price + usd) / eq * 100;
  if (after > maxPositionPct + 1e-9) throw Error(`Risk rule: that would put ${after.toFixed(0)}% of your account in ${pair} (limit ${maxPositionPct}%)`);
  const fee = usd * feePct / 100, qty = (usd - fee) / price;
  const newQty = pos.qty + qty;
  p.positions[pair] = { qty: round(newQty), avg: (pos.qty * pos.avg + (usd - fee)) / newQty };
  p.cash = round(p.cash - usd, 6);
  const t = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), side: 'buy', pair, qty: round(qty), price, usd, fee: round(fee, 6), time: new Date().toISOString() };
  p.trades.push(t);
  return t;
}

function sell(p, { pair, qty, price, feePct = 0.6 }) {
  const pos = p.positions[pair];
  if (!pos || pos.qty <= 0) throw Error(`You don't own any ${pair}`);
  qty = qty === 'all' ? pos.qty : Number(qty);
  if (!(qty > 0)) throw Error('Enter an amount to sell');
  if (qty > pos.qty + 1e-12) throw Error(`You only have ${pos.qty} ${pair.split('-')[0]}`);
  if (!(price > 0)) throw Error('No live price');
  const gross = qty * price, fee = gross * feePct / 100, usd = gross - fee;
  const pnl = usd - qty * pos.avg;
  pos.qty = round(pos.qty - qty);
  if (pos.qty <= 1e-10) delete p.positions[pair];
  p.cash = round(p.cash + usd, 6);
  const t = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), side: 'sell', pair, qty: round(qty), price, usd: round(usd, 6), fee: round(fee, 6), pnl: round(pnl, 6), time: new Date().toISOString() };
  p.trades.push(t);
  return t;
}

function summary(p, prices, markets = {}) {
  const positions = Object.entries(p.positions).map(([pair, pos]) => {
    const price = prices[pair] ?? null, value = price ? pos.qty * price : null;
    return { pair, qty: pos.qty, avg: pos.avg, price, value, pnl: value != null ? value - pos.qty * pos.avg : null, pnlPct: price ? (price - pos.avg) / pos.avg * 100 : null };
  });
  const eq = equity(p, prices, markets);
  const bets = (p.bets || []).slice(-100).reverse().map(b => ({ ...b, nowPrice: markets[b.marketId]?.prices?.[b.outcomeIndex] ?? null }));
  return { cash: p.cash, startCash: p.startCash, equity: eq, totalPnl: eq - p.startCash, totalPnlPct: (eq - p.startCash) / p.startCash * 100, positions, trades: p.trades.slice(-100).reverse(), bets, betValue: betValue(p, markets), fees: p.trades.reduce((a, t) => a + t.fee, 0) };
}

module.exports = { buy, sell, summary, equity, betValue };

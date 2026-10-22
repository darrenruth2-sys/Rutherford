'use strict';
// Polymarket prediction markets: READ-ONLY public data (Gamma API). Used for paper bets only.
const GAMMA = 'https://gamma-api.polymarket.com';
const parseList = v => { if (Array.isArray(v)) return v; try { const x = JSON.parse(v); return Array.isArray(x) ? x : []; } catch { return []; } };
const asArray = d => (Array.isArray(d) ? d : d?.events || d?.markets || d?.data || []);

function normalize(m, ev = {}) {
  if (!m || m.id == null) return null;
  const outcomes = parseList(m.outcomes).map(String);
  let prices = parseList(m.outcomePrices).map(Number);
  if ((!prices.length || prices.some(p => !isFinite(p))) && isFinite(Number(m.lastTradePrice))) { const p = Number(m.lastTradePrice); prices = [p, 1 - p]; }
  const outs = outcomes.length ? outcomes : prices.length === 2 ? ['Yes', 'No'] : [];
  if (!outs.length || outs.length !== prices.length) return null;
  const end = Date.parse(m.endDateIso || m.endDate || ev.endDate || '') || null;
  const closed = !!m.closed;
  let winner = null, voided = false;
  if (closed) { const max = Math.max(...prices); if (max >= 0.98) winner = prices.indexOf(max); else voided = true; }
  const tags = (ev.tags || m.tags || []).map(t => t?.label).filter(Boolean);
  return {
    id: String(m.id), slug: m.slug || '', question: m.question || ev.title || 'Market', event: ev.title || '', eventSlug: ev.slug || '',
    outcomes: outs, prices, end, closed, active: m.active !== false && !closed && m.acceptingOrders !== false,
    volume24h: Number(m.volume24hr ?? ev.volume24hr ?? 0) || 0, liquidity: Number(m.liquidity ?? ev.liquidity ?? 0) || 0,
    change24h: isFinite(Number(m.oneDayPriceChange)) ? Number(m.oneDayPriceChange) : null,
    spread: isFinite(Number(m.spread)) ? Number(m.spread) : null,
    image: m.image || m.icon || ev.image || '', tags, winner, voided,
    url: ev.slug ? `https://polymarket.com/event/${ev.slug}` : m.slug ? `https://polymarket.com/market/${m.slug}` : ''
  };
}
const tradable = (m, at = Date.now()) => m && m.active && m.prices.every(p => p > 0.01 && p < 0.99) && (!m.end || m.end > at);

function create({ fetchImpl = fetch, now = () => Date.now() } = {}) {
  const cache = new Map();
  async function get(path, ttl = 60000) {
    const hit = cache.get(path);
    if (hit && now() - hit.at < ttl) { if (hit.missing) { const e = Error('Not found on Polymarket'); e.status = 404; throw e; } return hit.data; }
    let res;
    try { res = await fetchImpl(GAMMA + path, { headers: { Accept: 'application/json', 'User-Agent': 'RutherfordAlpha/1.0' }, signal: AbortSignal.timeout(12000) }); }
    catch { throw Error("Couldn't reach Polymarket"); }
    if (res.status === 404) { cache.set(path, { at: now(), missing: true }); const e = Error('Not found on Polymarket'); e.status = 404; throw e; }
    if (!res.ok) throw Error('Polymarket error (HTTP ' + res.status + ')');
    const data = await res.json();
    cache.set(path, { at: now(), data }); if (cache.size > 300) cache.delete(cache.keys().next().value);
    return data;
  }
  const fromEvents = events => events.flatMap(ev => (ev.markets || []).map(m => normalize(m, ev))).filter(Boolean);

  const tagIds = {};
  async function tagId(slug) {
    if (tagIds[slug] !== undefined) return tagIds[slug];
    try { tagIds[slug] = (await get('/tags/slug/' + encodeURIComponent(slug), 3600000))?.id ?? null; } catch { tagIds[slug] = null; }
    return tagIds[slug];
  }

  // Open events (optionally by category), biggest 24h volume first
  async function listMarkets({ category = 'trending', limit = 40 } = {}) {
    if (category === 'quick') return quickCrypto();
    const tag = category && category !== 'trending' ? category : '';
    let events = [];
    try { events = asArray(await get(`/events?active=true&closed=false&order=volume24hr&ascending=false&limit=${limit}${tag ? '&tag_slug=' + tag : ''}`)); } catch {}
    if (!events.length) {
      const id = tag ? await tagId(tag) : null;
      events = asArray(await get(`/events/keyset?closed=false&limit=${limit}${id != null ? '&tag_id=' + id : ''}`));
    }
    return fromEvents(events).filter(m => tradable(m, now())).sort((a, b) => b.volume24h - a.volume24h).slice(0, 80);
  }

  async function search(q) {
    q = String(q || '').trim().slice(0, 100); if (!q) return [];
    const d = await get('/public-search?q=' + encodeURIComponent(q) + '&limit_per_type=25', 30000);
    return fromEvents(d?.events || []).filter(m => tradable(m, now())).sort((a, b) => b.volume24h - a.volume24h).slice(0, 60);
  }

  // Short "Up or Down" crypto markets (e.g. Bitcoin 15-minute). Try the known slug pattern, then search.
  async function quickCrypto() {
    const out = []; const seen = new Set();
    const t = Math.floor(now() / 1000), w = 900;
    for (const coin of ['btc', 'eth', 'sol', 'xrp']) {
      for (const start of [Math.floor(t / w) * w, Math.floor(t / w) * w + w]) {
        try { const ev = await get(`/events/slug/${coin}-updown-15m-${start}`, 30000); for (const m of fromEvents([ev])) if (!seen.has(m.id)) { seen.add(m.id); out.push(m); } } catch {}
      }
    }
    if (out.length < 2) {
      for (const q of ['Bitcoin Up or Down', 'Ethereum Up or Down']) {
        try { for (const m of await search(q)) if (!seen.has(m.id) && /up or down/i.test(m.question + m.event)) { seen.add(m.id); out.push(m); } } catch {}
      }
    }
    return out.filter(m => tradable(m, now())).sort((a, b) => (a.end || Infinity) - (b.end || Infinity)).slice(0, 30);
  }

  async function market(id) {
    const m = await get('/markets/' + encodeURIComponent(id), 45000);
    const ev = Array.isArray(m?.events) ? m.events[0] || {} : {};
    const n = normalize(m, ev); if (!n) throw Error('Market data unreadable');
    return n;
  }

  return { listMarkets, search, quickCrypto, market };
}

// ---- paper bets (shared by you and the bots) ----
// Fill a little worse than the shown price to stand in for the spread.
function fillPrice(m, idx) { const p = m.prices[idx]; const half = m.spread != null ? Math.min(0.03, m.spread / 2) : 0.01; return Math.min(0.99, Math.round((p + half) * 1000) / 1000); }

function placeBet(holder, { market: m, outcome, usd, by = 'you', reason = '', time = Date.now() }) {
  if (!tradable(m, time)) throw Error('That market is closed or not trading');
  const idx = typeof outcome === 'number' ? outcome : m.outcomes.findIndex(o => o.toLowerCase() === String(outcome).toLowerCase());
  if (idx < 0) throw Error('Unknown outcome: ' + outcome);
  usd = Math.round(Number(usd) * 100) / 100;
  if (!(usd >= 1)) throw Error('Minimum bet is $1');
  if (usd > holder.cash + 1e-9) throw Error(`Not enough cash: $${holder.cash.toFixed(2)} available`);
  const price = fillPrice(m, idx);
  const bet = { id: time.toString(36) + Math.random().toString(36).slice(2, 6), marketId: m.id, question: m.question, outcome: m.outcomes[idx], outcomeIndex: idx, price, shares: usd / price, cost: usd, end: m.end, url: m.url, placedAt: new Date(time).toISOString(), status: 'open', by, reason };
  holder.cash = Math.round((holder.cash - usd) * 1e6) / 1e6;
  (holder.bets ||= []).push(bet);
  return bet;
}

// Returns list of bets that changed
function settleBets(holder, markets) {
  const changed = [];
  for (const b of holder.bets || []) {
    if (b.status !== 'open') continue;
    const m = markets[b.marketId]; if (!m || !m.closed) continue;
    if (m.voided) { b.status = 'void'; b.payout = b.cost; }
    else if (m.winner != null) { b.status = m.winner === b.outcomeIndex ? 'won' : 'lost'; b.payout = b.status === 'won' ? b.shares : 0; }
    else continue;
    b.pnl = b.payout - b.cost; b.settledAt = new Date().toISOString();
    holder.cash = Math.round((holder.cash + b.payout) * 1e6) / 1e6;
    changed.push(b);
  }
  return changed;
}

// Cash out early at the current price (minus spread)
function sellBet(holder, betId, m, at = Date.now()) {
  const b = (holder.bets || []).find(x => x.id === betId && x.status === 'open');
  if (!b) throw Error('Bet not found or already settled');
  if (!tradable(m, at)) throw Error('Market is not trading right now');
  const half = m.spread != null ? Math.min(0.03, m.spread / 2) : 0.01;
  const price = Math.max(0.001, m.prices[b.outcomeIndex] - half);
  b.status = 'sold'; b.payout = b.shares * price; b.pnl = b.payout - b.cost; b.settledAt = new Date().toISOString(); b.exitPrice = price;
  holder.cash = Math.round((holder.cash + b.payout) * 1e6) / 1e6;
  return b;
}

const openBetValue = (holder, markets = {}) => (holder.bets || []).filter(b => b.status === 'open').reduce((a, b) => a + b.shares * (markets[b.marketId]?.prices?.[b.outcomeIndex] ?? b.price), 0);

module.exports = { create, normalize, tradable, placeBet, settleBets, sellBet, openBetValue, fillPrice };

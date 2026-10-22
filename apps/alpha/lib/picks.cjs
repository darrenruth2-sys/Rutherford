'use strict';
// Rutherford's Picks: the AI researches a Polymarket market (live web search) and gives its own odds.
// Every pick is scored when the market resolves, against the market's own odds at the time,
// so you can see whether the AI actually knows better than the crowd.
const groq = require('./groq.cjs');

function parseJson(text) {
  const s = String(text || '');
  const fence = /```(?:json)?\s*([\s\S]*?)```/g; let m, last = null;
  while ((m = fence.exec(s))) last = m[1];
  const cands = [last, s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)].filter(Boolean);
  for (const c of cands) { try { return JSON.parse(c); } catch {} }
  return null;
}

function normalizeProbs(raw, outcomes) {
  const probs = outcomes.map(o => {
    const key = Object.keys(raw || {}).find(k => k.trim().toLowerCase() === o.trim().toLowerCase());
    let v = Number(key != null ? raw[key] : NaN); if (v > 1) v /= 100; return isFinite(v) && v >= 0 ? v : NaN;
  });
  if (probs.some(isNaN)) { const known = probs.filter(x => !isNaN(x)); if (known.length === outcomes.length - 1) { const rest = Math.max(0, 1 - known.reduce((a, b) => a + b, 0)); return normalizeProbs(Object.fromEntries(outcomes.map((o, i) => [o, isNaN(probs[i]) ? rest : probs[i]])), outcomes); } return null; }
  const sum = probs.reduce((a, b) => a + b, 0); if (!(sum > 0)) return null;
  return probs.map(p => Math.min(0.99, Math.max(0.01, p / sum)));
}

const brier = (probs, winner) => probs.reduce((a, p, i) => a + (p - (i === winner ? 1 : 0)) ** 2, 0);

function create({ load, save, groqKey, fetchImpl = fetch, now = () => Date.now(), model = 'openai/gpt-oss-120b' }) {
  let picks = load() || {};
  const persist = () => save(picks);
  const inflight = new Map();

  async function research(m) {
    const key = groqKey(); if (!key) throw Error('Needs a Groq key (Rutherford Settings)');
    const today = new Date(now()).toDateString();
    const system = `You are Rutherford, a sharp, careful forecaster. Today is ${today}. You will research a prediction market with web search (latest news, injuries, form, polls, schedules, prices) and then estimate the TRUE probability of each outcome yourself.
Rules: think independently from the market price, but respect it as evidence. Be calibrated: say 55% when unsure, not 90%. If you find nothing useful, stay close to the market price and use "low" confidence. Never invent facts.
End your answer with ONLY this JSON in a \`\`\`json block:
{"probabilities": {"<outcome>": 0.00, ...}, "pick": "<outcome>", "confidence": "low|medium|high", "summary": "2-3 plain sentences", "factors": ["short fact 1", "short fact 2", "short fact 3"]}`;
    const user = `Market: ${m.question}${m.event && m.event !== m.question ? `\nEvent: ${m.event}` : ''}\nOutcomes and current market prices: ${m.outcomes.map((o, i) => `${o} = ${Math.round(m.prices[i] * 100)}¢`).join(', ')}\nCloses: ${m.end ? new Date(m.end).toUTCString() : 'unknown'}${m.url ? `\nLink: ${m.url}` : ''}`;
    let res;
    try { res = await fetchImpl(groq.BASE + '/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(90000), body: JSON.stringify({ model, max_tokens: 3000, temperature: 0.3, tools: [{ type: 'browser_search' }], messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }) }); }
    catch { throw Error('Could not reach Groq'); }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw Error(res.status === 429 ? 'Groq rate limit: wait a minute and try again' : 'Groq error (HTTP ' + res.status + ')' + (data?.error?.message ? ': ' + String(data.error.message).slice(0, 160) : ''));
    const msg = data?.choices?.[0]?.message || {};
    const j = parseJson(msg.content);
    if (!j) throw Error('Rutherford’s answer could not be read, try again');
    const probs = normalizeProbs(j.probabilities, m.outcomes);
    if (!probs) throw Error('Rutherford did not give odds for every outcome, try again');
    let pickIndex = m.outcomes.findIndex(o => o.toLowerCase() === String(j.pick || '').toLowerCase());
    if (pickIndex < 0) pickIndex = probs.indexOf(Math.max(...probs));
    const sources = []; const seen = new Set();
    for (const t of msg.executed_tools || []) for (const r of t?.search_results?.results || []) if (r?.url && !seen.has(r.url)) { seen.add(r.url); sources.push({ title: String(r.title || r.url).slice(0, 120), url: r.url }); }
    return {
      marketId: m.id, question: m.question, outcomes: m.outcomes, marketPrices: m.prices, probs: probs.map(p => Math.round(p * 1000) / 1000), pickIndex, pick: m.outcomes[pickIndex],
      edge: Math.round((probs[pickIndex] - m.prices[pickIndex]) * 1000) / 1000,
      confidence: ['low', 'medium', 'high'].includes(j.confidence) ? j.confidence : 'low',
      summary: String(j.summary || '').slice(0, 600), factors: (Array.isArray(j.factors) ? j.factors : []).slice(0, 5).map(f => String(f).slice(0, 200)),
      sources: sources.slice(0, 6), at: now(), end: m.end, url: m.url, result: null
    };
  }

  // Reuse a recent pick unless the market moved a lot
  function fresh(p, m) { return p && !p.result && now() - p.at < 6 * 3600000 && m.prices.every((x, i) => Math.abs(x - (p.marketPrices[i] ?? x)) < 0.08); }

  async function pick(m, { force = false } = {}) {
    if (!force && fresh(picks[m.id], m)) return picks[m.id];
    if (inflight.has(m.id)) return inflight.get(m.id);
    const job = research(m).then(p => { picks[m.id] = p; persist(); return p; }).finally(() => inflight.delete(m.id));
    inflight.set(m.id, job); return job;
  }

  // Score finished markets: did the pick win, and was the AI better calibrated than the market?
  async function settle(getMarket) {
    let n = 0;
    for (const p of Object.values(picks)) {
      if (p.result || !p.end || p.end > now()) continue;
      let m; try { m = await getMarket(p.marketId); } catch { continue; }
      if (!m.closed) continue;
      if (m.voided || m.winner == null) { p.result = { voided: true, at: now() }; n++; continue; }
      const favorite = p.marketPrices.indexOf(Math.max(...p.marketPrices));
      p.result = { winner: m.winner, correct: m.winner === p.pickIndex, marketFavoriteCorrect: m.winner === favorite, brierAI: Math.round(brier(p.probs, m.winner) * 1000) / 1000, brierMarket: Math.round(brier(p.marketPrices, m.winner) * 1000) / 1000, at: now() };
      n++;
    }
    if (n) persist();
    return n;
  }

  function record() {
    const done = Object.values(picks).filter(p => p.result && !p.result.voided);
    const right = done.filter(p => p.result.correct).length, mkt = done.filter(p => p.result.marketFavoriteCorrect).length;
    const bA = done.reduce((a, p) => a + p.result.brierAI, 0) / (done.length || 1), bM = done.reduce((a, p) => a + p.result.brierMarket, 0) / (done.length || 1);
    const value = done.filter(p => p.edge >= 0.08);
    return {
      settled: done.length, right, accuracy: done.length ? Math.round(right / done.length * 1000) / 10 : null,
      marketRight: mkt, marketAccuracy: done.length ? Math.round(mkt / done.length * 1000) / 10 : null,
      brierAI: done.length ? Math.round(bA * 1000) / 1000 : null, brierMarket: done.length ? Math.round(bM * 1000) / 1000 : null,
      valuePicks: value.length, valueRight: value.filter(p => p.result.correct).length,
      pending: Object.values(picks).filter(p => !p.result).length,
      verdict: done.length < 15 ? `Too early: ${done.length}/15 finished picks` : bA < bM - 0.01 ? 'Beating the market’s odds so far' : bA > bM + 0.01 ? 'The market’s odds are more accurate so far' : 'About as accurate as the market'
    };
  }

  const get = id => picks[id] || null;
  const recent = () => Object.values(picks).sort((a, b) => b.at - a.at).slice(0, 100);
  return { pick, settle, record, get, recent, all: () => picks };
}

module.exports = { create, parseJson, normalizeProbs, brier };

'use strict';
/* Rutherford Alpha front end */
const $ = s => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false && c !== '') n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
};
const S = { tab: 'bots', arena: null, botSel: null, pmCat: 'trending', pmMarkets: [], clock: null, settings: {}, strategies: [], horizons: [], quotes: [], spark: {}, selected: null, range: '1D', askHistory: [], asking: null };

async function api(path, body) {
  const r = await fetch('api/' + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw Error(j.error || 'Request failed'); return j;
}
function toast(m, bad) { const t = $('#toast'); t.textContent = m; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), bad ? 5000 : 2500); }

/* ---------- formatting ---------- */
const money = (x, d) => x == null || !isFinite(x) ? '—' : (x < 0 ? '-$' : '$') + Math.abs(Number(x)).toLocaleString(undefined, { minimumFractionDigits: d ?? (Math.abs(x) >= 1 ? 2 : 4), maximumFractionDigits: d ?? (Math.abs(x) >= 1000 ? 2 : Math.abs(x) >= 1 ? 2 : 6) });
const pct = (x, sign = true) => x == null || !isFinite(x) ? '—' : (sign && x > 0 ? '+' : '') + x.toFixed(2) + '%';
const cls = x => (x > 0 ? 'up' : x < 0 ? 'down' : '');
const qty = x => Number(x).toLocaleString(undefined, { maximumFractionDigits: 8 });
const ago = t => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? s + 's ago' : s < 3600 ? Math.round(s / 60) + 'm ago' : s < 86400 ? Math.round(s / 3600) + 'h ago' : Math.round(s / 86400) + 'd ago'; };
const until = t => { const s = Math.round((t - Date.now()) / 1000); return s <= 0 ? 'scoring…' : s < 3600 ? 'in ' + Math.ceil(s / 60) + 'm' : 'in ' + (s / 3600).toFixed(1) + 'h'; };
const hz = h => (h < 60 ? h + 'm' : h / 60 + 'h');

/* ---------- charts ---------- */
function drawLine(canvas, points, { fill = true, hover = null } = {}) {
  const dpr = devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const g = canvas.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
  if (!points || points.length < 2) return null;
  const ys = points.map(p => p.c), min = Math.min(...ys), max = Math.max(...ys), pad = (max - min) * 0.08 || max * 0.001;
  const X = i => (i / (points.length - 1)) * w, Y = v => h - ((v - (min - pad)) / (max - min + 2 * pad)) * h;
  const color = ys.at(-1) >= ys[0] ? '#3be08f' : '#ff5d78';
  g.beginPath(); points.forEach((p, i) => (i ? g.lineTo(X(i), Y(p.c)) : g.moveTo(X(i), Y(p.c))));
  g.strokeStyle = color; g.lineWidth = 1.6; g.lineJoin = 'round'; g.stroke();
  if (fill) { const grad = g.createLinearGradient(0, 0, 0, h); grad.addColorStop(0, color + '33'); grad.addColorStop(1, color + '00'); g.lineTo(w, h); g.lineTo(0, h); g.closePath(); g.fillStyle = grad; g.fill(); }
  if (hover != null) { const i = Math.max(0, Math.min(points.length - 1, Math.round(hover / w * (points.length - 1)))); g.strokeStyle = '#8fa0b0'; g.lineWidth = 1; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(X(i), 0); g.lineTo(X(i), h); g.stroke(); g.setLineDash([]); g.fillStyle = color; g.beginPath(); g.arc(X(i), Y(points[i].c), 4, 0, 7); g.fill(); return points[i]; }
  return null;
}

/* ---------- Markets ---------- */
async function loadQuotes() {
  try { S.quotes = await api('quotes'); $('#updated').textContent = 'Updated ' + new Date().toLocaleTimeString(); }
  catch (e) { $('#updated').textContent = e.message; }
  renderGrid();
  if (S.selected) updateDetailPrice();
}
async function loadSpark(pair) {
  try { S.spark[pair] = (await api('candles?pair=' + pair + '&g=900')).slice(-96); } catch { S.spark[pair] = null; }
  const c = document.querySelector(`.qcard[data-pair="${pair}"] canvas`); if (c) drawLine(c, S.spark[pair], { fill: true });
}
function renderGrid() {
  const g = $('#quoteGrid'); g.innerHTML = '';
  for (const q of S.quotes) {
    const [base, quote] = q.pair.includes('-') ? q.pair.split('-') : [q.pair, 'stock'];
    const card = el('button', { class: 'qcard' + (S.selected === q.pair ? ' sel' : '') + (q.error ? ' err' : ''), 'data-pair': q.pair, onclick: () => select(q.pair) },
      el('div', { class: 'sym' }, base, ' ', el('small', { text: quote === 'stock' ? 'stock' : '/' + quote })),
      q.error ? el('div', { text: q.error }) : [el('div', { class: 'px num', text: money(q.price) }), el('div', { class: 'chg num ' + cls(q.change24h), text: pct(q.change24h) + ' 24h' })],
      el('canvas'),
      el('span', { class: 'rm', role: 'button', title: 'Remove', text: '✕', onclick: async e => { e.stopPropagation(); try { await api('watchlist', { remove: q.pair }); if (S.selected === q.pair) { S.selected = null; $('#detail').hidden = true; } loadQuotes(); } catch (er) { toast(er.message, true); } } }));
    g.append(card);
    if (S.spark[q.pair] === undefined) loadSpark(q.pair); else drawLine(card.querySelector('canvas'), S.spark[q.pair]);
  }
  if (!S.quotes.length) g.append(el('div', { class: 'empty', text: 'No pairs yet. Add one above (like BTC-USD).' }));
}

const RANGES = { '1D': [300, 288], '1W': [3600, 168], '1M': [21600, 120], '6M': [86400, 180] };
async function select(pair) {
  S.selected = pair; renderGrid();
  const d = $('#detail'); d.hidden = false; d.innerHTML = '';
  const q = S.quotes.find(x => x.pair === pair) || { pair };
  const chartCanvas = el('canvas'), tip = el('div', { class: 'tip' });
  const left = el('div', {},
    el('div', { class: 'd-head' }, el('h1', { text: pair }), el('span', { class: 'px num', id: 'dPrice', text: money(q.price) }), el('span', { class: 'num ' + cls(q.change24h), id: 'dChg', text: pct(q.change24h) + ' today' })),
    el('div', { class: 'muted num', id: 'dRange', text: q.low24h ? `24h low ${money(q.low24h)} · high ${money(q.high24h)}` : '' }),
    el('div', { class: 'ranges' }, Object.keys(RANGES).map(r => el('button', { class: r === S.range ? 'on' : '', text: r, onclick: () => { S.range = r; select(pair); } }))),
    el('div', { class: 'chart' }, chartCanvas, tip));
  // Trade box
  let side = 'buy';
  const amt = el('input', { type: 'number', min: '0', step: 'any', placeholder: 'Amount in $' });
  const goBtn = el('button', { class: 'btn', text: 'Buy (paper)' });
  const segBuy = el('button', { class: 'on', type: 'button', text: 'Buy' }), segSell = el('button', { type: 'button', text: 'Sell' });
  const setSide = s => { side = s; segBuy.className = s === 'buy' ? 'on' : ''; segSell.className = s === 'sell' ? 'on' : ''; amt.placeholder = s === 'buy' ? 'Amount in $' : 'Amount of ' + pair.split('-')[0] + ' (or "all")'; amt.type = s === 'buy' ? 'number' : 'text'; goBtn.textContent = s === 'buy' ? 'Buy (paper)' : 'Sell (paper)'; goBtn.className = 'btn' + (s === 'sell' ? ' sell' : ''); };
  segBuy.onclick = () => setSide('buy'); segSell.onclick = () => setSide('sell');
  const pfLine = el('div', { class: 'muted' });
  goBtn.onclick = async () => {
    try {
      const r = await api('trade', side === 'buy' ? { side, pair, usd: Number(amt.value) } : { side, pair, qty: amt.value.trim().toLowerCase() === 'all' ? 'all' : Number(amt.value) });
      toast(`${r.trade.side === 'buy' ? 'Bought' : 'Sold'} ${qty(r.trade.qty)} ${pair.split('-')[0]} @ ${money(r.trade.price)}` + (r.trade.pnl != null ? ` (P&L ${money(r.trade.pnl)})` : ''));
      amt.value = ''; showHolding(pair, pfLine);
    } catch (e) { toast(e.message, true); }
  };
  // Make a call
  let callH = S.horizons[1] || 60;
  const hzSeg = el('div', { class: 'seg' }, S.horizons.map(h => el('button', { type: 'button', class: h === callH ? 'on' : '', text: hz(h), onclick: e => { callH = h; [...e.target.parentNode.children].forEach(b => (b.className = b === e.target ? 'on' : '')); } })));
  const call = dir => api('forecast/manual', { pair, direction: dir, horizon: callH }).then(f => toast(`Locked: ${pair} ${dir} in ${hz(f.horizon)} from ${money(f.startPrice)}`)).catch(e => toast(e.message, true));
  const sigBox = el('div', {}, el('div', { class: 'muted', text: 'Loading…' }));
  const right = el('div', {},
    el('div', { class: 'side-box' }, el('h3', { text: 'Paper trade' }), el('div', { class: 'seg' }, segBuy, segSell), el('div', { class: 'row' }, amt), goBtn, pfLine),
    el('div', { class: 'side-box' }, el('h3', { text: 'Make your call' }), hzSeg, el('div', { class: 'row' }, el('button', { class: 'btn', style: 'flex:1', text: '▲ Up', onclick: () => call('up') }), el('button', { class: 'btn sell', style: 'flex:1', text: '▼ Down', onclick: () => call('down') })), el('div', { class: 'muted', text: 'Scored as "Me" on the Forecasts tab.' })),
    el('div', { class: 'side-box' }, el('h3', { text: 'What the strategies say' }), sigBox));
  d.append(left, right);
  showHolding(pair, pfLine);
  api('signals?pair=' + pair).then(sigs => {
    sigBox.innerHTML = '';
    for (const s of sigs) { const meta = S.strategies.find(x => x.id === s.strategy); sigBox.append(el('div', { class: 'sig' }, el('span', {}, meta?.name || s.strategy, el('span', { class: 'why', text: s.why })), el('b', { class: s.direction === 'up' ? 'up' : s.direction === 'down' ? 'down' : 'muted', text: s.direction ? (s.direction === 'up' ? '▲ up' : '▼ down') : 'sits out' }))); }
  }).catch(e => (sigBox.textContent = e.message));
  // Chart
  const [g, n] = RANGES[S.range];
  try {
    const pts = (await api('candles?pair=' + pair + '&g=' + g)).slice(-n);
    drawLine(chartCanvas, pts);
    const fmtT = t => new Date(t).toLocaleString(undefined, g >= 86400 ? { month: 'short', day: 'numeric', year: '2-digit' } : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    const first = pts[0]?.c, last = pts.at(-1)?.c;
    tip.innerHTML = ''; tip.append(el('span', { class: cls(last - first), text: pct((last - first) / first * 100) + ' over ' + S.range }));
    chartCanvas.onmousemove = e => { const p = drawLine(chartCanvas, pts, { hover: e.offsetX }); if (p) tip.textContent = fmtT(p.t) + ' · ' + money(p.c); };
    chartCanvas.onmouseleave = () => { drawLine(chartCanvas, pts); tip.innerHTML = ''; tip.append(el('span', { class: cls(last - first), text: pct((last - first) / first * 100) + ' over ' + S.range })); };
  } catch (e) { tip.textContent = e.message; }
  d.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
async function showHolding(pair, line) {
  try { const pf = await api('portfolio'); const pos = pf.positions.find(p => p.pair === pair); line.textContent = `Cash ${money(pf.cash)}` + (pos ? ` · You hold ${qty(pos.qty)} (${pct(pos.pnlPct)})` : ''); } catch {}
}
function updateDetailPrice() {
  const q = S.quotes.find(x => x.pair === S.selected); if (!q || q.error) return;
  const p = $('#dPrice'), c = $('#dChg'); if (p) p.textContent = money(q.price); if (c) { c.textContent = pct(q.change24h) + ' today'; c.className = 'num ' + cls(q.change24h); }
}

/* ---------- Portfolio ---------- */
async function loadPortfolio() {
  let pf; try { pf = await api('portfolio'); } catch (e) { return toast(e.message, true); }
  const tile = (k, v, s, c) => el('div', { class: 'tile' }, el('div', { class: 'k', text: k }), el('div', { class: 'v num ' + (c || ''), text: v }), s && el('div', { class: 's num ' + (c || ''), text: s }));
  $('#pfTiles').replaceChildren(
    tile('Account value', money(pf.equity, 2), 'started at ' + money(pf.startCash, 0)),
    tile('Total profit / loss', money(pf.totalPnl, 2), pct(pf.totalPnlPct), cls(pf.totalPnl)),
    tile('Cash', money(pf.cash, 2), (pf.cash / pf.equity * 100).toFixed(0) + '% of account'),
    tile('Fees paid', money(pf.fees, 2), pf.trades.length + ' trades'));
  $('#pfPositions').replaceChildren(pf.positions.length ? el('div', { class: 'tbl-wrap' }, el('table', {},
    el('tr', {}, ['Coin', 'Amount', 'Avg cost', 'Price', 'Value', 'P&L', ''].map((h, i) => el('th', { class: i && i < 6 ? 'r' : '', text: h }))),
    pf.positions.map(p => el('tr', {}, el('td', { text: p.pair }), el('td', { class: 'r num', text: qty(p.qty) }), el('td', { class: 'r num', text: money(p.avg) }), el('td', { class: 'r num', text: money(p.price) }), el('td', { class: 'r num', text: money(p.value, 2) }),
      el('td', { class: 'r num ' + cls(p.pnl), text: money(p.pnl, 2) + ' (' + pct(p.pnlPct) + ')' }),
      el('td', {}, el('button', { class: 'btn small ghost', text: 'Sell all', onclick: async () => { if (!confirm('Sell all ' + p.pair + ' (paper)?')) return; try { await api('trade', { side: 'sell', pair: p.pair, qty: 'all' }); toast('Sold'); loadPortfolio(); } catch (e) { toast(e.message, true); } } }))))))
    : el('div', { class: 'empty', text: 'No positions. Pick a coin on the Markets tab to buy with paper money.' }));
  $('#pfBets').replaceChildren(pf.bets.length ? betTable(pf.bets, true) : el('div', { class: 'empty', text: 'No bets yet. Browse the Predictions tab.' }));
  $('#pfTrades').replaceChildren(pf.trades.length ? el('div', { class: 'tbl-wrap' }, el('table', {},
    el('tr', {}, ['When', 'Side', 'Pair', 'Amount', 'Price', 'Total', 'P&L'].map((h, i) => el('th', { class: i > 2 ? 'r' : '', text: h }))),
    pf.trades.map(t => el('tr', {}, el('td', { text: new Date(t.time).toLocaleString() }), el('td', { class: t.side === 'buy' ? 'up' : 'down', text: t.side }), el('td', { text: t.pair }), el('td', { class: 'r num', text: qty(t.qty) }), el('td', { class: 'r num', text: money(t.price) }), el('td', { class: 'r num', text: money(t.usd, 2) }), el('td', { class: 'r num ' + cls(t.pnl), text: t.pnl != null ? money(t.pnl, 2) : '' })))))
    : el('div', { class: 'empty', text: 'No trades yet.' }));
}

/* ---------- Forecasts ---------- */
function ciBar(s) {
  const wrap = el('div', { class: 'ci' }, el('div', { class: 'track' }), el('div', { class: 'fifty', title: 'Coin flip (50%)' }));
  if (s.ci) { wrap.append(el('div', { class: 'band', style: `left:${s.ci[0]}%;width:${Math.max(1, s.ci[1] - s.ci[0])}%`, title: `95% likely range: ${s.ci[0].toFixed(0)}–${s.ci[1].toFixed(0)}%` }), el('div', { class: 'pt', style: `left:${s.accuracy}%` })); }
  return el('div', { class: 'ci-col' }, wrap, el('div', { class: 'ci-labels' }, el('span', { text: '0%' }), el('span', { text: '50% = coin flip' }), el('span', { text: '100%' })));
}
async function loadForecasts() {
  let data; try { data = await api('forecasts'); } catch (e) { return toast(e.message, true); }
  const { scoreboard: sb, recent } = data;
  const rows = [...sb.strategies].sort((a, b) => (b.n >= 20) - (a.n >= 20) || (b.accuracy ?? -1) - (a.accuracy ?? -1));
  $('#board').replaceChildren(el('div', { class: 'board' }, rows.map(s => el('div', { class: 'srow' },
    el('div', { class: 'nm' }, el('b', { text: s.name }), el('span', { text: s.about })),
    el('div', { class: 'acc num ' + (s.verdict.tag === 'edge' ? 'up' : s.verdict.tag === 'worse' ? 'down' : '') }, s.n ? s.accuracy.toFixed(1) + '%' : '—', el('small', { text: `${s.wins}/${s.n} right` + (s.pending ? ` · ${s.pending} waiting` : '') })),
    ciBar(s),
    el('div', { class: 'verdict-col' }, el('div', { class: 'verdict ' + s.verdict.tag, text: s.verdict.text }),
      el('div', { class: 'hz num', text: s.byHorizon.map(h => `${hz(h.horizon)}: ${h.n ? h.accuracy.toFixed(0) + '% (' + h.n + ')' : '—'}`).join(' · ') }))))));
  $('#recent').replaceChildren(recent.length ? el('div', { class: 'tbl-wrap' }, el('table', {},
    el('tr', {}, ['Made', 'Pair', 'Who', 'Call', 'Time frame', 'Start', 'End', 'Result'].map((h, i) => el('th', { class: [5, 6].includes(i) ? 'r' : '', text: h }))),
    recent.map(f => el('tr', {}, el('td', { text: ago(f.start) }), el('td', { text: f.pair }), el('td', { text: S.strategies.find(s => s.id === f.strategy)?.name || (f.strategy === 'me' ? 'Me' : f.strategy) }),
      el('td', { class: f.direction === 'up' ? 'up' : 'down', text: f.direction === 'up' ? '▲ up' : '▼ down' }), el('td', { text: hz(f.horizon) }), el('td', { class: 'r num', text: money(f.startPrice) }), el('td', { class: 'r num', text: f.endPrice ? money(f.endPrice) : '' }),
      el('td', {}, el('span', { class: 'pill ' + (f.result || 'pending'), text: f.result || until(f.due) }))))))
    : el('div', { class: 'empty', text: 'No calls yet. Hit "Run all strategies now", or turn on automatic runs and leave Alpha open.' }));
  $('#autoToggle').checked = !!S.settings.autoForecast; $('#autoEvery').value = String(S.settings.autoEveryMin || 15);
}

/* ---------- Ask ---------- */
function md(text) { return DOMPurify.sanitize(marked.parse(text || '')); }
function renderAskEmpty() {
  if (S.askHistory.length) return;
  $('#askThread').replaceChildren(el('div', { class: 'starters' }, ['How is my portfolio doing?', 'Which forecast strategy is actually working?', "What's BTC doing today?", 'Give me a careful plan for my $1,000 paper account'].map(q => el('button', { text: q, onclick: () => { $('#askInput').value = q; askSend(); } }))));
}
async function askSend() {
  const input = $('#askInput'); const q = input.value.trim(); if (!q || S.asking) return;
  if (!S.askHistory.length) $('#askThread').innerHTML = '';
  input.value = '';
  $('#askThread').append(el('div', { class: 'ask-msg user' }, el('span', { text: q })));
  const out = el('div', { class: 'ask-msg md', html: '<p class="muted">Pulling live data…</p>' }); $('#askThread').append(out);
  out.scrollIntoView({ block: 'end' });
  const ac = new AbortController(); S.asking = ac; $('#askSend').textContent = '■';
  let full = '';
  try {
    const r = await fetch('api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: q, history: S.askHistory }), signal: ac.signal });
    const reader = r.body.getReader(), dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true }); let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2); if (!line.startsWith('data: ')) continue;
        const ev = JSON.parse(line.slice(6));
        if (ev.type === 'text') { full += ev.delta; out.innerHTML = md(full); }
        if (ev.type === 'error') { if (!full) out.innerHTML = ''; out.append(el('div', { class: 'err', text: ev.message })); }
      }
    }
  } catch (e) { if (e.name !== 'AbortError') out.append(el('div', { class: 'err', text: e.message })); }
  finally { S.asking = null; $('#askSend').textContent = '↑'; }
  if (full) S.askHistory.push({ role: 'user', content: q }, { role: 'assistant', content: full });
}

/* ---------- Settings ---------- */
function openSettings() {
  const s = S.settings;
  $('#keyInput').value = ''; $('#keyStatus').textContent = s.keyFromRutherford ? 'Using the key from your Rutherford app ✓' : s.hasKey ? 'Key saved ✓' : 'No key yet. Get one free at console.groq.com/keys';
  $('#modelInput').value = s.model; $('#feeInput').value = s.feePct; $('#maxPosInput').value = s.maxPositionPct; $('#stockFeeInput').value = s.stockFeePct;
  $('#alpacaId').value = s.alpacaKeyId || ''; $('#alpacaSecret').value = ''; $('#alpacaStatus').textContent = s.hasAlpaca ? 'Saved. Stocks use Alpaca.' : 'Not set: stocks use Yahoo\u2019s free feed (works, but unofficial). Get free keys at alpaca.markets → Paper Trading → API Keys.';
  $('#botEvery').value = String(s.botEveryMin); $('#aiEvery').value = String(s.aiEveryMin); $('#evolveEvery').value = String(s.evolveHours); $('#botsPm').checked = s.botsUsePolymarket !== false; $('#arenaCash').value = s.botStartCash;
  $('#settingsDlg').showModal();
}

/* ---------- Bot arena ---------- */
async function loadArena() {
  try { S.arena = await api('arena'); } catch (e) { return toast(e.message, true); }
  renderArena();
}
function sparkPts(eq) { return eq.map(([t, v]) => ({ t, c: v })); }
function renderArena() {
  const a = S.arena; if (!a) return;
  $('#arenaToggle').checked = S.settings.arenaOn !== false;
  const next = a.nextTick ? Math.max(0, Math.round((a.nextTick - Date.now()) / 60000)) : null;
  $('#arenaStatus').textContent = (a.lastTick ? `Last move ${ago(a.lastTick)}` : 'Waiting for first move') + (S.settings.arenaOn === false ? ' · paused' : next != null ? ` · next in ~${next || '<1'}m` : '') + ` · stocks ${a.stockOpen ? 'open' : 'closed'}`;
  const cards = $('#botCards'); cards.innerHTML = '';
  a.bots.forEach((b, rank) => {
    const st = b.stats;
    const teacher = b.learnedFrom ? a.bots.find(x => x.id === b.learnedFrom)?.name : null;
    const card = el('button', { class: 'bot-card' + (S.botSel === b.id ? ' sel' : ''), style: `--bot:${b.color}`, onclick: () => { S.botSel = S.botSel === b.id ? null : b.id; renderArena(); } },
      el('div', { class: 'bot-top' }, el('span', { class: 'rank', text: '#' + (rank + 1) }), el('span', { class: 'bot-emoji', text: b.emoji }), el('div', { class: 'bot-name' }, el('b', { text: b.name }), el('span', { text: { momentum: 'Momentum', contrarian: 'Contrarian', trend: 'Trend', ai: 'AI strategist' }[b.style] })), el('span', { class: 'gen', title: teacher ? 'Learned from ' + teacher : 'Generation', text: 'Gen ' + b.generation })),
      el('div', { class: 'bot-ret num ' + cls(st.returnPct), text: pct(st.returnPct) }),
      el('div', { class: 'muted num', text: money(st.equity, 2) + ' · cash ' + money(st.cash, 0) }),
      el('canvas', { class: 'bot-spark' }),
      el('div', { class: 'bot-stats' },
        el('div', {}, el('span', { text: 'Win rate' }), el('b', { class: 'num', text: st.winRate == null ? '—' : st.winRate + '%' }), el('small', { text: `${st.wins}W / ${st.losses}L` })),
        el('div', {}, el('span', { text: 'Trades' }), el('b', { class: 'num', text: String(st.trades) }), el('small', { text: st.betsOpen ? st.betsOpen + ' bets open' : `${st.betsWon}W ${st.betsLost}L bets` })),
        el('div', {}, el('span', { text: 'Worst dip' }), el('b', { class: 'num down', text: st.maxDrawdownPct ? '-' + st.maxDrawdownPct + '%' : '0%' }), el('small', { text: 'max drawdown' })),
        el('div', {}, el('span', { text: 'Profit factor' }), el('b', { class: 'num', text: st.profitFactor == null ? '—' : String(st.profitFactor) }), el('small', { text: '$ won per $ lost' }))),
      el('div', { class: 'verdict ' + st.verdict.tag, text: st.verdict.text }),
      b.positions.length ? el('div', { class: 'holds' }, b.positions.slice(0, 4).map(p => el('span', { class: 'hold ' + cls(p.pnlPct), text: `${p.sym} ${pct(p.pnlPct)}` }))) : el('div', { class: 'holds muted', text: 'Holding cash' }),
      b.style === 'ai' && b.ai ? el('div', { class: 'ai-note', text: b.ai.thoughts ? '“' + b.ai.thoughts + '”' : b.ai.status }) : null);
    cards.append(card);
    requestAnimationFrame(() => drawLine(card.querySelector('canvas'), sparkPts(b.equity)));
  });
  // legend + combined chart
  const legend = $('#arenaLegend'); legend.innerHTML = '';
  for (const b of a.bots) legend.append(el('span', {}, el('i', { style: `background:${b.color}` }), b.name));
  if (a.benchmark) legend.append(el('span', { title: 'What you would have made just holding Bitcoin since the arena started' }, el('i', { class: 'dash' }), `Hold BTC ${pct(a.benchmark.returnPct)}`));
  requestAnimationFrame(() => drawMulti($('#arenaChart'), a.bots.map(b => ({ color: b.color, name: b.name, pts: b.equity })), a.bots[0]?.stats ? a.bots.map(b => b.stats) : [], a.benchmark));
  // lessons
  const kinds = { trade: '📈', bet: '🎯', evolve: '🧬', ai: '🧠' };
  $('#lessons').replaceChildren(...(a.lessons.length ? a.lessons.slice(0, 60).map(l => el('div', { class: 'lesson ' + l.kind }, el('span', { class: 'when', text: ago(l.t) }), el('span', { text: l.text }))) : [el('div', { class: 'empty', text: 'Nothing yet. Bots log every trade, bet, AI thought and lesson here.' })]));
  if (S.botSel) renderBotDetail(a.bots.find(b => b.id === S.botSel)); else $('#botDetail').innerHTML = '';
}

function drawMulti(canvas, series, _stats, bench) {
  const dpr = devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr; const g = canvas.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
  const all = series.flatMap(s => s.pts);
  if (all.length < 2) { g.fillStyle = '#5f7080'; g.font = '13px system-ui'; g.fillText('The chart fills in as the bots trade (every few minutes while Rutherford is open).', 12, 24); return; }
  const t0 = Math.min(...all.map(p => p[0])), t1 = Math.max(...all.map(p => p[0]));
  let lo = Math.min(...all.map(p => p[1])), hi = Math.max(...all.map(p => p[1]));
  const start = series[0].pts[0]?.[1] || 1000;
  if (bench) { const bv = start * (1 + bench.returnPct / 100); lo = Math.min(lo, bv, start); hi = Math.max(hi, bv, start); }
  const pad = (hi - lo) * 0.1 || hi * 0.01; lo -= pad; hi += pad;
  const X = t => 40 + (t1 > t0 ? (t - t0) / (t1 - t0) : 1) * (w - 50), Y = v => 8 + (1 - (v - lo) / (hi - lo)) * (h - 28);
  g.strokeStyle = '#1f2b37'; g.fillStyle = '#5f7080'; g.font = '11px system-ui'; g.lineWidth = 1;
  for (let i = 0; i <= 3; i++) { const v = lo + (hi - lo) * i / 3, y = Y(v); g.beginPath(); g.moveTo(40, y); g.lineTo(w - 10, y); g.stroke(); g.fillText('$' + Math.round(v), 2, y + 4); }
  g.setLineDash([2, 3]); g.strokeStyle = '#2d3d4d'; g.beginPath(); g.moveTo(40, Y(start)); g.lineTo(w - 10, Y(start)); g.stroke();
  if (bench) { g.strokeStyle = '#ffc857'; g.setLineDash([6, 5]); g.beginPath(); g.moveTo(X(t0), Y(start)); g.lineTo(X(t1), Y(start * (1 + bench.returnPct / 100))); g.stroke(); }
  g.setLineDash([]);
  for (const s of series) { if (s.pts.length < 1) continue; g.strokeStyle = s.color; g.lineWidth = 2; g.beginPath(); s.pts.forEach(([t, v], i) => (i ? g.lineTo(X(t), Y(v)) : g.moveTo(X(t), Y(v)))); g.stroke(); }
  g.fillStyle = '#5f7080'; g.fillText(new Date(t0).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' }), 40, h - 4);
  const endLbl = new Date(t1).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); g.fillText(endLbl, w - 10 - g.measureText(endLbl).width, h - 4);
}

async function renderBotDetail(b) {
  if (!b) return;
  const box = $('#botDetail');
  const head = el('div', { class: 'bd-head', style: `--bot:${b.color}` }, el('span', { class: 'bot-emoji big', text: b.emoji }), el('div', {}, el('h2', { class: 'bd-title', text: b.name }), el('p', { class: 'muted', text: b.about })), el('div', { class: 'spacer' }), el('button', { class: 'icon-btn', text: '✕', onclick: () => { S.botSel = null; renderArena(); } }));
  box.replaceChildren(el('div', { class: 'panel-box bot-detail' }, head, el('div', { class: 'muted', text: 'Loading trades…' })));
  let d; try { d = await api('arena/bot?id=' + b.id); } catch (e) { return toast(e.message, true); }
  const st = b.stats;
  const tiles = el('div', { class: 'tiles small' },
    [['Return', pct(st.returnPct), cls(st.returnPct)], ['Win rate', st.winRate == null ? '—' : st.winRate + '%', ''], ['Avg win', st.avgWinPct == null ? '—' : pct(st.avgWinPct), 'up'], ['Avg loss', st.avgLossPct == null ? '—' : pct(st.avgLossPct), 'down'],
     ['Best trade', st.best ? `${st.best.sym} ${pct(st.best.pct)}` : '—', 'up'], ['Worst trade', st.worst ? `${st.worst.sym} ${pct(st.worst.pct)}` : '—', 'down'], ['Fees paid', money(st.feesPaid, 2), ''], ['Coin-flip test', st.verdict.text, '']]
      .map(([k, v, c]) => el('div', { class: 'tile' }, el('div', { class: 'k', text: k }), el('div', { class: 'v num ' + c, text: v }))));
  const genes = { lookback: ['Looks back', v => v * 5 + ' min'], entryPct: ['Entry trigger', v => v + '%'], takeProfitPct: ['Take profit at', v => '+' + v + '%'], stopLossPct: ['Stop loss at', v => '-' + v + '%'], sizePct: ['Bet size', v => v + '% of account'], maxPositions: ['Max positions', v => v], maxHoldHours: ['Max hold', v => v + 'h'], pmSizePct: ['Polymarket bet size', v => v + '%'], pmMinPrice: ['Odds range from', v => Math.round(v * 100) + '¢'], pmMaxPrice: ['Odds range to', v => Math.round(v * 100) + '¢'] };
  const geneRows = Object.entries(d.genome).filter(([k]) => genes[k]).map(([k, v]) => { const def = d.defaults?.[k]; const changed = def != null && def !== v; return el('tr', {}, el('td', { text: genes[k][0] }), el('td', { class: 'r num' + (changed ? ' learned' : ''), text: genes[k][1](v) }), el('td', { class: 'r num muted', text: changed ? 'was ' + genes[k][1](def) : '' })); });
  const brain = el('div', { class: 'side-box' }, el('h3', { text: b.style === 'ai' ? 'How it decides' : `Its settings (generation ${d.generation}${d.learnedFrom ? ', learned from ' + (S.arena.bots.find(x => x.id === d.learnedFrom)?.name || d.learnedFrom) : ''})` }),
    b.style === 'ai' ? el('p', { class: 'muted', text: 'Each round an AI model gets the live prices, its own account, the other bots’ records and the lesson log, and picks up to 4 moves. Hard limits: max 25% per buy, 5% per bet, 3 open bets.' }) : el('div', { class: 'tbl-wrap' }, el('table', {}, geneRows)),
    b.ai?.skipped?.length ? el('p', { class: 'muted', text: 'Last round skipped: ' + b.ai.skipped.join('; ') }) : null);
  const posT = b.positions.length ? el('div', { class: 'tbl-wrap' }, el('table', {}, el('tr', {}, ['Holding', 'Amount', 'Bought at', 'Now', 'P&L', 'Since'].map((h, i) => el('th', { class: i && i < 5 ? 'r' : '', text: h }))),
    b.positions.map(p => el('tr', {}, el('td', { text: p.sym }), el('td', { class: 'r num', text: qty(p.qty) }), el('td', { class: 'r num', text: money(p.avg) }), el('td', { class: 'r num', text: money(p.price) }), el('td', { class: 'r num ' + cls(p.pnlPct), text: pct(p.pnlPct) }), el('td', { text: p.openedAt ? ago(p.openedAt) : '' }))))) : el('div', { class: 'empty', text: 'No open positions.' });
  const allTrades = [...d.trades.map(t => ({ ...t, when: t.t })), ...d.bets.map(x => ({ when: Date.parse(x.placedAt), side: 'bet', sym: x.question, qty: null, price: x.price, usd: x.cost, pnl: x.pnl, pnlPct: x.pnl != null ? x.pnl / x.cost * 100 : null, reason: `${x.outcome} · ${x.status}${x.reason ? ' · ' + x.reason : ''}` }))].sort((x, y) => y.when - x.when);
  const tradesT = allTrades.length ? el('div', { class: 'tbl-wrap tall' }, el('table', {}, el('tr', {}, ['When', 'Action', 'What', 'Price', 'Amount', 'Result', 'Why'].map((h, i) => el('th', { class: [3, 4, 5].includes(i) ? 'r' : '', text: h }))),
    allTrades.slice(0, 400).map(t => el('tr', {}, el('td', { text: new Date(t.when).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) }), el('td', { class: t.side === 'buy' ? 'up' : t.side === 'sell' ? 'down' : 'muted', text: t.side }), el('td', { class: 'what', title: t.sym, text: t.sym }), el('td', { class: 'r num', text: t.side === 'bet' ? Math.round(t.price * 100) + '¢' : money(t.price) }), el('td', { class: 'r num', text: money(t.usd, 2) }), el('td', { class: 'r num ' + cls(t.pnl), text: t.pnl != null ? `${money(t.pnl, 2)} (${pct(t.pnlPct)})` : '' }), el('td', { class: 'why', text: t.reason || '' }))))) : el('div', { class: 'empty', text: 'No trades yet.' });
  box.replaceChildren(el('div', { class: 'panel-box bot-detail' }, head, tiles, el('div', { class: 'bd-grid' }, el('div', {}, el('h2', { text: 'Open positions' }), posT, b.bets.length ? [el('h2', { text: 'Open bets' }), betTable(b.bets, false)] : null), brain), el('h2', { text: `Everything it has traded (${allTrades.length})` }), tradesT));
}

/* ---------- Real money ---------- */
async function loadLive() {
  let v; try { v = await api('live'); } catch (e) { return toast(e.message, true); }
  S.live = v; renderLive(); setMoneyBadge(v.state);
}
function setMoneyBadge(st) {
  const b = $('#moneyBadge');
  if (st?.enabled) { b.textContent = st.target === 'live' ? 'REAL $ ON' : 'PRACTICE ON'; b.className = 'paper-badge' + (st.target === 'live' ? ' real' : ''); b.title = 'Copy-trading ' + st.botId + ' into your Alpaca ' + (st.target === 'live' ? 'REAL-money' : 'practice') + ' account'; }
  else { b.textContent = 'PAPER'; b.className = 'paper-badge'; b.title = 'Bots and bets here use paper money'; }
}
function renderLive() {
  const v = S.live, st = v.state;
  const badge = $('#liveBadge');
  badge.textContent = st.haltedReason && !st.enabled ? 'STOPPED' : st.enabled ? (st.target === 'live' ? 'REAL MONEY ON' : 'PRACTICE ON') : 'OFF';
  badge.className = 'live-badge ' + (st.haltedReason && !st.enabled ? 'halted' : st.enabled ? (st.target === 'live' ? 'real' : 'practice') : '');
  $('#killBtn').hidden = !st.enabled && !v.proposals.some(p => ['waiting', 'sent', 'unknown'].includes(p.status));
  const save = async patch => { try { await api('live/config', patch); await loadLive(); } catch (e) { toast(e.message, true); } };
  const num = (label, key, step = 1) => el('label', { class: 'f' }, label, el('input', { type: 'number', min: '1', step: String(step), value: st[key], onchange: e => save({ [key]: Number(e.target.value) }) }));
  const chk = (label, key) => el('label', { class: 'toggle' }, el('input', { type: 'checkbox', checked: st[key] ? true : null, onchange: e => save({ [key]: e.target.checked }) }), label);
  const seg = (opts, cur, key) => el('div', { class: 'seg' }, opts.map(([val, text]) => el('button', { type: 'button', class: cur === val ? 'on' : '', text, onclick: () => save({ [key]: val }) })));
  const bots = S.arena?.bots || [];
  const confirmIn = el('input', { placeholder: `Type: ${st.confirmPhrase}`, autocomplete: 'off', style: 'width:100%' });
  const setup = $('#liveSetup'); setup.innerHTML = '';
  if (st.haltedReason) setup.append(el('div', { class: 'halt-box', text: '⚠ ' + st.haltedReason }));
  const s = S.settings;
  setup.append(
    el('div', { class: 'step' }, el('h3', {}, el('i', { text: '1' }), 'Which account?'), seg([['paper', '🧪 Practice (Alpaca paper)'], ['live', '💵 Real money (Alpaca live)']], st.target, 'target'),
      st.target === 'paper' ? el('p', { class: 'muted', text: s.hasAlpaca ? 'Uses your Alpaca paper keys from ⚙ Settings: real broker, fake money. Start here.' : 'Add your Alpaca paper keys in ⚙ Settings first.' })
        : el('div', {}, el('p', { class: 'muted', text: s.hasAlpacaLive ? `Live keys saved (${s.alpacaLiveKeyHint}). Paste new ones to replace.` : 'In Alpaca switch to your LIVE account → API Keys → Generate. These are different from your paper keys.' }),
            el('div', { class: 'row' }, el('input', { id: 'liveKeyId', placeholder: 'Live API Key ID (AK…)', autocomplete: 'off', style: 'flex:1;min-width:140px' }), el('input', { id: 'liveSecret', type: 'password', placeholder: 'Live Secret', autocomplete: 'off', style: 'flex:1;min-width:140px' }),
              el('button', { class: 'btn small', text: 'Save keys', onclick: async () => { try { S.settings = await api('settings', { alpacaLiveKeyId: $('#liveKeyId').value, alpacaLiveSecret: $('#liveSecret').value }); toast('Live keys saved'); loadLive(); } catch (e) { toast(e.message, true); } } })))),
    el('div', { class: 'step' }, el('h3', {}, el('i', { text: '2' }), 'Which bot do you follow?'),
      el('div', { class: 'follow' }, bots.map(b => el('button', { type: 'button', class: st.botId === b.id ? 'on' : '', style: `--bot:${b.color}`, onclick: () => save({ botId: b.id }) }, el('b', { text: `${b.emoji} ${b.name}` }), el('small', { text: `${pct(b.stats.returnPct)} · win ${b.stats.winRate ?? '—'}% of ${b.stats.closed}` }), el('small', { text: b.stats.verdict.text })))),
      el('p', { class: 'muted', text: 'Tip: wait until a bot beats the coin flip over many trades before following it with real money.' })),
    el('div', { class: 'step' }, el('h3', {}, el('i', { text: '3' }), 'Your limits'),
      el('div', { class: 'row' }, num('Total budget $', 'budgetUsd', 5), num('Max per trade $', 'maxPerTradeUsd'), num('Stop if down today $', 'dailyLossLimitUsd'), num('Max orders a day', 'maxOrdersPerDay')),
      el('div', { class: 'row' }, chk('Crypto', 'allowCrypto'), chk('Stocks', 'allowStocks'), chk('Hold stocks overnight (avoids day-trade limits)', 'avoidDayTrades'))),
    el('div', { class: 'step' }, el('h3', {}, el('i', { text: '4' }), 'How should it trade?'), seg([['approve', '✋ Ask me before every trade'], ['auto', '⚡ Automatic (within limits)']], st.mode, 'mode'),
      el('p', { class: 'muted', text: st.mode === 'approve' ? 'Each trade waits here (and on your phone) for Approve. Unapproved trades expire after 10 minutes.' : 'Trades go through right away, but only inside your limits.' })),
    el('div', { class: 'step' }, el('h3', {}, el('i', { text: '5' }), st.enabled ? 'It’s on' : 'Turn it on'),
      !st.enabled && st.target === 'live' ? confirmIn : null,
      el('button', { class: 'btn big-toggle' + (st.enabled ? ' kill' : ''), text: st.enabled ? 'Turn off' : st.target === 'live' ? 'Turn on REAL-money trading' : 'Turn on practice trading', onclick: async e => {
        e.target.disabled = true;
        try { if (st.enabled) await api('live/off', {}); else await api('live/on', { confirm: confirmIn.value }); toast(st.enabled ? 'Turned off' : 'On. Following ' + st.botId); } catch (er) { toast(er.message, true); }
        e.target.disabled = false; loadLive();
      } })));
  // right column
  const side = $('#liveSide'); side.innerHTML = '';
  const a = v.account;
  side.append(el('div', { class: 'panel-box', style: 'margin-top:0' }, el('h2', { text: `Alpaca ${st.target === 'live' ? 'real-money' : 'practice'} account ${a?.number || ''}` }),
    a ? el('div', { class: 'acct' }, [['Account value', money(a.equity, 2), ''], ['Today', money(a.todayPnl, 2), cls(a.todayPnl)], ['Cash', money(a.cash, 2), ''], ['Rutherford is using', `${money(st.deployed, 2)} of ${money(st.budgetUsd, 0)}`, '']].map(([k, val, c]) => el('div', { class: 'tile' }, el('div', { class: 'k', text: k }), el('div', { class: 'v num ' + c, style: 'font-size:18px', text: val }))))
      : el('p', { class: 'muted', text: v.accountError || 'Not connected' }),
    a && a.cryptoStatus && a.cryptoStatus !== 'ACTIVE' ? el('p', { class: 'muted', text: 'Crypto isn’t enabled on this Alpaca account (status: ' + a.cryptoStatus + '). Enable it in Alpaca or turn off Crypto above.' }) : null));
  const waiting = v.proposals.filter(p => p.status === 'waiting');
  $('#liveWaiting').replaceChildren(...(waiting.length ? [el('h2', { style: 'margin-top:0', text: `Waiting for your OK (${waiting.length})` }), ...waiting.map(p => el('div', { class: 'approve-card' },
    el('div', { class: 'what' }, el('b', { class: p.side === 'buy' ? 'up' : 'down', text: p.side.toUpperCase() + ' ' }), p.side === 'buy' ? `${money(p.usd, 2)} of ${p.sym}` : `all of Rutherford's ${p.sym}`, el('small', { text: `${v.bot?.name || p.botId}: ${p.reason || ''} · expires ${until(p.t + 600000)}` })),
    el('button', { class: 'btn small', text: 'Approve', onclick: async e => { e.target.disabled = true; try { const r = await api('live/approve', { id: p.id }); toast(r.status === 'filled' ? `Filled at ${money(r.fill.price)}` : `${r.status}: ${r.error || ''}`, r.status !== 'filled' && r.status !== 'sent'); } catch (er) { toast(er.message, true); } loadLive(); } }),
    el('button', { class: 'btn small ghost', text: 'Skip', onclick: async () => { await api('live/skip', { id: p.id }).catch(() => {}); loadLive(); } })))] : []));
  side.append(el('h2', { text: 'Bought by Rutherford' }), v.holdings.length ? el('div', {}, el('div', { class: 'tbl-wrap' }, el('table', {}, el('tr', {}, ['Holding', 'Amount', 'Cost', 'Value', 'P&L'].map((h, i) => el('th', { class: i ? 'r' : '', text: h }))),
    v.holdings.map(h => el('tr', {}, el('td', { text: h.sym + (h.sellAfterToday ? ' (sells tomorrow)' : '') }), el('td', { class: 'r num', text: qty(h.qty) }), el('td', { class: 'r num', text: money(h.cost, 2) }), el('td', { class: 'r num', text: money(h.value, 2) }), el('td', { class: 'r num ' + cls(h.pnl), text: money(h.pnl, 2) }))))),
    el('button', { class: 'btn small ghost', style: 'margin-top:8px', text: 'Sell everything Rutherford bought', onclick: async () => { if (!confirm('Sell all positions Rutherford opened in your Alpaca account?')) return; try { const r = await api('live/closeall', {}); toast(`${r.length} sell orders sent`); } catch (e) { toast(e.message, true); } loadLive(); } }))
    : el('div', { class: 'empty', text: 'Nothing yet. Your own holdings in Alpaca are never touched.' }));
  const hist = v.proposals.filter(p => p.status !== 'waiting');
  $('#liveOrders').replaceChildren(hist.length ? el('div', { class: 'tbl-wrap tall' }, el('table', {}, el('tr', {}, ['When', 'Account', 'Order', 'Status', 'Filled at', 'P&L', 'Note'].map((h, i) => el('th', { class: [4, 5].includes(i) ? 'r' : '', text: h }))),
    hist.map(p => el('tr', {}, el('td', { text: new Date(p.t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) }), el('td', { text: p.target === 'live' ? '💵 real' : '🧪 practice' }),
      el('td', { text: `${p.side} ${p.side === 'buy' && p.usd ? money(p.usd, 2) + ' of ' : ''}${p.sym}` }), el('td', {}, el('span', { class: 'st ' + p.status, text: p.status })),
      el('td', { class: 'r num', text: p.fill ? money(p.fill.price) : '' }), el('td', { class: 'r num ' + cls(p.fill?.pnl), text: p.fill?.pnl != null ? money(p.fill.pnl, 2) : '' }), el('td', { class: 'why', text: p.error || p.reason || '' })))))
    : el('div', { class: 'empty', text: 'No real orders yet.' }));
}

/* ---------- Predictions (Polymarket) ---------- */
function centsOf(p) { return Math.round(p * 100) + '¢'; }
function endsIn(t) { if (!t) return ''; const m = (t - Date.now()) / 60000; return m < 0 ? 'ended' : m < 60 ? `ends in ${Math.round(m)}m` : m < 2880 ? `ends in ${Math.round(m / 60)}h` : 'ends ' + new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
async function loadPm(query) {
  $('#pmList').replaceChildren(el('div', { class: 'empty', text: 'Loading live odds…' }));
  try { S.pmMarkets = query ? await api('pm/search?q=' + encodeURIComponent(query)) : await api('pm/markets?cat=' + S.pmCat); }
  catch (e) { $('#pmList').replaceChildren(el('div', { class: 'empty', text: e.message })); return; }
  renderPm(); loadMyBets(); renderPickRecord();
}
function renderPm() {
  const list = $('#pmList'); list.innerHTML = '';
  if (!S.pmMarkets.length) return list.append(el('div', { class: 'empty', text: S.pmCat === 'quick' ? 'No 15-minute crypto markets found right now. Try Crypto or search "Bitcoin".' : 'No open markets found.' }));
  for (const m of S.pmMarkets.slice(0, 60)) {
    const form = el('div', { class: 'bet-form', hidden: true });
    const card = el('div', { class: 'pm-card' },
      el('div', { class: 'pm-q' }, m.image ? el('img', { src: m.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : null, el('div', {}, el('b', { text: m.question }), el('span', { class: 'muted', text: [m.event && m.event !== m.question ? m.event : '', endsIn(m.end), m.volume24h ? money(m.volume24h, 0) + ' traded today' : ''].filter(Boolean).join(' · ') }))),
      el('div', { class: 'pm-outs' }, m.outcomes.map((o, i) => el('button', { class: 'pm-out' + (i === 0 && m.outcomes.length === 2 ? ' yes' : i === 1 && m.outcomes.length === 2 ? ' no' : '') + (m.pick && m.pick.pickIndex === i ? ' picked' : ''), onclick: () => openBet(form, m, i) }, el('span', { text: o }), el('b', { class: 'num', text: centsOf(m.prices[i]) })))),
      pickBox(m), form);
    list.append(card);
  }
}
function pickBox(m) {
  const box = el('div', { class: 'pick-box' });
  const draw = () => {
    box.innerHTML = '';
    const p = m.pick;
    if (!p) { box.append(el('button', { class: 'ask-pick', text: '🔮 Ask Rutherford', onclick: () => askPick(m, box, draw) })); return; }
    const pr = Math.round(p.probs[p.pickIndex] * 100), mk = Math.round(m.prices[p.pickIndex] * 100);
    // value = the outcome Rutherford thinks is most underpriced (not always the most likely one)
    const edges = m.outcomes.map((o, i) => Math.round(p.probs[i] * 100) - Math.round(m.prices[i] * 100)); const vi = edges.indexOf(Math.max(...edges)); const edge = edges[vi];
    const why = el('div', { class: 'pick-why', hidden: true }, p.summary ? el('div', { text: p.summary }) : null, p.factors?.length ? el('ul', {}, p.factors.map(f => el('li', { text: f }))) : null,
      p.sources?.length ? el('div', {}, p.sources.map(x => el('a', { href: x.url, target: '_blank', rel: 'noopener', text: (() => { try { return new URL(x.url).hostname.replace(/^www\./, ''); } catch { return 'source'; } })() }))) : null,
      el('div', { class: 'muted', style: 'font-size:11.5px;margin-top:4px', text: `Picked ${ago(p.at)}. Odds: ` + m.outcomes.map((o, i) => `${o} ${Math.round(p.probs[i] * 100)}%`).join(' · ') }),
      el('button', { class: 'btn small ghost', style: 'margin-top:6px', text: 'Re-check now', onclick: () => askPick(m, box, draw, true) }));
    box.append(el('div', { class: 'pick-line' }, el('span', { class: 'orb', text: '🔮 Rutherford: ' + p.pick + ' ' + pr + '%' }), el('span', { class: 'conf', text: `market ${mk}¢ · ${p.confidence} confidence` }),
      edge >= 8 ? el('span', { class: 'val', title: `Rutherford thinks "${m.outcomes[vi]}" is ${Math.round(p.probs[vi] * 100)}% likely but it costs ${Math.round(m.prices[vi] * 100)}¢`, text: `value: ${m.outcomes[vi]} +${edge}` }) : null,
      el('span', { class: 'spacer' }), el('button', { class: 'btn small ghost', text: 'Why?', onclick: () => (why.hidden = !why.hidden) })), why);
  };
  draw(); return box;
}
async function askPick(m, box, draw, force = false) {
  box.innerHTML = ''; box.append(el('span', { class: 'muted', text: '🔮 Rutherford is researching (news, stats, injuries)… ~15s' }));
  try { m.pick = await api('pm/pick', { marketId: m.id, force }); } catch (e) { toast(e.message, true); }
  draw(); renderPickRecord();
}
async function renderPickRecord() {
  let d; try { d = await api('pm/picks'); } catch { return; }
  const r = d.record; const box = $('#pickRecord'); box.innerHTML = '';
  box.append(el('span', {}, '🔮 ', el('b', { text: "Rutherford's Picks" })),
    el('span', { text: r.settled ? `${r.right}/${r.settled} right (${r.accuracy}%) · market favorite ${r.marketRight}/${r.settled} (${r.marketAccuracy}%)` : `No finished picks yet` }),
    el('span', { class: 'muted', text: (r.pending ? `${r.pending} waiting on results · ` : '') + r.verdict }), el('span', { class: 'spacer' }),
    el('button', { class: 'btn small ghost', text: 'Pick top 5', title: 'Rutherford researches the 5 biggest markets on screen without a pick', onclick: async e => {
      const btn = e.target; btn.disabled = true;
      const todo = S.pmMarkets.filter(m => !m.pick).slice(0, 5);
      for (let i = 0; i < todo.length; i++) { btn.textContent = `Researching ${i + 1}/${todo.length}…`; try { todo[i].pick = await api('pm/pick', { marketId: todo[i].id }); } catch (er) { toast(er.message, true); break; } renderPm(); }
      btn.disabled = false; btn.textContent = 'Pick top 5'; renderPickRecord();
    } }));
}

function openBet(form, m, i) {
  form.hidden = false; form.innerHTML = '';
  const amt = el('input', { type: 'number', min: '1', step: '1', value: '10' });
  const info = el('span', { class: 'muted num' });
  const upd = () => { const p = Math.min(0.99, m.prices[i] + 0.01), shares = (Number(amt.value) || 0) / p; info.textContent = `≈ ${shares.toFixed(1)} shares → pays ${money(shares, 2)} if "${m.outcomes[i]}"`; };
  amt.oninput = upd; upd();
  form.append(el('span', { text: `Bet on "${m.outcomes[i]}" $` }), amt,
    el('button', { class: 'btn small', text: 'Place paper bet', onclick: async () => { try { const r = await api('pm/bet', { marketId: m.id, outcome: i, usd: Number(amt.value) }); toast(`Bet placed: ${r.bet.outcome} at ${centsOf(r.bet.price)}`); form.hidden = true; loadMyBets(); } catch (e) { toast(e.message, true); } } }),
    el('button', { class: 'btn small ghost', text: 'Cancel', onclick: () => (form.hidden = true) }), info);
  amt.focus();
}
function betTable(bets, mine) {
  return el('div', { class: 'tbl-wrap' }, el('table', {}, el('tr', {}, ['Market', 'Pick', 'Paid', 'Stake', 'Now', 'Result', ''].map((h, i) => el('th', { class: [2, 3, 4, 5].includes(i) ? 'r' : '', text: h }))),
    bets.map(b => el('tr', {}, el('td', { class: 'what', title: b.question }, b.url ? el('a', { href: b.url, target: '_blank', rel: 'noopener', text: b.question }) : b.question), el('td', { text: b.outcome }), el('td', { class: 'r num', text: centsOf(b.price) }), el('td', { class: 'r num', text: money(b.cost, 2) }),
      el('td', { class: 'r num', text: b.nowPrice != null ? centsOf(b.nowPrice) : b.status === 'open' ? endsIn(b.end) : '' }),
      el('td', { class: 'r num ' + cls(b.pnl), text: b.status === 'open' ? (b.nowPrice != null ? pct((b.nowPrice / b.price - 1) * 100) : 'open') : `${b.status} ${money(b.pnl, 2)}` }),
      el('td', {}, mine && b.status === 'open' ? el('button', { class: 'btn small ghost', text: 'Cash out', onclick: async () => { if (!confirm('Sell this bet at the current price?')) return; try { const r = await api('pm/sell', { betId: b.id }); toast(`Cashed out: ${money(r.bet.pnl, 2)}`); loadMyBets(); if (S.tab === 'portfolio') loadPortfolio(); } catch (e) { toast(e.message, true); } } }) : null)))));
}
async function loadMyBets() {
  try { const pf = await api('portfolio'); const open = pf.bets.filter(b => b.status === 'open'); $('#myBets').replaceChildren(open.length ? el('div', {}, el('h2', { text: `Your open bets (${open.length})` }), betTable(open, true)) : ''); } catch {}
}

async function loadClock() {
  try { S.clock = await api('clock'); const st = $('#marketStatus'); st.textContent = 'Stocks ' + (S.clock.open ? 'open' : 'closed') + (S.clock.dataSource === 'alpaca' ? ' · Alpaca' : ' · Yahoo'); st.className = 'pill-status ' + (S.clock.open ? 'open' : ''); } catch {}
}

/* ---------- Tabs + boot ---------- */
function show(tab) {
  S.tab = tab;
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  document.querySelectorAll('.view').forEach(v => (v.hidden = v.id !== tab));
  if (tab === 'portfolio') loadPortfolio();
  if (tab === 'forecasts') loadForecasts();
  if (tab === 'ask') { renderAskEmpty(); $('#askInput').focus(); }
  if (tab === 'markets') { renderGrid(); loadClock(); }
  if (tab === 'bots') loadArena();
  if (tab === 'predictions') loadPm();
  if (tab === 'live') { (S.arena ? Promise.resolve() : loadArena()).then(loadLive); }
}

async function boot() {
  // Running inside Rutherford: add a "back to chat" button for phones (desktop uses Rutherford's side rail)
  if (window.top !== window) {
    document.body.classList.add('embedded');
    $('.top').prepend(el('button', { class: 'back-chat', 'aria-label': 'Back to Rutherford chat', text: '‹ Chat', onclick: () => parent.postMessage({ rutherford: 'switch', app: 'chat' }, location.origin) }));
  }
  document.querySelectorAll('#tabs button').forEach(b => (b.onclick = () => show(b.dataset.tab)));
  $('#settingsBtn').onclick = openSettings;
  $('#addPair').onsubmit = async e => { e.preventDefault(); const v = $('#pairInput').value.trim().toUpperCase(); if (!v) return; const pair = v.includes('-') ? v : v + '-USD'; try { await api('watchlist', { add: pair }); $('#pairInput').value = ''; toast('Added ' + pair); loadQuotes(); } catch (er) { toast(er.message, true); } };
  $('#resetBtn').onclick = async () => { const v = prompt('Start over with how much paper cash?', '1000'); if (!v) return; try { await api('portfolio/reset', { cash: Number(v) }); toast('Portfolio reset'); loadPortfolio(); } catch (e) { toast(e.message, true); } };
  $('#runBtn').onclick = async () => { const b = $('#runBtn'); b.disabled = true; b.textContent = 'Running…'; try { const r = await api('forecast/run', {}); toast(`Locked ${r.created} calls` + (r.errors.length ? ` (${r.errors.length} pairs failed)` : '')); loadForecasts(); } catch (e) { toast(e.message, true); } b.disabled = false; b.textContent = 'Run all strategies now'; };
  $('#autoToggle').onchange = async e => { S.settings = await api('settings', { autoForecast: e.target.checked }); toast(e.target.checked ? 'Auto-forecasting on' : 'Auto-forecasting off'); };
  $('#autoEvery').onchange = async e => { S.settings = await api('settings', { autoEveryMin: Number(e.target.value) }); };
  $('#clearForecasts').onclick = async () => { if (confirm('Delete ALL forecast history and scores?')) { await api('forecast/clear', {}); loadForecasts(); } };
  $('#saveKey').onclick = async () => { try { S.settings = await api('settings', { groqKey: $('#keyInput').value, model: $('#modelInput').value.trim() || undefined }); $('#keyStatus').textContent = 'Saved ✓'; } catch (e) { toast(e.message, true); } };
  $('#killBtn').onclick = async () => { if (!confirm('Stop ALL real trading now? Waiting orders are skipped and Rutherford\u2019s open orders are canceled. Positions stay as they are.')) return; try { const r = await api('live/kill', {}); toast('Real trading stopped' + (r.cancelled.length ? `, ${r.cancelled.length} orders canceled` : '')); } catch (e) { toast(e.message, true); } loadLive(); };
  $('#saveAlpaca').onclick = async () => {
    try {
      S.settings = await api('settings', { alpacaKeyId: $('#alpacaId').value, ...($('#alpacaSecret').value ? { alpacaSecret: $('#alpacaSecret').value } : {}) });
      $('#alpacaStatus').textContent = 'Testing…'; const t = await api('alpaca/test', {}); $('#alpacaStatus').textContent = `Connected ✓ (SPY $${t.spy})`; $('#alpacaSecret').value = '';
    } catch (e) { $('#alpacaStatus').textContent = e.message; }
  };
  const setNum = (id, key) => ($(id).onchange = async e => { try { S.settings = await api('settings', { [key]: Number(e.target.value) }); toast('Saved'); } catch (er) { toast(er.message, true); } });
  setNum('#botEvery', 'botEveryMin'); setNum('#aiEvery', 'aiEveryMin'); setNum('#evolveEvery', 'evolveHours');
  $('#botsPm').onchange = async e => { S.settings = await api('settings', { botsUsePolymarket: e.target.checked }); };
  $('#resetArena').onclick = async () => { if (!confirm(`Restart the arena? All 4 bots go back to $${$('#arenaCash').value} and forget what they learned.`)) return; try { S.arena = await api('arena/reset', { cash: Number($('#arenaCash').value) }); toast('Arena restarted'); $('#settingsDlg').close(); show('bots'); } catch (e) { toast(e.message, true); } };
  $('#arenaToggle').onchange = async e => { S.settings = await api('settings', { arenaOn: e.target.checked }); toast(e.target.checked ? 'Bots are on' : 'Bots paused'); loadArena(); };
  $('#tickBtn').onclick = async () => { const b = $('#tickBtn'); b.disabled = true; b.textContent = 'Bots thinking…'; try { const r = await api('arena/tick', {}); S.arena = r.view; renderArena(); const n = Object.values(r.actions || {}).reduce((a, x) => a + x, 0); toast(n ? `${n} trades/bets made` : 'Bots looked and decided to wait'); } catch (e) { toast(e.message, true); } b.disabled = false; b.textContent = 'Run bots now'; };
  $('#evolveBtn').onclick = async () => { try { const r = await api('arena/evolve', {}); S.arena = r.view; renderArena(); toast(r.result ? 'A bot learned something, see the log' : 'No clear leader yet'); } catch (e) { toast(e.message, true); } };
  document.querySelectorAll('#pmCats button').forEach(b => (b.onclick = () => { S.pmCat = b.dataset.cat; $('#pmQ').value = ''; document.querySelectorAll('#pmCats button').forEach(x => x.classList.toggle('on', x === b)); loadPm(); }));
  $('#pmSearch').onsubmit = e => { e.preventDefault(); const q = $('#pmQ').value.trim(); if (q) { document.querySelectorAll('#pmCats button').forEach(x => x.classList.remove('on')); loadPm(q); } };
  $('#saveRules').onclick = async () => { try { S.settings = await api('settings', { stockFeePct: $('#stockFeeInput').value, feePct: $('#feeInput').value, maxPositionPct: $('#maxPosInput').value, model: $('#modelInput').value.trim() || undefined }); toast('Saved'); } catch (e) { toast(e.message, true); } };
  $('#askForm').onsubmit = e => { e.preventDefault(); if (S.asking) S.asking.abort(); else askSend(); };
  $('#askInput').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && innerWidth > 640) { e.preventDefault(); askSend(); } };

  const st = await api('state');
  Object.assign(S, { settings: st.settings, strategies: st.strategies, horizons: st.horizons });
  $('#aboutLine').textContent = `Rutherford Alpha ${st.version} · data saved in ${st.dataDir}`;
  show('bots'); loadQuotes();
  setInterval(() => { if (document.hidden) return; if (S.tab === 'markets') loadQuotes(); if (S.tab === 'forecasts') loadForecasts(); if (S.tab === 'bots') loadArena(); }, 30000);
  setInterval(() => { if (!document.hidden && S.tab === 'live') loadLive(); }, 10000);
  const pollPending = () => api('live/pending').then(r => { setMoneyBadge(r.state); const t = document.querySelector('#tabs [data-tab="live"]'); t.textContent = r.waiting ? `Real $ (${r.waiting})` : 'Real $'; t.classList.toggle('has-waiting', !!r.waiting); }).catch(() => {});
  pollPending(); setInterval(() => { if (!document.hidden) pollPending(); }, 15000);
  addEventListener('resize', () => { if (S.tab === 'markets') renderGrid(); });
}
boot();

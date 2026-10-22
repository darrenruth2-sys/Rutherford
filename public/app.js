'use strict';
/* Rutherford front end. One chat, tools happen inside it. */
const $ = s => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v; else if (k === 'text') n.textContent = v; else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
};
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LOGO = 'rutherford-neon-r.png';

const S = { settings: {}, project: { open: false }, convos: [], convo: null, streaming: null, attachments: [], panel: { tabs: [], active: null }, models: [] };

async function api(path, body) {
  const res = await fetch('/api/' + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Error(data.error || 'Request failed (' + res.status + ')');
  return data;
}

function toast(msg, bad = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), bad ? 5000 : 2600);
}

/* ---------------- Markdown ---------------- */
const mdRenderer = new marked.Renderer();
mdRenderer.code = (code, lang) => {
  const raw = typeof code === 'object' ? code.text : code; lang = (typeof code === 'object' ? code.lang : lang) || '';
  const l = lang.split(/\s/)[0].toLowerCase();
  let html;
  try { html = l && hljs.getLanguage(l) ? hljs.highlight(raw, { language: l }).value : hljs.highlightAuto(raw).value; } catch { html = esc(raw); }
  const canPreview = ['html', 'svg', 'xml'].includes(l) && /<(html|body|div|svg|canvas|!doctype)/i.test(raw);
  return `<div class="code" data-lang="${esc(l)}"><div class="code-head"><span>${esc(l || 'code')}</span><span class="spacer"></span>${canPreview ? '<button data-act="preview">Preview</button>' : ''}<button data-act="copy">Copy</button></div><pre><code class="hljs">${html}</code></pre><textarea hidden>${esc(raw)}</textarea></div>`;
};
marked.setOptions({ gfm: true, breaks: false, renderer: mdRenderer });

// Protect LaTeX from the markdown parser, then render with KaTeX.
function renderMd(target, text, streaming = false) {
  const maths = [];
  let src = String(text || '').replace(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)|(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|(?<![\\$\w])\$(?!\s)[^$\n]+?(?<!\s)\$(?!\w))/g, (m, code, math) => {
    if (code) return code; maths.push(math); return '@@MATH' + (maths.length - 1) + '@@';
  });
  let html = DOMPurify.sanitize(marked.parse(src), { ADD_ATTR: ['data-act', 'data-lang', 'target'] });
  html = html.replace(/@@MATH(\d+)@@/g, (_, i) => {
    const m = maths[i]; const display = m.startsWith('$$') || m.startsWith('\\[');
    const body = m.replace(/^\$\$|\$\$$|^\\\[|\\\]$|^\\\(|\\\)$|^\$|\$$/g, '');
    try { return katex.renderToString(body, { displayMode: display, throwOnError: false }); } catch { return esc(m); }
  });
  target.innerHTML = html;
  target.querySelectorAll('a[href^="http"]').forEach(a => { a.target = '_blank'; a.rel = 'noopener'; });
  if (streaming) {
    const last = [...target.querySelectorAll('p, li, pre code, td, h1, h2, h3, h4')].pop() || target;
    last.classList.add('cursor');
  }
}

document.addEventListener('click', e => {
  const b = e.target.closest('.code-head button'); if (!b) return;
  const raw = b.closest('.code').querySelector('textarea').value;
  if (b.dataset.act === 'copy') { copy(raw); b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 1400); }
  if (b.dataset.act === 'preview') openPreview({ title: 'Code preview', html: raw });
});
function copy(text) { navigator.clipboard?.writeText(text).then(() => toast('Copied'), () => toast('Copy failed', true)); }

/* ---------------- Sidebar ---------------- */
function groupLabel(iso) {
  const d = new Date(iso), now = new Date(); const day = 864e5;
  const diff = (new Date(now.toDateString()) - new Date(d.toDateString())) / day;
  return diff <= 0 ? 'Today' : diff === 1 ? 'Yesterday' : diff < 7 ? 'This week' : diff < 31 ? 'This month' : 'Older';
}
function renderSidebar() {
  const list = $('#convoList'); list.innerHTML = '';
  if (!S.convos.length) { list.append(el('div', { class: 'convo-group', text: $('#searchChats').value ? 'No matches' : 'No chats yet' })); return; }
  let group = null;
  for (const c of S.convos) {
    const g = c.pinned ? 'Pinned' : groupLabel(c.updated);
    if (g !== group) { list.append(el('div', { class: 'convo-group', text: g })); group = g; }
    list.append(el('div', { class: 'convo' + (S.convo?.id === c.id ? ' active' : '') },
      el('a', { href: '#' + c.id, title: c.title, text: c.title, onclick: e => { e.preventDefault(); openConvo(c.id); } }),
      el('span', { class: 'acts' },
        el('button', { title: c.pinned ? 'Unpin' : 'Pin', text: c.pinned ? '★' : '☆', onclick: () => api('convo/pin', { id: c.id, pinned: !c.pinned }).then(refreshList) }),
        el('button', { title: 'Rename', text: '✎', onclick: () => { const t = prompt('Rename chat', c.title); if (t?.trim()) api('convo/rename', { id: c.id, title: t }).then(refreshList); } }),
        el('button', { title: 'Delete', text: '🗑', onclick: () => { if (confirm('Delete "' + c.title + '"?')) api('convo/delete', { id: c.id }).then(() => { if (S.convo?.id === c.id) newChat(); refreshList(); }); } }))));
  }
}
async function refreshList() { S.convos = await api('convos?q=' + encodeURIComponent($('#searchChats').value)); renderSidebar(); }

/* ---------------- Thread ---------------- */
function newChat() {
  if (S.streaming) return toast('Wait for the answer to finish (or press stop)');
  S.convo = null; location.hash = ''; renderThread(); renderSidebar(); closeSidebar(); $('#input').focus();
}
async function openConvo(id) {
  if (S.streaming) return toast('Wait for the answer to finish (or press stop)');
  try { S.convo = await api('convo?id=' + id); } catch (e) { toast(e.message, true); return newChat(); }
  location.hash = id; renderThread(); renderSidebar(); closeSidebar(); scrollDown(true);
}

function renderThread() {
  const t = $('#thread'); t.innerHTML = '';
  if (!S.convo || !S.convo.messages.length) return t.append(renderHello());
  S.convo.messages.forEach((m, i) => t.append(m.role === 'user' ? renderUser(m) : renderAI(m, i === S.convo.messages.length - 1)));
}

function renderHello() {
  const starters = [
    ['Homework help', 'Walk me through this problem step by step: ', 'Paste or attach your question'],
    ['Explain some code', 'Explain what this code does, line by line:\n\n', 'Paste code or open a project'],
    ['Build a web page', 'Build me a one-page website for ', 'Get a live preview you can download'],
    ['Fix a bug', 'I have a bug. Here is the error message:\n\n', 'Open your project folder first']
  ];
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Morning' : hour < 18 ? 'Afternoon' : 'Evening';
  return el('div', { class: 'hello' },
    el('img', { src: LOGO, alt: '' }),
    el('h1', { text: `${greet}${S.settings.userName ? ', ' + S.settings.userName : ''}. What are we working on?` }),
    !S.anyKey && el('div', { class: 'setup' },
      el('h3', { text: 'One-time setup: add a free AI key' }),
      el('p', { html: 'Get a free key from <a href="https://console.groq.com/keys" target="_blank" rel="noopener">Groq</a> or <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google Gemini</a> (no credit card), then paste it here. You can add more later in Settings.' }),
      el('div', { class: 'row' }, el('select', { id: 'setupProv', style: 'flex:none;width:auto' }, el('option', { value: 'groq', text: 'Groq' }), el('option', { value: 'gemini', text: 'Gemini' }), el('option', { value: 'nvidia', text: 'NVIDIA' }), el('option', { value: 'openrouter', text: 'OpenRouter' })),
        el('input', { id: 'setupKey', type: 'password', placeholder: 'Paste key' }),
        el('button', { class: 'btn', text: 'Save key', onclick: async () => { await saveBrainKey($('#setupProv').value, $('#setupKey').value); renderThread(); } }))),
    el('div', { class: 'starters' }, starters.map(([b, fill, sub]) => el('button', { class: 'starter', onclick: () => { setInput(fill); } }, el('b', { text: b }), sub))));
}

function renderUser(m) {
  const files = [...(m.images || []).map(id => el('img', { src: '/api/image/' + id, alt: 'attached image', onclick: () => lightbox('/api/image/' + id) })),
    ...(m.attachments || []).map(a => el('span', { class: 'file-pill', text: '📄 ' + a.name }))];
  return el('div', { class: 'msg user' }, files.length ? el('div', { class: 'files' }, files) : null, m.content ? el('div', { class: 'bubble', text: m.content }) : null,
    el('div', { class: 'msg-actions' }, el('button', { text: 'Copy', onclick: () => copy(m.content) }), el('button', { text: 'Edit', onclick: () => setInput(m.content) })));
}

function aiShell() {
  const body = el('div', { class: 'md' });
  const wrap = el('div', { class: 'msg ai' }, el('div', { class: 'ai-head' }, el('img', { src: LOGO, alt: '' }), el('span', { text: 'Rutherford' })),
    el('div', { class: 'steps' }), body, el('div', { class: 'extras' }), el('div', { class: 'msg-actions' }));
  return { wrap, body, steps: wrap.querySelector('.steps'), extras: wrap.querySelector('.extras'), actions: wrap.querySelector('.msg-actions') };
}

function renderAI(m, isLast) {
  const v = aiShell();
  for (const s of m.steps || []) v.steps.append(stepRow(s.label, s.ok ? 'ok' : 'fail'));
  for (const c of m.changes || []) v.extras.append(changeCard(c));
  if (m.preview) v.extras.append(previewCard(m.preview));
  for (const g of m.generated || []) v.extras.append(imageCard(g));
  for (const c of m.codeRuns || []) v.extras.append(codeRunCard(c));
  if (m.plan) v.extras.prepend(planCard(m.plan));
  for (const c of m.commands || []) v.extras.append(commandCard(c));
  for (const sh of m.shots || []) v.extras.append(shotCard(sh));
  if (m.review) v.extras.append(reviewCard(m.review));
  if (m.provider) v.wrap.querySelector('.ai-head').title = 'Brain: ' + m.provider + ' · ' + (m.model || '');
  if (m.think || m.build) v.wrap.querySelector('.ai-head span').textContent = 'Rutherford' + (m.build ? ' · build' : '') + (m.think ? ' · thought hard' : '');
  if (m.sources?.length) v.extras.append(sourcesRow(m.sources));
  renderMd(v.body, m.content);
  fillActions(v.actions, m, isLast);
  return v.wrap;
}
function fillActions(box, m, isLast) {
  box.innerHTML = '';
  box.append(el('button', { text: 'Copy', onclick: () => copy(m.content) }));
  if (isLast) box.append(el('button', { text: 'Retry', title: 'Ask again for a new answer', onclick: () => send({ regenerate: true }) }));
  if (m.model) box.append(el('button', { class: 'brain-info', text: 'ⓘ', title: 'Answered by ' + (m.provider || '') + ' · ' + m.model, onclick: () => toast('Answered by ' + (m.provider || '') + ' · ' + m.model) }));
}

const stepRow = (label, state) => el('div', { class: 'step ' + state }, el('span', { class: 'dot' }), el('span', { text: label }));

/* Change cards: proposed code edits */
function diffView(rows) {
  const box = el('div', { class: 'diff' });
  for (const r of rows || []) {
    if (r.t === '…') { box.append(el('div', { class: 'gap', text: '⋯' })); continue; }
    box.append(el('div', { class: r.t === '+' ? 'add' : r.t === '-' ? 'del' : 'ctx' }, el('span', { class: 'ln', text: r.t === '+' ? r.b : r.a }), el('span', { class: 't', text: r.text })));
  }
  return box;
}
const changeCards = new Map();
function changeCard(c) {
  const card = el('div', { class: 'card' });
  card.setStatus = (status, checkpoint) => { c.status = status; if (checkpoint) c.checkpoint = checkpoint; draw(); };
  changeCards.set(c.id, card);
  const draw = () => {
    card.innerHTML = '';
    const status = c.status || 'pending';
    card.append(el('div', { class: 'card-head' },
      el('span', { class: 'title', text: (c.isNew ? '＋ ' : '✎ ') + c.path }),
      c.added != null && el('span', { class: 'badge add', text: '+' + c.added }), c.removed != null && el('span', { class: 'badge del', text: '−' + c.removed }),
      status !== 'pending' && el('span', { class: 'badge ' + status, text: status }),
      c.summary && el('span', { class: 'sub', text: c.summary })));
    if (status === 'pending') {
      const diffSlot = el('div');
      if (c.diff) diffSlot.append(diffView(c.diff));
      else api('change?id=' + c.id).then(full => { Object.assign(c, full); diffSlot.append(diffView(full.diff)); }).catch(() => { c.status = 'expired'; draw(); });
      card.append(diffSlot, el('div', { class: 'card-acts' },
        el('button', { class: 'btn small', text: 'Apply', onclick: async () => { try { const r = await api('change/approve', { id: c.id, convoId: S.convo?.id }); c.status = 'applied'; c.checkpoint = r.checkpoint; toast('Applied to ' + c.path); draw(); } catch (e) { toast(e.message, true); } } }),
        el('button', { class: 'btn small ghost', text: 'Reject', onclick: async () => { await api('change/reject', { id: c.id, convoId: S.convo?.id }).catch(() => {}); c.status = 'rejected'; draw(); } }),
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn small ghost', text: 'Full view', onclick: () => openPanel('change:' + c.id, '✎ ' + c.path.split('/').pop(), () => diffView(c.diff)) })));
    } else if (status === 'merged') {
      card.append(el('p', { class: 'hint', text: 'Combined into the newer change below.' }));
    } else if (status === 'applied' && c.checkpoint) {
      card.append(el('div', { class: 'card-acts' }, el('button', { class: 'btn small ghost', text: 'Undo', onclick: async () => { try { await api('undo', { checkpoint: c.checkpoint, convoId: S.convo?.id }); c.status = 'undone'; toast('Undone'); draw(); } catch (e) { toast(e.message, true); } } })));
    }
  };
  draw(); return card;
}

function imageCard(g) {
  const src = '/api/image/' + g.id;
  return el('figure', { class: 'gen-img' }, el('img', { src, alt: g.prompt, loading: 'lazy', onclick: () => lightbox(src) }),
    el('figcaption', {}, el('span', { text: g.prompt }), el('a', { class: 'btn small ghost', href: src, download: 'rutherford-image.' + g.id.split('.').pop(), text: 'Download' })));
}
function codeRunCard(c) {
  const d = el('details', { class: 'code-run' + (c.ok ? '' : ' bad') }, el('summary', { text: (c.ok ? 'Ran code' : 'Ran code (error)') + ' · ' + (c.output || '').split('\n')[0].slice(0, 80) }));
  let html; try { html = hljs.highlight(c.code, { language: 'javascript' }).value; } catch { html = esc(c.code); }
  d.append(el('pre', {}, el('code', { class: 'hljs', html })), el('div', { class: 'run-out-label', text: 'Output' }), el('pre', { class: 'run-out', text: c.output }));
  return d;
}
function approvalCard(ev) {
  const card = el('div', { class: 'card approval waiting', 'data-approval': ev.id });
  const answer = async (allow, always) => {
    card.querySelectorAll('button').forEach(b => (b.disabled = true));
    try { await api('approval', { id: ev.id, allow, always }); card.classList.remove('waiting'); card.innerHTML = ''; card.append(el('div', { class: 'card-head' }, el('span', { class: 'title', text: (allow ? '▶ Running ' : '✋ Skipped ') + ev.command }))); if (!allow) card.classList.add('denied'); }
    catch (e) { toast(e.message, true); card.remove(); }
  };
  card.append(...[el('div', { class: 'card-head' }, el('span', { class: 'title', text: 'Rutherford wants to run a command' })),
    el('pre', { class: 'cmd-line', text: '> ' + ev.command }),
    ev.why ? el('p', { class: 'hint', text: ev.why }) : null,
    ev.pending?.length ? el('p', { class: 'hint warn', text: `This also applies the ${ev.pending.length} pending change${ev.pending.length > 1 ? 's' : ''} first: ${ev.pending.join(', ')}` }) : null,
    el('div', { class: 'card-acts' },
      el('button', { class: 'btn small', text: 'Allow', onclick: () => answer(true, false) }),
      el('button', { class: 'btn small ghost', text: 'Allow all in this chat', title: 'Stop asking for the rest of this chat', onclick: () => answer(true, true) }),
      el('span', { class: 'spacer' }),
      el('button', { class: 'btn small ghost', text: "Don't run", onclick: () => answer(false, false) }))].filter(Boolean));
  return card;
}
function commandCard(c) {
  const state = c.denied ? 'denied' : c.ok ? 'ok' : 'bad';
  const head = c.denied ? 'Skipped' : c.ok ? 'Ran' : c.timedOut ? 'Stopped' : 'Failed (exit ' + c.exitCode + ')';
  const d = el('details', { class: 'term ' + state, open: !c.ok && !c.denied ? true : null },
    el('summary', {}, el('span', { class: 'term-state', text: head }), el('code', { text: c.command }), c.ms != null ? el('span', { class: 'hint', text: ' · ' + (c.ms / 1000).toFixed(1) + 's' }) : null));
  if (!c.denied) d.append(el('pre', { class: 'term-out', text: c.output || '(no output)' }));
  return d;
}
function planCard(p) {
  const done = p.steps.filter(s => s.status === 'done').length;
  const icon = { todo: '○', doing: '◐', done: '●', skipped: '–' };
  return el('div', { class: 'card plan-card' },
    el('div', { class: 'card-head' }, el('span', { class: 'title', text: '🔨 ' + (p.goal || 'Build plan') }), el('span', { class: 'badge', text: `${done}/${p.steps.length}` })),
    el('div', { class: 'plan-bar' }, el('i', { style: `width:${Math.round(done / Math.max(1, p.steps.length) * 100)}%` })),
    el('ol', { class: 'plan-steps' }, ...p.steps.map(s => el('li', { class: s.status }, el('span', { class: 'pi', text: icon[s.status] || '○' }), el('span', { text: s.text }), s.note ? el('span', { class: 'hint', text: ' · ' + s.note }) : null))));
}
function shotCard(sh) {
  const src = '/api/image/' + sh.id;
  return el('div', { class: 'card shot' },
    el('img', { src, alt: 'Screenshot of ' + sh.target, loading: 'lazy', onclick: () => lightbox(src) }),
    el('div', { class: 'shot-meta' },
      el('b', { text: '👁 Looked at ' + sh.target }),
      sh.errors?.length ? el('div', { class: 'shot-err', text: sh.errors.length + ' JavaScript error' + (sh.errors.length > 1 ? 's' : '') + ': ' + sh.errors[0] }) : el('div', { class: 'hint', text: 'No JavaScript errors' }),
      sh.notes?.length ? el('div', { class: 'hint', text: sh.notes.join(' · ') }) : null,
      sh.seen ? el('details', {}, el('summary', { text: 'What it saw' }), el('p', { class: 'hint', text: sh.seen })) : null));
}
function reviewCard(r) {
  if (r.ok) return el('p', { class: 'sys-note', text: '✓ Second opinion: no problems found' });
  const c = el('div', { class: 'card review-card' }, el('div', { class: 'card-head' }, el('span', { class: 'title', text: '🔍 Second opinion flagged' })));
  const b = el('div', { class: 'md' }); renderMd(b, r.text); c.append(b); return c;
}
function sourcesRow(sources) {
  const row = el('div', { class: 'sources' }, el('span', { class: 'src-lbl', text: 'Sources' }));
  for (const s of sources.slice(0, 12)) { let host = ''; try { host = new URL(s.url).hostname.replace(/^www\./, ''); } catch {} row.append(el('a', { class: 'src', href: s.url, target: '_blank', rel: 'noopener', title: s.title + '\n' + s.url, text: host || s.title })); }
  return row;
}
function previewCard(p) {
  return el('div', { class: 'card' }, el('div', { class: 'preview-card' }, el('div', { class: 'ico', text: '◳' }),
    el('div', { class: 'meta' }, el('b', { text: p.title }), el('span', { text: 'Live preview' })),
    el('button', { class: 'btn small', text: 'Open', onclick: () => openPreview(p) }),
    el('button', { class: 'btn small ghost', text: 'Download', onclick: () => download(p) })));
}
function download(p) {
  const a = el('a', { href: URL.createObjectURL(new Blob([p.html], { type: 'text/html' })), download: (p.title || 'page').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() + '.html' });
  document.body.append(a); a.click(); a.remove();
}

/* ---------------- Sending + streaming ---------------- */
function setInput(text) { const i = $('#input'); i.value = text; autosize(); i.focus(); i.setSelectionRange(text.length, text.length); updateSend(); }
function autosize() { const i = $('#input'); i.style.height = 'auto'; i.style.height = Math.min(i.scrollHeight, innerHeight * .4) + 'px'; }
function updateSend() {
  const b = $('#sendBtn');
  if (S.streaming) { b.disabled = false; b.classList.add('stop'); b.textContent = '■'; b.setAttribute('aria-label', 'Stop'); return; }
  b.classList.remove('stop'); b.textContent = '↑'; b.setAttribute('aria-label', 'Send');
  b.disabled = !($('#input').value.trim() || S.attachments.length) || S.attachments.some(a => a.busy);
}
function nearBottom() { const s = $('#scroller'); return s.scrollHeight - s.scrollTop - s.clientHeight < 140; }
function scrollDown(force) { const s = $('#scroller'); if (force || nearBottom()) s.scrollTop = s.scrollHeight; }

async function send({ regenerate = false } = {}) {
  if (S.streaming) return;
  const text = $('#input').value;
  if (!regenerate && !text.trim() && !S.attachments.length) return;
  if (!S.anyKey) { openSettings(); return toast('Add a free AI key first', true); }
  const atts = S.attachments.filter(a => !a.busy);
  const body = { convoId: S.convo?.id, text, regenerate, think: !!S.think, build: !!S.build,
    attachments: atts.filter(a => a.kind === 'text').map(a => ({ name: a.name, text: a.text })),
    images: atts.filter(a => a.kind === 'image').flatMap(a => a.images) };
  if (!regenerate) { $('#input').value = ''; S.attachments = []; renderAttachments(); autosize(); }

  const t = $('#thread');
  if (!S.convo || !S.convo.messages.length) t.innerHTML = '';
  if (regenerate) { while (t.lastElementChild?.classList.contains('ai')) t.lastElementChild.remove(); S.convo.messages = S.convo.messages.filter((m, i, arr) => !(m.role === 'assistant' && arr.slice(i).every(x => x.role === 'assistant'))); }
  const v = aiShell();
  const thinking = el('div', { class: 'thinking' }, el('i'), el('i'), el('i'), el('span', { text: 'Thinking' }));
  v.body.append(thinking);
  let pendingUser = null;
  if (!regenerate) { pendingUser = renderUser({ content: text, attachments: body.attachments, images: [] }); t.append(pendingUser); }
  t.append(v.wrap); scrollDown(true);

  const ac = new AbortController();
  S.streaming = { ac }; updateSend(); $('#resumeRow').hidden = true;
  let full = '', raf = 0; const stepEls = {}; const sourcesAcc = [];
  const paint = () => { raf = 0; const stick = nearBottom(); renderMd(v.body, full, true); if (stick) scrollDown(true); };
  const handle = ev => { const stick = nearBottom(); handleInner(ev); if (stick) scrollDown(true); };
  const handleInner = ev => {
    switch (ev.type) {
      case 'start':
        if (!S.convo || S.convo.id !== ev.convo.id) { S.convo = { id: ev.convo.id, title: ev.convo.title, messages: [] }; location.hash = ev.convo.id; }
        if (!regenerate) { S.convo.messages.push(ev.user); const fresh = renderUser(ev.user); pendingUser.replaceWith(fresh); }
        refreshList(); break;
      case 'thinking': break;
      case 'text': thinking.remove(); full += ev.delta; if (!raf) raf = requestAnimationFrame(paint); break;
      case 'tool': thinking.remove(); stepEls[ev.id] = stepRow(toolLabel(ev), 'run'); v.steps.append(stepEls[ev.id]); scrollDown(); break;
      case 'tool_result': { const r = stepEls[ev.id]; if (r) { r.className = 'step ' + (ev.ok ? 'ok' : 'fail'); r.lastChild.textContent = ev.label; } break; }
      case 'change': v.extras.append(changeCard(ev.change)); scrollDown(); break;
      case 'preview': v.extras.append(previewCard(ev)); openPreview(ev); break;
      case 'image': v.extras.append(imageCard(ev)); break;
      case 'brain': v.wrap.querySelector('.ai-head').title = 'Brain: ' + ev.name + ' · ' + ev.model; if (S.think || body.build) v.wrap.querySelector('.ai-head span').textContent = 'Rutherford' + (body.build ? ' · building' : '') + (S.think ? ' · thinking hard' : ''); break;
      case 'brain_switch': v.steps.append(stepRow('Switched to a backup brain (free limit hit)', 'ok')); break;
      case 'code': v.extras.append(codeRunCard(ev)); break;
      case 'approval': v.extras.append(approvalCard(ev)); scrollDown(true); break;
      case 'approval_done': { const c = v.extras.querySelector(`[data-approval="${ev.id}"]`); if (c) c.replaceWith(el('p', { class: 'sys-note', text: 'Command request ' + (ev.reason || 'expired') })); break; }
      case 'command': v.extras.querySelectorAll('.approval:not(.denied)').forEach(c => c.remove()); v.extras.append(commandCard(ev)); break;
      case 'change_status': { const card = changeCards.get(ev.id); if (card) card.setStatus(ev.status, ev.checkpoint); break; }
      case 'plan': { const old = v.extras.querySelector('.plan-card'); const c = planCard(ev.plan); if (old) old.replaceWith(c); else v.extras.prepend(c); if (S.project.open) S.project.plan = { goal: ev.plan.goal, left: ev.plan.steps.filter(x => x.status === 'todo' || x.status === 'doing').length, total: ev.plan.steps.length }; break; }
      case 'shot': v.extras.append(shotCard(ev)); break;
      case 'review': v.extras.append(reviewCard(ev)); break;
      case 'savepoint': v.extras.append(el('p', { class: 'sys-note', text: '⏱ ' + ev.message.replace(/^Save point: /, 'Save point: ') })); break;
      case 'note': v.extras.append(el('p', { class: 'sys-note', text: ev.text })); break;
      case 'sources': { sourcesAcc.push(...ev.sources.filter(x => !sourcesAcc.some(y => y.url === x.url))); v.extras.querySelector('.sources')?.remove(); v.extras.append(sourcesRow(sourcesAcc)); break; }
      case 'memory': v.extras.prepend(el('p', { class: 'mem-note', text: 'Saved to memory: ' + ev.line })); break;
      case 'done': {
        cancelAnimationFrame(raf);
        S.convo?.messages.push(ev.message);
        renderMd(v.body, ev.message.content);
        if (!ev.message.content && !ev.message.steps?.length) v.body.textContent = '(No answer came back. Try Retry.)';
        // re-bind change cards to the saved message objects so status edits persist in memory
        fillActions(v.actions, ev.message, true); break;
      }
      case 'error': {
        cancelAnimationFrame(raf); thinking.remove();
        if (full) renderMd(v.body, full);
        if (ev.message !== 'Stopped.') {
          const box = el('div', { class: 'err-box' }, el('div', { text: ev.message }));
          if (ev.code === 'nokey' || /api key/i.test(ev.message)) box.append(el('button', { class: 'btn small', text: 'Open settings', onclick: openSettings }));
          else box.append(el('button', { class: 'btn small ghost', text: 'Try again', onclick: () => send({ regenerate: true }) }));
          v.body.after(box);
        }
        if (full) S.convo?.messages.push({ role: 'assistant', content: full });
        break;
      }
    }
  };
  try {
    const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal });
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw Error(j.error || 'Request failed'); }
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf('\n\n')) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2); if (chunk.startsWith('data: ')) try { handle(JSON.parse(chunk.slice(6))); } catch (e) { console.error(e); } }
    }
  } catch (e) {
    if (e.name !== 'AbortError') handle({ type: 'error', message: e.message });
    else { thinking.remove(); if (full) renderMd(v.body, full + '\n\n_(stopped)_'); }
  } finally {
    S.streaming = null; updateSend(); refreshList(); refreshState().then(renderTop).catch(() => {}); $('#input').focus();
  }
}
function toolLabel(ev) {
  const a = ev.args || {};
  return { read_file: 'Reading ' + (a.path || ''), list_files: 'Listing files' + (a.folder ? ' in ' + a.folder : ''), search_project: 'Searching for "' + (a.query || '') + '"',
    edit_file: 'Writing changes to ' + (a.path || ''), write_file: 'Writing ' + (a.path || ''), show_preview: 'Building preview', remember: 'Saving to memory',
    web_search: 'Searching the web for "' + (a.query || '') + '"', read_webpage: 'Reading ' + (a.url || 'page'), make_image: 'Making an image', search_library: 'Searching your Library for "' + (a.query || '') + '"',
    run_code: 'Running JavaScript', run_python: 'Running Python', lookup_docs: 'Checking the latest ' + (a.name || '') + ' docs', look_at_page: 'Looking at ' + (a.target || 'the page'), update_plan: 'Updating the plan',
    run_command: 'Running ' + (a.command || 'a command'), save_lesson: 'Saving a lesson', project_map: 'Mapping the project', save_point: 'Making a save point', review: 'Getting a second opinion' }[ev.name] || ev.name;
}
function stop() { if (S.streaming) { S.streaming.ac.abort(); if (S.convo) api('stop', { convoId: S.convo.id }).catch(() => {}); } }

/* ---------------- Attachments ---------------- */
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|js|mjs|cjs|jsx|ts|tsx|html?|css|scss|py|java|c|h|cpp|hpp|cs|go|rs|rb|php|sql|xml|yml|yaml|toml|ini|cfg|log|sh|bat|cmd|ps1|vue|svelte|kt|swift|lua|r|tex|env|gitignore)$/i;
function fmtSize(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }

function shrinkImage(src, max = 1600) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', .86));
    };
    img.onerror = () => reject(Error('Could not read that image'));
    img.src = src;
  });
}

async function readPdf(file) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer(), isEvalSupported: false }).promise;
  let text = '';
  for (let p = 1; p <= Math.min(pdf.numPages, 150); p++) {
    const tc = await (await pdf.getPage(p)).getTextContent();
    text += `\n--- Page ${p} ---\n` + tc.items.map(i => i.str + (i.hasEOL ? '\n' : ' ')).join('');
    if (text.length > 150000) break;
  }
  if (text.replace(/--- Page \d+ ---|\s/g, '').length > 40) return { kind: 'text', text: text.trim(), note: pdf.numPages + ' pages' };
  // Scanned PDF (no text layer): send the first pages as images instead
  const images = [];
  for (let p = 1; p <= Math.min(pdf.numPages, 4); p++) {
    const page = await pdf.getPage(p); const vp = page.getViewport({ scale: 1.6 });
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    images.push(await shrinkImage(c.toDataURL('image/png')));
  }
  return { kind: 'image', images, note: 'scanned · ' + images.length + ' page image' + (images.length > 1 ? 's' : '') };
}

async function readFileAttachment(file) {
  const name = file.name || 'pasted';
  if (file.type.startsWith('image/')) {
    const url = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
    const small = await shrinkImage(url); return { kind: 'image', images: [small], thumb: small };
  }
  if (/\.pdf$/i.test(name) || file.type === 'application/pdf') { const r = await readPdf(file); return { ...r, thumb: r.images?.[0] }; }
  if (/\.docx$/i.test(name)) { const r = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() }); return { kind: 'text', text: r.value.trim() }; }
  if (/\.(doc|ppt|pptx|xls|xlsx|zip|rar|7z|exe|dll|mp3|mp4|mov)$/i.test(name)) throw Error(name + ': that file type isn\'t supported yet. Try PDF, Word (.docx), images or text/code files.');
  if (file.size > 3 * 1024 * 1024) throw Error(name + ' is too big (3 MB max for text files)');
  const text = await file.text();
  if (text.includes('\0') || (!TEXT_EXT.test(name) && /[\x00-\x08\x0E-\x1F]/.test(text.slice(0, 2000)))) throw Error(name + " doesn't look like a text file");
  return { kind: 'text', text };
}

async function addFiles(files) {
  for (const file of files) {
    if (S.attachments.length >= 12) { toast('12 attachments max per message', true); break; }
    const att = { id: Math.random().toString(36).slice(2), name: file.name || 'pasted-image.png', size: file.size, busy: true };
    S.attachments.push(att); renderAttachments();
    try { Object.assign(att, await readFileAttachment(file), { busy: false }); }
    catch (e) { S.attachments = S.attachments.filter(a => a !== att); toast(e.message, true); }
    renderAttachments();
  }
}
function renderAttachments() {
  const row = $('#attachRow'); row.innerHTML = ''; row.hidden = !S.attachments.length;
  for (const a of S.attachments) {
    row.append(el('div', { class: 'att' + (a.busy ? ' busy' : ''), title: a.name },
      a.thumb ? el('img', { src: a.thumb, alt: '' }) : el('span', { text: a.busy ? '⏳' : '📄' }),
      el('div', { style: 'min-width:0' }, el('span', { class: 'nm', text: a.name }), el('span', { class: 'sz', text: a.busy ? 'reading…' : (a.note || (a.kind === 'text' ? (a.text.length < 1000 ? a.text.length + ' chars' : (a.text.length / 1000).toFixed(1) + 'k chars') : fmtSize(a.size))) })),
      el('button', { class: 'x', title: 'Remove', text: '✕', onclick: () => { S.attachments = S.attachments.filter(x => x !== a); renderAttachments(); } })));
  }
  updateSend();
}

/* ---------------- Side panel ---------------- */
function openPanel(key, label, render, actions) {
  let tab = S.panel.tabs.find(t => t.key === key);
  if (!tab) { tab = { key, label }; S.panel.tabs.push(tab); if (S.panel.tabs.length > 6) S.panel.tabs.shift(); }
  Object.assign(tab, { label, render, actions });
  S.panel.active = key; $('#panel').hidden = false; $('#panelToggle').hidden = false; drawPanel();
}
function drawPanel() {
  const tabs = $('#panelTabs'); tabs.innerHTML = '';
  for (const t of S.panel.tabs) tabs.append(el('button', { class: 'tab' + (t.key === S.panel.active ? ' on' : ''), text: t.label, onclick: () => { S.panel.active = t.key; drawPanel(); } }));
  const tab = S.panel.tabs.find(t => t.key === S.panel.active);
  const body = $('#panelBody'); body.innerHTML = ''; $('#panelActions').innerHTML = '';
  if (!tab) return;
  body.append(tab.render());
  if (tab.actions) $('#panelActions').append(...tab.actions());
}
function openPreview(p) {
  openPanel('preview:' + p.title, '◳ ' + p.title, () => el('iframe', { sandbox: 'allow-scripts allow-forms allow-modals allow-popups', srcdoc: p.html, title: p.title }),
    () => [el('button', { class: 'btn small ghost', text: 'Download', onclick: () => download(p) }),
      el('button', { class: 'btn small ghost', text: 'New tab', onclick: () => window.open(URL.createObjectURL(new Blob([p.html], { type: 'text/html' }))) })]);
}
async function openFiles() {
  if (!S.project.open) return openProjectDlg();
  let nodes; try { nodes = await api('project/tree'); } catch (e) { return toast(e.message, true); }
  openPanel('files', '📁 Files', () => {
    const box = el('div', { class: 'file-tree' });
    if (!nodes.length) box.append(el('p', { class: 'empty-note', text: 'This folder is empty.' }));
    for (const n of nodes) box.append(el('button', { class: n.type === 'dir' ? 'dir' : '', style: `padding-left:${8 + n.depth * 14}px`, text: (n.type === 'dir' ? '▸ ' : '') + n.path.split('/').pop(), title: n.path, onclick: n.type === 'file' ? () => viewFile(n.path) : null }));
    return box;
  });
}
async function viewFile(p) {
  let f; try { f = await api('project/file?path=' + encodeURIComponent(p)); } catch (e) { return toast(e.message, true); }
  const lang = p.split('.').pop();
  openPanel('file:' + p, p.split('/').pop(), () => {
    let html; try { html = hljs.getLanguage(lang) ? hljs.highlight(f.content, { language: lang }).value : esc(f.content); } catch { html = esc(f.content); }
    return el('div', { class: 'file-view' }, el('div', { class: 'path' }, el('span', { text: f.path + ' · ' + f.totalLines + ' lines' }), el('span', { class: 'spacer' }),
      el('button', { class: 'btn small ghost', text: 'Ask about this', onclick: () => { setInput(`Look at ${f.path} and `); if (innerWidth < 900) $('#panel').hidden = true; } })),
      el('pre', {}, el('code', { class: 'hljs', html })));
  });
}

/* ---------------- Library ---------------- */
async function openLibrary() {
  closeSidebar();
  let data; try { data = await api('library'); } catch (e) { return toast(e.message, true); }
  const fmtChars = n => n > 1e6 ? (n / 1e6).toFixed(1) + 'M' : n > 1e3 ? Math.round(n / 1e3) + 'k' : String(n);
  openPanel('library', '📚 Library', () => {
    const box = el('div', { class: 'library' });
    box.append(el('p', { class: 'lib-intro', html: 'Your own knowledge base. Add docs, books, notes and web pages and Rutherford will <b>look things up in them</b> when you ask. Everything stays on this computer.' }),
      el('div', { class: 'lib-stats', text: `${data.stats.docs} documents · ${fmtChars(data.stats.chars)} characters · ${data.stats.chunks} passages` }));
    const urlIn = el('input', { placeholder: 'https://docs.godotengine.org/…', autocomplete: 'off' });
    const folderIn = el('input', { placeholder: 'C:\\Users\\Darren\\Documents\\docs', autocomplete: 'off' });
    const busy = async (btn, fn) => { const t = btn.textContent; btn.disabled = true; btn.textContent = 'Adding…'; try { await fn(); } catch (e) { toast(e.message, true); } btn.disabled = false; btn.textContent = t; };
    const addUrlBtn = el('button', { class: 'btn small', text: 'Add page', onclick: () => busy(addUrlBtn, async () => { if (!urlIn.value.trim()) return; const d = await api('library/url', { url: urlIn.value.trim() }); toast('Added ' + d.title); openLibrary(); }) });
    const addFolderBtn = el('button', { class: 'btn small', text: 'Add folder', onclick: () => busy(addFolderBtn, async () => { if (!folderIn.value.trim()) return; const r = await api('library/folder', { path: folderIn.value.trim() }); toast(`Added ${r.added} files` + (r.capped ? ' (stopped at the size limit)' : '')); openLibrary(); }) });
    box.append(el('div', { class: 'lib-add' },
      el('div', { class: 'lib-row' }, el('b', { text: 'Files' }), el('span', { class: 'hint', text: 'PDF, Word, text, Markdown, HTML, code' }), el('span', { class: 'spacer' }), el('button', { class: 'btn small', text: 'Choose files', onclick: () => $('#libFileInput').click() })),
      el('div', { class: 'lib-row' }, el('b', { text: 'Web page' }), urlIn, addUrlBtn),
      el('div', { class: 'lib-row' }, el('b', { text: 'Folder' }), folderIn, addFolderBtn)));
    const qIn = el('input', { type: 'search', placeholder: 'Test a search…' }); const results = el('div', { class: 'lib-results' });
    qIn.oninput = () => { clearTimeout(qIn.t); qIn.t = setTimeout(async () => { results.innerHTML = ''; if (!qIn.value.trim()) return; for (const h of await api('library/search?q=' + encodeURIComponent(qIn.value))) results.append(el('div', { class: 'lib-hit' }, el('b', { text: h.title + (h.where ? ' · ' + h.where : '') }), el('p', { text: h.text.slice(0, 260) + (h.text.length > 260 ? '…' : '') }))); if (!results.children.length) results.append(el('p', { class: 'hint', text: 'No matches.' })); }, 250); };
    if (data.stats.docs) box.append(qIn, results);
    const list = el('div', { class: 'lib-list' });
    if (!data.docs.length) list.append(el('p', { class: 'empty-note', text: 'Nothing here yet. Good starters: language docs you use (MDN, Python, Godot), your class textbooks/notes (PDF), and your own project READMEs.' }));
    for (const d of data.docs) list.append(el('div', { class: 'lib-doc' }, el('span', { class: 'ico', text: d.kind === 'web' ? '🌐' : d.kind === 'file' ? '📁' : '📄' }),
      el('div', { class: 'meta' }, el('b', { text: d.title, title: d.source || d.title }), el('span', { text: fmtChars(d.chars) + ' chars · ' + new Date(d.added).toLocaleDateString() })),
      el('button', { class: 'icon-btn', title: 'Remove', text: '✕', onclick: async () => { if (confirm('Remove "' + d.title + '" from the Library?')) { await api('library/remove', { id: d.id }); openLibrary(); } } })));
    box.append(el('h3', { class: 'lib-h', text: 'Documents' }), list);
    return box;
  });
}
async function addLibraryFiles(files) {
  let ok = 0;
  for (const f of files) {
    toast('Reading ' + f.name + '…');
    try {
      const r = await readFileAttachment(f);
      if (r.kind !== 'text') throw Error(f.name + ': no text found (scanned PDFs and images can\'t go in the Library yet)');
      await api('library/add', { title: f.name, text: r.text });
      ok++;
    } catch (e) { toast(e.message, true); }
  }
  if (ok) { toast(`Added ${ok} file${ok > 1 ? 's' : ''} to the Library`); openLibrary(); }
}

/* ---------------- Phone access ---------------- */
async function renderPhone(tested) {
  const box = $('#phoneBox'); if (!box) return;
  let ph; try { ph = tested || await api('phone'); } catch (e) { box.textContent = location.port === '3737' || location.hostname === '127.0.0.1' ? e.message : 'Phone access is managed from the computer.'; return; }
  box.innerHTML = '';
  const set = async patch => { try { await api('phone', patch); renderPhone(); } catch (e) { toast(e.message, true); } };
  box.append(el('label', { class: 'toggle' }, el('input', { type: 'checkbox', checked: ph.enabled ? true : null, onchange: e => set({ enabled: e.target.checked }) }), el('span', { text: 'Let my phone use Rutherford (needs the PIN)' })));
  if (!ph.enabled) { box.append(el('p', { class: 'hint', text: 'Off. Your phone and other devices can’t reach Rutherford.' })); return; }
  if (ph.error) box.append(el('p', { class: 'error', text: ph.error }));
  const best = ph.urls[0];
  const qrBox = el('div', { class: 'qr' });
  if (best && window.qrcode) { const q = qrcode(0, 'M'); q.addData(best.url); q.make(); qrBox.innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); }
  box.append(el('div', { class: 'phone-grid' }, qrBox,
    el('div', {},
      el('div', { class: 'hint', text: 'PIN' }), el('div', { class: 'pin', text: ph.pin.replace(/(\d{3})(\d{3})/, '$1 $2') }),
      ...ph.urls.map(u => { const t = ph.test?.find(x => x.url === u.url); return el('div', { class: 'phone-url' }, el('code', { text: u.url }), el('span', { class: 'hint', text: ' ' + u.kind }), t ? el('span', { class: t.ok ? 'ok' : 'error', text: t.ok ? ' ✓ answering' : ' ✗ not answering' }) : null); }),
      ph.hidden?.length ? el('p', { class: 'hint', text: `Hidden ${ph.hidden.length} virtual address${ph.hidden.length === 1 ? '' : 'es'} your phone can’t use (${ph.hidden.join(', ')}).` }) : null,
      !ph.urls.length ? el('p', { class: 'error', text: 'No network found. Is this computer on Wi-Fi?' }) : null,
      el('p', { class: 'hint', text: `${ph.devices} device${ph.devices === 1 ? '' : 's'} signed in` }))),
    el('ol', { class: 'phone-steps' },
      el('li', { text: 'Phone on the same Wi-Fi. Scan the code (or type the address).' }),
      el('li', { text: 'Enter the PIN. Then Share → "Add to Home Screen" so it opens like an app.' }),
      el('li', { html: 'If it won’t load: click <b>Test</b> below. If every address says ✓ but the phone still can’t load it, Windows Firewall is blocking it: allow Node.js on <b>Private networks</b> and set your Wi-Fi to <b>Private</b> (Settings → Network → Wi-Fi → your network).' }),
      el('li', { text: 'Your router can change this computer’s address now and then. Come back here for the current code.' }),
      el('li', { html: 'Away from home: install free <a href="https://tailscale.com/download" target="_blank" rel="noopener">Tailscale</a> on this computer and your phone, sign in to both, then use the Tailscale address that shows up here.' })),
    el('div', { class: 'row' }, el('button', { type: 'button', class: 'btn small', text: 'Test', onclick: async e => { e.target.disabled = true; e.target.textContent = 'Testing…'; try { renderPhone(await api('phone', { test: true })); } catch (er) { toast(er.message, true); e.target.disabled = false; e.target.textContent = 'Test'; } } }),
      el('button', { type: 'button', class: 'btn small ghost', text: 'New PIN (signs out phones)', onclick: () => confirm('Make a new PIN? Every phone will need to sign in again.') && set({ newPin: true }) }),
      el('button', { type: 'button', class: 'btn small ghost', text: 'Sign out all devices', onclick: () => set({ signOutAll: true }) })));
}

/* ---------------- Build mode / resume / save points ---------------- */
function setBuild(on, quiet) {
  S.build = !!on; $('#buildBtn').classList.toggle('on', S.build); $('#buildBtn').setAttribute('aria-pressed', String(S.build));
  try { localStorage.setItem('rf-build', S.build ? '1' : ''); } catch {}
  if (!quiet) toast(S.build ? 'Build mode ON: plans, builds, tests and fixes step by step' : 'Build mode off');
}
function renderResume() {
  const row = $('#resumeRow'); if (!row) return;
  const p = S.project.open && S.project.plan;
  row.hidden = !(p && p.left > 0) || !!S.streaming; row.innerHTML = '';
  if (row.hidden) return;
  row.append(el('span', { text: `🔨 "${p.goal}": ${p.left} of ${p.total} steps left` }),
    el('button', { class: 'btn small', text: 'Continue build', onclick: () => { setBuild(true, true); setInput('Continue the build plan from the next unfinished step.'); send(); } }),
    el('button', { class: 'icon-btn sm', title: 'Clear this plan', text: '✕', onclick: async () => { if (!confirm('Clear this build plan?')) return; await api('plan/clear', {}); S.project.plan = null; renderResume(); } }));
}
async function openSavepoints() {
  let r; try { r = await api('savepoints'); } catch (e) { return toast(e.message, true); }
  const render = () => {
    const box = el('div', { class: 'sp-list' });
    if (!r.git) { box.append(el('p', { html: 'Save points use <b>Git</b> (free). Install it from <a href="https://git-scm.com/download/win" target="_blank" rel="noopener">git-scm.com</a>, then restart Rutherford.' })); return box; }
    if (!r.available) { box.append(el('p', { class: 'hint', text: 'Save points are turned off in Settings → Coding tools.' })); return box; }
    box.append(el('div', { class: 'row' }, el('button', { class: 'btn small', text: 'Save now', onclick: async () => { try { const x = await api('savepoints/save', { message: 'manual save' }); toast(x.saved ? 'Saved ' + x.hash : x.note); r = await api('savepoints'); openSavepoints(); } catch (e) { toast(e.message, true); } } }),
      el('span', { class: 'hint', text: 'Going back saves where you are first, so you can always undo it.' })));
    if (!r.list.length) box.append(el('p', { class: 'hint', text: 'No save points yet. Rutherford makes them automatically before it changes files.' }));
    for (const sp of r.list) box.append(el('div', { class: 'sp' },
      el('div', {}, el('b', { text: sp.message.replace(/^Save point: /, '') }), el('div', { class: 'hint', text: new Date(sp.date).toLocaleString() + ' · ' + sp.files + ' file' + (sp.files === 1 ? '' : 's') + ' · ' + sp.short })),
      el('button', { class: 'btn small ghost', text: 'Go back to this', onclick: async () => { if (!confirm('Put every project file back the way it was at this save point? (Your current version is saved first.)')) return; try { await api('savepoints/restore', { hash: sp.hash }); toast('Project restored to ' + sp.short); openSavepoints(); } catch (e) { toast(e.message, true); } } })));
    return box;
  };
  openPanel('savepoints', '⏱ Save points', render);
}

/* Voice typing: record, send to Whisper, put the words in the box */
async function toggleMic() {
  const btn = $('#micBtn');
  if (S.rec) { S.rec.stop(); return; }
  let stream; try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { return toast('Microphone blocked. Allow it in the browser (lock icon in the address bar).', true); }
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find(m => window.MediaRecorder?.isTypeSupported?.(m)) || '';
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : {}); const chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  rec.onstop = async () => {
    stream.getTracks().forEach(t => t.stop()); S.rec = null; btn.classList.remove('rec'); btn.textContent = '⏳';
    try {
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      const audio = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(blob); });
      const { text } = await api('transcribe', { audio, mime: blob.type });
      if (text) { const i = $('#input'); setInput((i.value ? i.value.trimEnd() + ' ' : '') + text); } else toast("Didn't catch that", true);
    } catch (e) { toast(e.message, true); }
    btn.textContent = '🎤';
  };
  rec.start(); S.rec = rec; btn.classList.add('rec'); btn.textContent = '■'; toast('Listening… tap ■ to stop');
  setTimeout(() => { if (S.rec === rec) rec.stop(); }, 120000);
}

function renderCaps(caps) {
  const box = $('#capsBox'); if (!box || !caps) return; box.innerHTML = '';
  const row = (ok, name, yes, no) => box.append(el('div', { class: 'cap ' + (ok ? 'ok' : 'no') }, el('span', { text: ok ? '✓' : '✗' }), el('b', { text: name }), el('span', { class: 'hint', html: ok ? yes : no })));
  row(caps.python, 'Python', 'found: homework math, data and charts', 'not found. <a href="https://www.python.org/downloads/" target="_blank" rel="noopener">Install Python</a> (tick "Add python.exe to PATH"), then restart Rutherford.');
  row(caps.browser, 'Browser eyes', 'Edge/Chrome found: Rutherford can look at and play-test pages', 'no Edge or Chrome found');
  row(caps.git, 'Save points', 'Git found', 'need Git: <a href="https://git-scm.com/download/win" target="_blank" rel="noopener">install it free</a>, then restart Rutherford.');
  row(Number(String(caps.node).split('.')[0]) >= 22, 'Node.js ' + caps.node, 'good', 'browser eyes need Node.js 22+. Update from <a href="https://nodejs.org" target="_blank" rel="noopener">nodejs.org</a>.');
}

/* ---------------- Settings / project ---------------- */
function renderTop() {
  const m = S.settings.model || '';
  const first = (S.brains || []).find(b => b.hasKey && b.enabled && !b.resting) || (S.brains || []).find(b => b.hasKey && b.enabled);
  const n = (S.brains || []).filter(b => b.hasKey && b.enabled).length;
  $('#modelChip').innerHTML = n ? `🧠<span class="chip-text"> ${n} brain${n > 1 ? 's' : ''}</span>` : 'Add an AI key';
  $('#modelChip').title = first ? 'Using ' + first.name + ' · ' + first.model + ' first. Click to manage.' : 'Add a free AI key';
  $('#savepointsChip').hidden = !S.project.open;
  renderResume();
  $('#projectName').textContent = S.project.open ? S.project.name : 'No project';
  $('#projectChip').classList.toggle('on', S.project.open);
  $('#projectChip').title = S.project.open ? S.project.path + ' — click to browse files' : 'Open a code project folder';
  $('#input').placeholder = S.project.open ? `Ask about ${S.project.name}, or anything…` : 'Message Rutherford…';
}
async function saveBrainKey(id, key) {
  key = String(key || '').trim(); if (!key) return toast('Paste your key first', true);
  const r = await api('providers', { id, key });
  if (r.ok) toast(`${r.status.find(x => x.id === id).name} connected ✓ (${r.models} models, using ${r.model})`); else toast(r.error, true);
  await refreshState(); renderTop(); renderBrains();
}
async function refreshState() { const st = await api('state'); Object.assign(S, { settings: st.settings, anyKey: st.anyKey, brains: st.brains, project: st.project }); }
async function renderBrains() {
  const box = $('#brainsBox'); if (!box) return;
  let list; try { list = await api('providers'); } catch (e) { box.textContent = e.message; return; }
  S.brains = list; box.innerHTML = '';
  const move = async (i, d) => { const ids = list.map(x => x.id); const j = i + d; if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j], ids[i]]; await api('providers', { order: ids }); renderBrains(); };
  list.forEach((b, i) => {
    const keyIn = el('input', { type: 'password', placeholder: b.hasKey ? `Saved (${b.keyHint}). Paste to replace` : 'Paste free key', autocomplete: 'off' });
    const modelSel = el('select', { class: 'brain-model', disabled: b.hasKey ? null : true }, el('option', { value: b.model, text: b.model }));
    modelSel.onfocus = async () => { if (modelSel.dataset.loaded) return; modelSel.dataset.loaded = 1; try { const r = await api('providers/models?id=' + b.id); modelSel.innerHTML = ''; for (const m of r.models) modelSel.append(el('option', { value: m.id, text: m.id + (m.context ? ` · ${Math.round(m.context / 1000)}k` : ''), selected: m.id === r.model ? true : null })); } catch (e) { toast(e.message, true); } };
    modelSel.onchange = async () => { await api('providers', { id: b.id, model: modelSel.value }); toast(`${b.name}: ${modelSel.value}`); renderTop(); };
    const codeSel = el('select', { class: 'brain-model', title: 'Coding brain: used when a project is open or in Build mode' }, el('option', { value: b.codeModel || '', text: b.codeModel ? '💻 ' + b.codeModel : '💻 same as above' }));
    codeSel.onfocus = async () => { if (codeSel.dataset.loaded) return; codeSel.dataset.loaded = 1; try { const r = await api('providers/models?id=' + b.id); codeSel.innerHTML = ''; codeSel.append(el('option', { value: '', text: '💻 same as above' })); for (const m of r.models) codeSel.append(el('option', { value: m.id, text: '💻 ' + m.id, selected: m.id === r.codeModel ? true : null })); } catch (e) { toast(e.message, true); } };
    codeSel.onchange = async () => { await api('providers', { id: b.id, codeModel: codeSel.value }); toast(`${b.name} coding brain: ${codeSel.value || 'same as normal'}`); };
    const t = b.today;
    box.append(el('div', { class: 'brain' + (b.hasKey && b.enabled ? ' on' : '') },
      el('div', { class: 'brain-head' }, el('span', { class: 'brain-n', text: String(i + 1) }), el('b', { text: b.name }),
        b.resting ? el('span', { class: 'rest', title: b.resting.reason, text: `resting until ${new Date(b.resting.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` }) : null,
        el('span', { class: 'spacer' }),
        el('a', { href: 'https://' + b.keyUrl, target: '_blank', rel: 'noopener', class: 'hint', text: b.hasKey ? '' : 'Get free key ↗' }),
        el('button', { type: 'button', class: 'icon-btn sm', title: 'Use earlier', text: '↑', onclick: () => move(i, -1) }), el('button', { type: 'button', class: 'icon-btn sm', title: 'Use later', text: '↓', onclick: () => move(i, 1) })),
      el('div', { class: 'row' }, keyIn, el('button', { type: 'button', class: 'btn small', text: 'Save', onclick: () => saveBrainKey(b.id, keyIn.value) })),
      b.hasKey ? el('div', { class: 'row' }, modelSel, el('label', { class: 'toggle', title: 'Use this brain' }, el('input', { type: 'checkbox', checked: b.enabled ? true : null, onchange: async e => { await api('providers', { id: b.id, enabled: e.target.checked }); renderBrains(); } }), 'On')) : null,
      b.hasKey ? el('div', { class: 'row' }, codeSel) : null,
      b.hasKey ? el('div', { class: 'hint', text: `Today: ${t.requests} answers · ${t.tokens > 999 ? Math.round(t.tokens / 1000) + 'k' : t.tokens} tokens` + (t.errors ? ` · ${t.errors} hiccup${t.errors === 1 ? '' : 's'}` : '') }) : null));
  });
}
function fillModelSelects() {
  const sel = $('#visionSel'); const cur = S.settings.visionModel; sel.innerHTML = '';
  const ids = S.models.map(m => m.id).filter(id => !/whisper|tts|guard|playai|orpheus/i.test(id));
  const list = ids.includes(cur) || !cur ? ids : [cur, ...ids];
  if (!list.length) sel.append(el('option', { value: cur || '', text: cur || '(add a Groq key to choose)' }));
  for (const id of list) sel.append(el('option', { value: id, text: id + (/llama-4|vision|scout|maverick/i.test(id) ? '  · sees images' : ''), selected: id === cur ? true : null }));
}
async function openSettings() {
  closeSidebar();
  const s = S.settings;
  $('#autoApprove').checked = !!s.autoApprove; $('#nameInput').value = s.userName || ''; $('#webToggle').checked = s.webSearch !== false; $('#imgTokenInput').value = ''; $('#imgTokenInput').placeholder = s.hasImageToken ? 'Token saved, paste a new one to replace' : 'Pollinations token, leave empty for free/anonymous';
  const st = await api('state'); $('#memoryInput').value = st.memory; $('#memoryStatus').textContent = '';
  $('#customInput').value = s.customInstructions || ''; $('#customStatus').textContent = '';
  $('#autoRunSel').value = s.autoRun || 'ask'; $('#reviewerToggle').checked = s.reviewer !== false; $('#savePointsToggle').checked = s.savePoints !== false;
  renderCaps(st.caps);
  $('#aboutLine').textContent = 'Rutherford ' + st.version + ' · your chats & settings are saved in ' + st.dataDir;
  fillModelSelects(); renderPhone(); renderBrains();
  $('#settingsDlg').showModal();
  if (s.hasKey && !S.models.length) api('models').then(m => { S.models = m; fillModelSelects(); }).catch(() => {});
}
function openProjectDlg() {
  closeSidebar();
  $('#projectErr').textContent = ''; $('#projectPath').value = '';
  $('#projectOpenSection').hidden = !S.project.open; $('#projectOpenName').textContent = S.project.path || '';
  const r = $('#recentProjects'); r.innerHTML = '';
  const recent = (S.settings.recentProjects || []).filter(p => p !== S.project.path);
  if (recent.length) r.append(el('span', { class: 'lbl', text: 'Recent' }));
  for (const p of recent) r.append(el('button', { type: 'button', text: p, title: p, onclick: () => doOpenProject(p) }));
  $('#projectDlg').showModal(); $('#projectPath').focus();
}
async function doOpenProject(p) {
  try { S.project = await api('project/open', { path: p }); S.settings = (await api('state')).settings; renderTop(); $('#projectDlg').close(); toast('Opened ' + S.project.name); openFiles(); }
  catch (e) { $('#projectErr').textContent = e.message.includes('ENOENT') ? "That folder doesn't exist. Check the path." : e.message; }
}

function closeSidebar() { $('#app').classList.remove('side-open'); }
function lightbox(src) { const lb = el('div', { class: 'lightbox', onclick: () => lb.remove() }, el('img', { src, alt: '' })); document.body.append(lb); }

/* ---------------- App switcher ---------------- */
function switchApp(name) {
  if (name !== 'alpha') name = 'chat';
  const frame = $('#alphaFrame');
  if (name === 'alpha' && !frame.src) frame.src = 'alpha/';
  $('#app').classList.toggle('mode-alpha', name === 'alpha');
  frame.hidden = name !== 'alpha';
  document.querySelectorAll('.rail-btn').forEach(b => b.classList.toggle('on', b.dataset.app === name));
  document.title = name === 'alpha' ? 'Alpha · Rutherford' : 'Rutherford';
  try { localStorage.setItem('rf-app', name); } catch {}
  if (name === 'chat') $('#input').focus();
}

/* ---------------- Wire up ---------------- */
function wire() {
  document.querySelectorAll('.rail-btn').forEach(b => (b.onclick = () => switchApp(b.dataset.app)));
  $('#alphaChip').onclick = () => switchApp('alpha');
  // Alpha (inside the frame) asks to switch back on phones
  addEventListener('message', e => { if (e.origin === location.origin && e.data?.rutherford === 'switch') switchApp(e.data.app); });
  const input = $('#input');
  input.addEventListener('input', () => { autosize(); updateSend(); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && innerWidth > 760) { e.preventDefault(); send(); } });
  input.addEventListener('paste', e => { const files = [...(e.clipboardData?.files || [])]; if (files.length) { e.preventDefault(); addFiles(files); } });
  $('#sendBtn').onclick = () => (S.streaming ? stop() : send());
  $('#attachBtn').onclick = () => $('#fileInput').click();
  $('#fileInput').onchange = e => { addFiles([...e.target.files]); e.target.value = ''; };
  $('#newChatBtn').onclick = newChat; $('#brandBtn').onclick = newChat;
  $('#settingsBtn').onclick = openSettings; $('#modelChip').onclick = openSettings;
  $('#projectChip').onclick = () => (S.project.open ? openFiles() : openProjectDlg());
  $('#projectChip').oncontextmenu = e => { e.preventDefault(); openProjectDlg(); };
  $('#openSidebar').onclick = () => $('#app').classList.add('side-open');
  $('#closeSidebar').onclick = closeSidebar; $('#scrim').onclick = closeSidebar;
  $('#panelClose').onclick = () => ($('#panel').hidden = true);
  $('#panelToggle').onclick = () => { $('#panel').hidden = !$('#panel').hidden; if (!$('#panel').hidden) drawPanel(); };
  let st; $('#searchChats').oninput = () => { clearTimeout(st); st = setTimeout(refreshList, 200); };

  $('#thinkBtn').onclick = () => { S.think = !S.think; $('#thinkBtn').classList.toggle('on', S.think); $('#thinkBtn').setAttribute('aria-pressed', String(S.think)); toast(S.think ? 'Think harder: ON (slower, smarter)' : 'Think harder: off'); try { localStorage.setItem('rf-think', S.think ? '1' : ''); } catch {} };
  $('#buildBtn').onclick = () => setBuild(!S.build);
  $('#savepointsChip').onclick = openSavepoints;
  if (navigator.mediaDevices?.getUserMedia && window.MediaRecorder) { $('#micBtn').hidden = false; $('#micBtn').onclick = toggleMic; }
  $('#saveCustom').onclick = async () => { try { S.settings = await api('settings', { customInstructions: $('#customInput').value }); $('#customStatus').textContent = 'Saved ✓'; } catch (e) { $('#customStatus').textContent = e.message; } };
  $('#autoRunSel').onchange = async e => { S.settings = await api('settings', { autoRun: e.target.value }); toast(e.target.value === 'safe' ? 'Tests & builds run automatically' : 'Rutherford asks before every command'); };
  $('#reviewerToggle').onchange = async e => { S.settings = await api('settings', { reviewer: e.target.checked }); toast(e.target.checked ? 'Second opinion on' : 'Second opinion off'); };
  $('#savePointsToggle').onchange = async e => { S.settings = await api('settings', { savePoints: e.target.checked }); toast(e.target.checked ? 'Save points on' : 'Save points off'); };
  $('#visionSel').onchange = async e => { S.settings = await api('settings', { visionModel: e.target.value }); toast('Photo model: ' + e.target.value); };
  $('#webToggle').onchange = async e => { S.settings = await api('settings', { webSearch: e.target.checked }); toast(e.target.checked ? 'Web search on' : 'Web search off'); };
  $('#saveImgToken').onclick = async () => { S.settings = await api('settings', { imageToken: $('#imgTokenInput').value }); $('#imgTokenInput').value = ''; toast('Saved'); };
  $('#libraryBtn').onclick = openLibrary;
  $('#libFileInput').onchange = e => { addLibraryFiles([...e.target.files]); e.target.value = ''; };
  $('#nameInput').onchange = async e => { S.settings = await api('settings', { userName: e.target.value }); toast('Saved'); };
  $('#autoApprove').onchange = async e => { S.settings = await api('settings', { autoApprove: e.target.checked }); };
  $('#saveMemory').onclick = async () => { try { await api('memory', { memory: $('#memoryInput').value }); $('#memoryStatus').textContent = 'Saved ✓'; } catch (e) { $('#memoryStatus').textContent = e.message; } };

  $('#openProject').onclick = () => doOpenProject($('#projectPath').value);
  $('#projectPath').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); doOpenProject(e.target.value); } };
  $('#closeProject').onclick = async () => { S.project = await api('project/close', {}); renderTop(); $('#projectDlg').close(); S.panel.tabs = S.panel.tabs.filter(t => !t.key.startsWith('file')); $('#panel').hidden = true; toast('Project closed'); };

  // Drag & drop anywhere
  let dragDepth = 0;
  addEventListener('dragenter', e => { if (e.dataTransfer?.types.includes('Files')) { dragDepth++; $('#dropHint').hidden = false; } });
  addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropHint').hidden = true; } });
  addEventListener('dragover', e => e.preventDefault());
  addEventListener('drop', e => { e.preventDefault(); dragDepth = 0; $('#dropHint').hidden = true; if (e.dataTransfer?.files?.length) addFiles([...e.dataTransfer.files]); });

  addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); switchApp('chat'); newChat(); }
    if (e.altKey && (e.key === '1' || e.key === '2')) { e.preventDefault(); switchApp(e.key === '2' ? 'alpha' : 'chat'); }
    if (e.key === 'Escape' && S.streaming) stop();
  });
}

async function boot() {
  wire();
  try {
    const st = await api('state');
    Object.assign(S, { settings: st.settings, project: st.project, convos: st.convos, anyKey: st.anyKey, brains: st.brains });
    try { S.think = localStorage.getItem('rf-think') === '1'; } catch {} $('#thinkBtn').classList.toggle('on', !!S.think);
    try { setBuild(localStorage.getItem('rf-build') === '1', true); } catch {}
  } catch (e) { toast('Could not reach the Rutherford server. Is the window still open?', true); }
  renderTop(); renderSidebar();
  const id = location.hash.slice(1);
  if (id && S.convos.some(c => c.id === id)) await openConvo(id); else renderThread();
  if (S.settings.hasKey) api('models').then(async m => { S.models = m; await refreshState(); renderTop(); }).catch(() => {});
  updateSend();
  let last = 'chat'; try { last = localStorage.getItem('rf-app') || 'chat'; } catch {}
  switchApp(last);
}
boot();

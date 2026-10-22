'use strict';
// Rutherford local server. Runs on your computer only (127.0.0.1).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const Store = require('./lib/store.cjs');
const Workspace = require('./lib/workspace.cjs');
const agent = require('./lib/agent.cjs');
const Library = require('./lib/library.cjs');
const web = require('./lib/web.cjs');
const Phone = require('./lib/phone.cjs');
const Providers = require('./lib/providers.cjs');
const groq = require('./lib/groq.cjs');
const Alpha = require('./apps/alpha/server.cjs');
const Savepoints = require('./lib/savepoints.cjs');
const Brain = require('./lib/projectbrain.cjs');
const docs = require('./lib/docs.cjs');
const runner = require('./lib/runner.cjs');
const eyes = require('./lib/eyes.cjs');
const crypto = require('node:crypto');
const VERSION = require('./package.json').version;

const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.json': 'application/json', '.webp': 'image/webp', '.gif': 'image/gif' };

function defaultDataDir() {
  if (process.env.RUTHERFORD_DATA) return process.env.RUTHERFORD_DATA;
  const os = require('node:os');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Rutherford');
  return path.join(os.homedir(), '.rutherford');
}

function createApp({ dataDir = defaultDataDir(), fetchImpl, marketFetch, webFetch, lookup, alphaTimers = true, phoneAutostart = false, phonePort } = {}) {
  const store = Store.create(dataDir);
  const library = Library.create(path.join(dataDir, 'library'));
  const providers = Providers.create({ dataDir, settings: store.settings, fetchImpl: fetchImpl || ((...a) => fetch(...a)) });
  // Alpha (markets) lives inside Rutherford at /alpha/ and shares the Groq key.
  const alpha = Alpha.createHandler({ dataDir: path.join(dataDir, 'alpha'), rutherfordSettings: path.join(dataDir, 'settings.json'), fetchImpl: marketFetch || fetch, groqFetch: fetchImpl, timers: alphaTimers });
  let workspace = null, brain = null;
  const running = new Map(); // convoId -> AbortController
  const approvals = new Map(); // approval id -> {resolve, convoId, request}
  const allowAllFor = new Set(); // chats where the user said "allow all commands"
  const savepointsFor = ws => {
    if (!ws || store.settings.get().savePoints === false || !Savepoints.hasGit()) return null;
    try { return Savepoints.create(ws.root); } catch { return null; }
  };

  function openProject(p) {
    workspace = Workspace.open(p); brain = Brain.create(workspace);
    const s = store.settings.get();
    store.settings.update({ projectPath: workspace.root, recentProjects: [workspace.root, ...s.recentProjects.filter(x => x !== workspace.root)] });
    return projectInfo();
  }
  function setProvider(id, patch) {
    if (id === 'groq') { const g = {}; if (patch.key !== undefined) g.groqKey = patch.key; if (patch.model !== undefined) g.model = patch.model; if (Object.keys(g).length) store.settings.update(g); }
    const all = { ...(store.settings.get().providers || {}) };
    const cur = { ...(all[id] || {}) };
    for (const [k, v] of Object.entries(patch)) if (!(id === 'groq' && (k === 'key' || k === 'model'))) cur[k] = v;
    all[id] = cur; store.settings.update({ providers: all });
  }
  const projectInfo = () => {
    if (!workspace) return { open: false };
    let plan = null; try { plan = brain.plan.get(); } catch {}
    return { open: true, name: workspace.name, path: workspace.root, notes: brain?.notes.exists() || false, plan: plan ? { goal: plan.goal, left: Brain.unfinished(plan), total: plan.steps.length } : null };
  };
  // Reopen last project on start (ignore if it moved)
  try { const p = store.settings.get().projectPath; if (p) { workspace = Workspace.open(p); brain = Brain.create(workspace); } } catch { workspace = null; brain = null; }
  let caps = null; // what this computer can do (checked once)
  const capabilities = () => caps ||= { python: !!runner.findPython(), browser: !!eyes.findBrowser(store.settings.get().browserPath), git: Savepoints.hasGit(), node: process.versions.node };

  const json = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  const readBody = req => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 30 * 1024 * 1024) { reject(Error('Upload too large (30 MB max)')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(Error('Bad JSON')); } });
    req.on('error', reject);
  });

  function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    const file = path.resolve(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(file).pipe(res);
  }

  function findChange(convo, id) {
    for (const m of convo.messages) for (const c of m.changes || []) if (c.id === id) return c;
    return null;
  }

  async function chat(req, res, body) {
    const convo = body.convoId ? store.convos.get(body.convoId) : store.convos.create();
    if (running.has(convo.id)) throw Error('Already answering in this chat');
    const text = String(body.text || '').slice(0, 100000);
    const attachments = (Array.isArray(body.attachments) ? body.attachments : []).slice(0, 20).map(a => ({ name: String(a.name || 'file').slice(0, 120), text: String(a.text || '').slice(0, 150000) }));
    const images = (Array.isArray(body.images) ? body.images : []).slice(0, 5).map(d => store.images.save(d));
    if (!text.trim() && !attachments.length && !images.length) throw Error('Type a message first');
    if (body.regenerate) { while (convo.messages.length && convo.messages.at(-1).role === 'assistant') convo.messages.pop(); }
    else convo.messages.push({ role: 'user', content: text, attachments, images, at: new Date().toISOString() });
    if (convo.title === 'New chat') convo.title = (text || attachments[0]?.name || 'Image question').replace(/\s+/g, ' ').trim().slice(0, 60);
    store.convos.save(convo);

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const emit = ev => { if (!res.writableEnded) res.write('data: ' + JSON.stringify(ev) + '\n\n'); };
    emit({ type: 'start', convo: { id: convo.id, title: convo.title }, user: convo.messages.at(-1) });
    const ac = new AbortController(); running.set(convo.id, ac);
    res.on('close', () => { if (!res.writableEnded) ac.abort(); });
    let partial = '';
    const emitTrack = ev => { if (ev.type === 'text') partial += ev.delta; emit(ev); };
    // The AI asks before running commands: the chat shows Allow / Don't, and this waits for the answer
    const ask = request => new Promise(resolve => {
      const id = crypto.randomUUID();
      const done = v => { if (!approvals.has(id)) return; approvals.delete(id); clearTimeout(t); ac.signal.removeEventListener('abort', onAbort); resolve(v); };
      const onAbort = () => done({ allow: false, reason: 'stopped' });
      const t = setTimeout(() => { done({ allow: false, reason: 'no answer within 15 minutes' }); emit({ type: 'approval_done', id, allow: false, reason: 'timed out' }); }, 15 * 60000);
      approvals.set(id, { resolve: done, convoId: convo.id, request });
      ac.signal.addEventListener('abort', onAbort, { once: true });
      emit({ type: 'approval', id, ...request });
    });
    try {
      const out = await agent.run({ store, workspace, library, providers, convo, emit: emitTrack, signal: ac.signal, fetchImpl, webFetch, lookup, think: !!body.think, build: !!body.build, ask, allowAll: () => allowAllFor.has(convo.id), savepoints: savepointsFor(workspace), brain: workspace ? brain : null });
      const msg = { role: 'assistant', content: out.content, steps: out.steps, changes: out.changes, preview: out.preview, sources: out.sources, generated: out.generated, codeRuns: out.codeRuns, commands: out.commands, shots: out.shots, plan: out.plan, review: out.review, model: out.model, provider: out.provider, think: out.think, build: out.build, at: new Date().toISOString() };
      convo.messages.push(msg); store.convos.save(convo);
      emit({ type: 'done', message: msg });
    } catch (e) {
      const stopped = e.code === 'aborted';
      if (partial.trim()) { convo.messages.push({ role: 'assistant', content: partial.trim() + (stopped ? '\n\n_(stopped)_' : ''), at: new Date().toISOString() }); store.convos.save(convo); }
      emit({ type: 'error', message: stopped ? 'Stopped.' : e.message, code: e.code || null });
    } finally { running.delete(convo.id); res.end(); }
  }

  const routes = {
    'GET /api/state': () => ({ version: VERSION, dataDir, caps: capabilities(), anyKey: providers.anyKey(), brains: providers.status(), settings: store.settings.public(), project: projectInfo(), convos: store.convos.list(), memory: store.memory.get() }),
    'POST /api/settings': b => store.settings.update(b),
    'GET /api/models': async () => {
      // Groq model list (kept for the photo-model picker); also fixes retired model choices
      const s = store.settings.get(); if (!providers.config('groq').key) throw Error('Add your Groq key first');
      const models = await groq.listModels(providers.config('groq').key, { fetchImpl });
      const ids = models.map(m => m.id), chat = ids.filter(id => !/whisper|tts|guard|playai|orpheus|distil/i.test(id));
      const pick = (prefs, pool) => prefs.map(re => pool.find(id => re.test(id))).find(Boolean) || pool[0];
      const patch = {};
      if (chat.length && !ids.includes(s.model)) patch.model = pick([/gpt-oss-120b/, /kimi-k2/, /llama-3\.3-70b/, /qwen/, /llama/], chat);
      if (chat.length && !ids.includes(s.visionModel)) patch.visionModel = pick([/llama-4-maverick/, /llama-4-scout/, /vision/i, /llama-4/], chat);
      if (Object.keys(patch).length) store.settings.update(patch);
      return models;
    },
    'GET /api/providers': () => providers.status(),
    'GET /api/providers/models': async (b, q) => {
      const id = q.get('id'); if (!Providers.PROVIDERS[id]) throw Error('Unknown provider');
      const list = await providers.models(id);
      const best = providers.pickModel(id, list);
      if (best && best !== providers.config(id).model) setProvider(id, { model: best });
      const code = providers.config(id).codeModel && list.some(m => m.id === providers.config(id).codeModel) ? providers.config(id).codeModel : providers.pickCodeModel(id, list);
      if (code !== providers.config(id).codeModel) setProvider(id, { codeModel: code });
      return { models: list, model: best, codeModel: code };
    },
    'POST /api/providers': async b => {
      if (Array.isArray(b.order)) store.settings.update({ providerOrder: b.order.filter(x => Providers.PROVIDERS[x]) });
      if (b.id) {
        if (!Providers.PROVIDERS[b.id]) throw Error('Unknown provider');
        setProvider(b.id, { ...(typeof b.key === 'string' ? { key: b.key.trim().slice(0, 300) } : {}), ...(typeof b.model === 'string' ? { model: b.model.slice(0, 200) } : {}), ...(typeof b.codeModel === 'string' ? { codeModel: b.codeModel.slice(0, 200) } : {}), ...(b.enabled !== undefined ? { enabled: !!b.enabled } : {}) });
        // a fresh key: check it works and pick a good free model
        if (typeof b.key === 'string' && b.key.trim()) {
          try { const list = await providers.models(b.id); const best = providers.pickModel(b.id, list); if (best) setProvider(b.id, { model: best }); setProvider(b.id, { codeModel: providers.pickCodeModel(b.id, list) }); return { ok: true, models: list.length, model: best, status: providers.status() }; }
          catch (e) { return { ok: false, error: e.message, status: providers.status() }; }
        }
      }
      return { ok: true, status: providers.status() };
    },
    'POST /api/memory': b => ({ memory: store.memory.set(String(b.memory ?? '')) }),
    'POST /api/project/open': b => openProject(String(b.path || '').trim().replace(/^"|"$/g, '')),
    'POST /api/project/close': () => { workspace = null; brain = null; store.settings.update({ projectPath: '' }); return projectInfo(); },
    'GET /api/project/tree': () => { if (!workspace) throw Error('No project open'); return workspace.tree(); },
    'GET /api/project/file': (b, q) => { if (!workspace) throw Error('No project open'); return workspace.readFile(q.get('path')); },
    'GET /api/checkpoints': () => workspace ? workspace.checkpoints() : [],
    'GET /api/convos': (b, q) => store.convos.search(q.get('q')),
    'GET /api/convo': (b, q) => store.convos.get(q.get('id')),
    'POST /api/convo/rename': b => store.convos.rename(b.id, b.title),
    'POST /api/convo/pin': b => store.convos.pin(b.id, b.pinned),
    'POST /api/convo/delete': b => store.convos.remove(b.id),
    'GET /api/change': (b, q) => { const ch = workspace?.getPending(q.get('id')); if (!ch) throw Error('That change is no longer pending (it may have been applied, rejected, or the app restarted).'); return agent.changeView(ch); },
    'POST /api/change/approve': b => {
      if (!workspace) throw Error('No project open');
      const ch = workspace.getPending(b.id);
      if (ch) { try { savepointsFor(workspace)?.save('before: ' + (ch.summary || ch.path)); } catch {} }
      const r = workspace.approve(b.id);
      if (b.convoId) { const c = store.convos.get(b.convoId); const ch = findChange(c, b.id); if (ch) { ch.status = 'applied'; ch.checkpoint = r.checkpoint; store.convos.save(c); } }
      return r;
    },
    'POST /api/change/reject': b => {
      if (workspace) workspace.reject(b.id);
      if (b.convoId) { const c = store.convos.get(b.convoId); const ch = findChange(c, b.id); if (ch) { ch.status = 'rejected'; store.convos.save(c); } }
      return { rejected: true };
    },
    'POST /api/undo': b => {
      if (!workspace) throw Error('No project open');
      const r = workspace.undo(b.checkpoint);
      if (b.convoId) { const c = store.convos.get(b.convoId); for (const m of c.messages) for (const ch of m.changes || []) if (ch.checkpoint === b.checkpoint) ch.status = 'undone'; store.convos.save(c); }
      return r;
    },
    'GET /api/library': () => ({ docs: library.list(), stats: library.stats() }),
    'POST /api/library/add': b => library.add({ title: b.title, text: /\.html?$/i.test(String(b.title)) ? web.htmlToText(String(b.text || '')).text : b.text, source: b.source || '', kind: b.kind || 'upload' }),
    'POST /api/library/url': async b => { const r = await web.readPage({ url: b.url, fetchImpl: webFetch, lookup, maxChars: 5_000_000 }); return library.add({ title: r.title, text: r.text, source: r.url, kind: 'web' }); },
    'POST /api/library/folder': b => library.addFolder(b.path),
    'POST /api/library/remove': b => library.remove(b.id),
    'GET /api/library/search': (b, q) => library.search(q.get('q') || '', 8),
    'GET /api/phone': () => phone.status(),
    'POST /api/phone': b => phone.update(b),
    'POST /api/approval': b => {
      const a = approvals.get(b.id);
      if (!a) throw Error('That request already finished');
      if (b.allow && b.always) allowAllFor.add(a.convoId);
      a.resolve({ allow: !!b.allow, reason: b.allow ? '' : String(b.reason || '').slice(0, 300) });
      return { ok: true };
    },
    'GET /api/savepoints': () => { const sp = savepointsFor(workspace); return { available: !!sp, git: Savepoints.hasGit(), list: sp ? sp.list(40) : [] }; },
    'POST /api/savepoints/save': b => { const sp = savepointsFor(workspace); if (!sp) throw Error(workspace ? (Savepoints.hasGit() ? 'Save points are off in Settings' : 'Install Git to use save points: https://git-scm.com/download/win') : 'Open a project first'); return sp.save(String(b.message || 'manual save')); },
    'POST /api/savepoints/restore': b => { const sp = savepointsFor(workspace); if (!sp) throw Error('Save points unavailable'); return sp.restore(String(b.hash || '')); },
    'GET /api/plan': () => workspace ? brain.plan.get() : null,
    'POST /api/plan/clear': () => { if (workspace) brain.plan.clear(); return { ok: true }; },
    'GET /api/lessons': () => workspace ? { text: brain.lessons.get() } : { text: '' },
    'POST /api/transcribe': async b => {
      const audio = Buffer.from(String(b.audio || '').replace(/^data:[^,]*,/, ''), 'base64');
      return docs.transcribe({ key: providers.config('groq').key, audio, mime: String(b.mime || 'audio/webm'), fetchImpl: fetchImpl || fetch });
    },
    'POST /api/stop': b => { running.get(b.convoId)?.abort(); return { ok: true }; }
  };

  // One request handler for both the computer (127.0.0.1) and, if turned on, your phone (PIN-protected).
  const handle = async (req, res, { remote = false } = {}) => {
    const url = new URL(req.url, 'http://localhost');
    if (remote) { if (await phone.gate(req, res)) return; }
    else {
      // Only answer requests meant for this local app (blocks DNS-rebinding tricks)
      const host = String(req.headers.host || '').replace(/:\d+$/, '');
      if (!['127.0.0.1', 'localhost'].includes(host)) { res.writeHead(403); return res.end('Forbidden'); }
      if (req.method === 'POST') { const o = req.headers.origin; if (o && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(o)) { res.writeHead(403); return res.end('Forbidden'); } }
    }
    try {
      if (req.method === 'GET' && url.pathname.startsWith('/api/image/')) {
        const f = store.images.file(url.pathname.slice(11));
        res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'image/jpeg', 'Cache-Control': 'max-age=86400' }); return fs.createReadStream(f).on('error', () => res.end()).pipe(res);
      }
      if (url.pathname === '/alpha') { res.writeHead(302, { Location: '/alpha/' }); return res.end(); }
      if (url.pathname.startsWith('/alpha/')) return await alpha.handle(req, res, url.pathname.slice(6), url.searchParams);
      if (req.method === 'POST' && url.pathname === '/api/chat') return await chat(req, res, await readBody(req));
      const handler = routes[req.method + ' ' + url.pathname];
      if (handler) return json(res, 200, await handler(req.method === 'POST' ? await readBody(req) : {}, url.searchParams));
      if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Unknown API route' });
      if (req.method === 'GET') return serveStatic(req, res, url.pathname);
      res.writeHead(405); res.end();
    } catch (e) {
      if (res.headersSent) { try { res.end(); } catch {} return; }
      json(res, 400, { error: e.message || String(e) });
    }
  };
  const phone = Phone.create({ dataDir, handler: handle, defaultPort: phonePort || 3780 });
  const server = http.createServer((req, res) => handle(req, res, { remote: !Phone.isLoopback(req.socket.remoteAddress) }));
  if (phoneAutostart && phone.enabled) phone.start();
  server.phone = phone;
  server.on('close', () => { alpha.stop(); phone.stop(); });
  return server;
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', e => { if (e.code === 'EADDRINUSE' && port !== 0) resolve(listen(server, 0)); else reject(e); });
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

if (require.main === module) {
  const server = createApp({ phoneAutostart: true });
  const want = Number(process.env.PORT) || 3737;
  listen(server, want).then(port => {
    const url = 'http://127.0.0.1:' + port;
    console.log('\n  Rutherford ' + VERSION + ' is running at ' + url + '\n  Your chats & settings: ' + defaultDataDir() + '\n  Keep this window open. Close it (or press Ctrl+C) to stop.\n');
    setTimeout(async () => { const ph = await server.phone.status(); if (ph.enabled) console.log(ph.running ? '  Phone access ON: ' + ph.urls.map(u => u.url).join('  or  ') + '\n' : '  Phone access could not start: ' + ph.error + '\n'); }, 500);
    if (!process.argv.includes('--no-open')) {
      const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
      try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref(); } catch {}
    }
  }).catch(e => { console.error('Could not start: ' + e.message); process.exit(1); });
}

module.exports = { createApp, listen };

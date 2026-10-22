'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmp, fakeGroq, startApp } = require('./helpers.cjs');

test('every file the page loads is actually served with the right type', async () => {
  const app = await startApp({ dataDir: tmp('rf-data-') });
  try {
    const html = await (await fetch(app.base + '/')).text();
    const refs = [...html.matchAll(/(?:src|href)="([^"#:]+)"/g)].map(m => m[1]);
    assert.ok(refs.length >= 10, 'expected scripts and styles in index.html');
    for (const ref of refs) {
      const r = await fetch(app.base + '/' + ref);
      assert.equal(r.status, 200, ref + ' should load');
      const type = r.headers.get('content-type');
      if (ref.endsWith('.js')) assert.match(type, /javascript/, ref);
      if (ref.endsWith('.css')) assert.match(type, /text\/css/, ref);
      await r.arrayBuffer();
    }
    // KaTeX font files referenced by its CSS exist
    const css = fs.readFileSync(path.join(__dirname, '../public/vendor/katex.min.css'), 'utf8');
    for (const f of new Set([...css.matchAll(/url\((fonts\/[^)]+\.woff2)\)/g)].map(m => m[1]))) assert.ok(fs.existsSync(path.join(__dirname, '../public/vendor', f)), f);
    // ids used by app.js exist in the html
    const js = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
    for (const id of new Set([...js.matchAll(/\$\('#([\w-]+)'\)/g)].map(m => m[1]))) {
      if (['setupKey', 'setupProv'].includes(id)) continue; // created dynamically
      assert.match(html, new RegExp('id="' + id + '"'), '#' + id + ' missing from index.html');
    }
  } finally { await app.close(); }
});

test('static files cannot escape the public folder; foreign hosts are refused', async () => {
  const app = await startApp({ dataDir: tmp('rf-data-') });
  try {
    for (const p of ['/..%2fserver.cjs', '/%2e%2e/package.json', '/vendor/../../server.cjs']) assert.equal((await fetch(app.base + p)).status, 404, p);
    const port = new URL(app.base).port;
    const r = await new Promise(res => require('node:http').get({ host: '127.0.0.1', port, path: '/api/state', headers: { Host: 'evil.example.com' } }, res));
    assert.equal(r.statusCode, 403);
    const post = await fetch(app.base + '/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' }, body: '{}' });
    assert.equal(post.status, 403);
  } finally { await app.close(); }
});

test('API key is saved locally but never sent back to the browser', async () => {
  const dataDir = tmp('rf-data-');
  const app = await startApp({ dataDir });
  try {
    const s = await app.api('settings', { groqKey: 'gsk_supersecret1234' });
    assert.equal(s.hasKey, true); assert.equal(s.keyHint, '…1234');
    const state = await app.api('state');
    assert.ok(!JSON.stringify(state).includes('supersecret'));
    assert.ok(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8').includes('gsk_supersecret1234'));
  } finally { await app.close(); }
});

test('plain chat streams text and saves the conversation', async () => {
  const g = fakeGroq([{ text: 'The answer is **42**.\n\n$$x^2$$' }]);
  const app = await startApp({ dataDir: tmp('rf-data-'), fetchImpl: g.fetchImpl });
  try {
    await app.api('settings', { groqKey: 'gsk_test' });
    const ev = await app.chat({ text: 'What is 6 x 7?' });
    assert.equal(ev[0].type, 'start');
    assert.equal(ev.filter(e => e.type === 'text').map(e => e.delta).join(''), 'The answer is **42**.\n\n$$x^2$$');
    const done = ev.find(e => e.type === 'done'); assert.ok(done);
    const sent = g.calls[0].body;
    assert.equal(sent.model, 'openai/gpt-oss-120b'); assert.equal(sent.stream, true);
    assert.ok(sent.max_tokens >= 4096, 'answers must not be cut short');
    assert.match(sent.messages[0].content, /You are Rutherford/);
    assert.ok(!sent.tools.some(t => t.function.name === 'read_file'), 'no project tools without a project');
    const list = await app.api('state');
    assert.equal(list.convos.length, 1); assert.equal(list.convos[0].title, 'What is 6 x 7?');
    const convo = await app.api('convo?id=' + ev[0].convo.id);
    assert.equal(convo.messages.length, 2); assert.equal(convo.messages[1].content, 'The answer is **42**.\n\n$$x^2$$');
  } finally { await app.close(); }
});

test('coding loop: reads, proposes an edit, nothing written until approved, then undo works', async () => {
  const proj = tmp('rf-proj-');
  fs.mkdirSync(path.join(proj, 'src'));
  fs.writeFileSync(path.join(proj, 'src/app.js'), 'function add(a, b) {\n  return a - b;\n}\nmodule.exports = add;\n');
  const g = fakeGroq([
    { tools: [{ name: 'search_project', args: { query: 'add' } }] },
    { tools: [{ name: 'read_file', args: { path: 'src/app.js' } }] },
    { text: 'Found it.', tools: [{ name: 'edit_file', args: { path: 'src/app.js', summary: 'Fix subtraction bug', edits: [{ find: 'return a - b;', replace: 'return a + b;' }] } }] },
    { text: 'Fixed: `add` was subtracting. Click **Apply**.' }
  ]);
  const app = await startApp({ dataDir: tmp('rf-data-'), fetchImpl: g.fetchImpl });
  try {
    await app.api('settings', { groqKey: 'gsk_test' });
    const p = await app.api('project/open', { path: proj });
    assert.equal(p.open, true);
    const ev = await app.chat({ text: 'add() is broken, fix it' });
    const types = ev.map(e => e.type);
    assert.deepEqual(ev.filter(e => e.type === 'tool' && e.name !== 'review').length, 3);
    assert.ok(ev.filter(e => e.type === 'tool_result').every(e => e.ok), JSON.stringify(ev.filter(e => e.type === 'tool_result')));
    const change = ev.find(e => e.type === 'change').change;
    assert.equal(change.status, 'pending'); assert.equal(change.added, 1); assert.equal(change.removed, 1);
    // tool results were fed back to the model with line numbers
    const readResult = g.calls[2].body.messages.find(m => m.role === 'tool' && m.content.includes('src/app.js (lines'));
    assert.ok(readResult && readResult.content.includes('   2│  return a - b;'));
    // not written yet
    assert.match(fs.readFileSync(path.join(proj, 'src/app.js'), 'utf8'), /a - b/);
    const convoId = ev[0].convo.id;
    const r = await app.api('change/approve', { id: change.id, convoId });
    assert.match(fs.readFileSync(path.join(proj, 'src/app.js'), 'utf8'), /a \+ b/);
    let convo = await app.api('convo?id=' + convoId);
    assert.equal(convo.messages[1].changes[0].status, 'applied');
    await app.api('undo', { checkpoint: r.checkpoint, convoId });
    assert.match(fs.readFileSync(path.join(proj, 'src/app.js'), 'utf8'), /a - b/);
    convo = await app.api('convo?id=' + convoId);
    assert.equal(convo.messages[1].changes[0].status, 'undone');
  } finally { await app.close(); }
});

test('bad edit (text not found) is reported back to the model, which can recover', async () => {
  const proj = tmp('rf-proj-'); fs.writeFileSync(path.join(proj, 'a.txt'), 'hello world\n');
  const g = fakeGroq([
    { tools: [{ name: 'edit_file', args: { path: 'a.txt', summary: 'x', edits: [{ find: 'HELLO', replace: 'bye' }] } }] },
    { tools: [{ name: 'edit_file', args: { path: 'a.txt', summary: 'x', edits: [{ find: 'hello', replace: 'bye' }] } }] },
    { text: 'Done.' }
  ]);
  const app = await startApp({ dataDir: tmp('rf-data-'), fetchImpl: g.fetchImpl });
  try {
    await app.api('settings', { groqKey: 'gsk_test' }); await app.api('project/open', { path: proj });
    const ev = await app.chat({ text: 'change it' });
    const results = ev.filter(e => e.type === 'tool_result');
    assert.equal(results[0].ok, false); assert.equal(results[1].ok, true);
    assert.match(g.calls[1].body.messages.at(-1).content, /Could not find this text/);
  } finally { await app.close(); }
});

test('undo refuses to wipe edits you made afterwards', async () => {
  const proj = tmp('rf-proj-'); fs.writeFileSync(path.join(proj, 'a.txt'), 'one\n');
  const W = require('../lib/workspace.cjs').open(proj);
  const ch = W.propose({ path: 'a.txt', content: 'two\n' });
  const { checkpoint } = W.approve(ch.id);
  fs.writeFileSync(path.join(proj, 'a.txt'), 'two\nmy own edit\n');
  assert.throws(() => W.undo(checkpoint), /edited after this change/);
  assert.equal(fs.readFileSync(path.join(proj, 'a.txt'), 'utf8'), 'two\nmy own edit\n');
});

test('approving a stale change is refused if the file changed meanwhile', () => {
  const proj = tmp('rf-proj-'); fs.writeFileSync(path.join(proj, 'a.txt'), 'one\n');
  const W = require('../lib/workspace.cjs').open(proj);
  const ch = W.propose({ path: 'a.txt', edits: [{ find: 'one', replace: 'uno' }] });
  fs.writeFileSync(path.join(proj, 'a.txt'), 'changed by me\n');
  assert.throws(() => W.approve(ch.id), /changed since/);
});

test('workspace blocks paths outside the project and secret folders', () => {
  const proj = tmp('rf-proj-'); fs.writeFileSync(path.join(proj, 'ok.txt'), 'x');
  const W = require('../lib/workspace.cjs').open(proj);
  for (const bad of ['../x.txt', '/etc/passwd', 'C:\\Windows\\win.ini', 'node_modules/a.js', '.git/config', 'a/../../b']) assert.throws(() => W.resolve(bad, false), undefined, bad);
  assert.ok(W.readFile('ok.txt').content === 'x');
  const created = W.propose({ path: 'new/dir/file.md', content: '# hi' });
  W.approve(created.id);
  assert.equal(fs.readFileSync(path.join(proj, 'new/dir/file.md'), 'utf8'), '# hi');
});

test('photo questions switch to the vision model and include the image', async () => {
  const g = fakeGroq([{ text: 'That is a triangle.' }]);
  const app = await startApp({ dataDir: tmp('rf-data-'), fetchImpl: g.fetchImpl });
  try {
    await app.api('settings', { groqKey: 'gsk_test' });
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const ev = await app.chat({ text: 'what shape', images: [png] });
    assert.ok(ev.find(e => e.type === 'done'));
    const body = g.calls[0].body;
    assert.equal(body.model, 'meta-llama/llama-4-scout-17b-16e-instruct');
    const last = body.messages.at(-1);
    assert.ok(Array.isArray(last.content) && last.content.some(c => c.type === 'image_url'));
    assert.equal(body.tools, undefined, 'no tools sent with images');
    const imgId = ev[0].user.images[0];
    assert.equal((await fetch(app.base + '/api/image/' + imgId)).status, 200);
  } finally { await app.close(); }
});

test('attachments are included for the model; rate limits give a clear message', async () => {
  const g = fakeGroq([{ status: 429, error: { message: 'Rate limit reached' }, headers: { 'retry-after': '12' } }]);
  const app = await startApp({ dataDir: tmp('rf-data-'), fetchImpl: g.fetchImpl });
  try {
    await app.api('settings', { groqKey: 'gsk_test' });
    const ev = await app.chat({ text: 'summarize', attachments: [{ name: 'notes.txt', text: 'Mitochondria is the powerhouse' }] });
    const err = ev.find(e => e.type === 'error');
    assert.match(err.message, /rate limit/i); assert.match(err.message, /12s/);
    assert.match(g.calls[0].body.messages.at(-1).content, /<attached_file name="notes.txt">\nMitochondria/);
  } finally { await app.close(); }
});

test('no key gives a setup message instead of a crash', async () => {
  const app = await startApp({ dataDir: tmp('rf-data-'), fetchImpl: fakeGroq([]).fetchImpl });
  try {
    const ev = await app.chat({ text: 'hi' });
    assert.equal(ev.find(e => e.type === 'error').code, 'nokey');
  } finally { await app.close(); }
});

test('remember + preview tools work, and memory goes into the next system prompt', async () => {
  const g = fakeGroq([
    { tools: [{ name: 'remember', args: { fact: 'Uses Windows 11' } }, { name: 'show_preview', args: { title: 'Detail Shop', html: '<!doctype html><html><body><h1>Elite Auto</h1></body></html>' } }] },
    { text: 'Here you go.' },
    { text: 'ok' }
  ]);
  const app = await startApp({ dataDir: tmp('rf-data-'), fetchImpl: g.fetchImpl });
  try {
    await app.api('settings', { groqKey: 'gsk_test' });
    const ev = await app.chat({ text: 'I use windows 11. make me a site' });
    assert.equal(ev.find(e => e.type === 'memory').line, 'Uses Windows 11');
    assert.equal(ev.find(e => e.type === 'preview').title, 'Detail Shop');
    const done = ev.find(e => e.type === 'done');
    assert.equal(done.message.preview.title, 'Detail Shop');
    await app.chat({ convoId: ev[0].convo.id, text: 'thanks' });
    assert.match(g.calls[2].body.messages[0].content, /Uses Windows 11/);
    assert.match(g.calls[2].body.messages.find(m => m.role === 'assistant').content, /Showed preview: "Detail Shop"/);
  } finally { await app.close(); }
});

test('diff shows only changed lines with context', () => {
  const { diffLines, hunks, stats } = require('../lib/diff.cjs');
  const a = Array.from({ length: 50 }, (_, i) => 'line ' + i).join('\n');
  const b = a.replace('line 25', 'LINE 25');
  const rows = diffLines(a, b);
  assert.deepEqual(stats(rows), { added: 1, removed: 1 });
  const h = hunks(rows);
  assert.ok(h.length < 12 && h[0].t === '…');
});

test('retired models are swapped for available ones when the model list loads', async () => {
  const g = fakeGroq([]);
  const app = await startApp({ dataDir: tmp('rf-data-'), fetchImpl: g.fetchImpl });
  try {
    await app.api('settings', { groqKey: 'gsk_test', model: 'old/retired-model', visionModel: 'old/retired-vision' });
    await app.api('models');
    const s = (await app.api('state')).settings;
    assert.equal(s.model, 'openai/gpt-oss-120b');
    assert.equal(s.visionModel, 'meta-llama/llama-4-scout-17b-16e-instruct');
  } finally { await app.close(); }
});

test('Alpha runs inside Rutherford at /alpha/ and shares the Groq key', async () => {
  const groqSent = [];
  const groqFetch = async (url, opts) => {
    if (url.includes('groq.com')) { groqSent.push(opts.headers.Authorization); return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }) + '\n\ndata: [DONE]\n\n'); }
    throw Error('unexpected ' + url);
  };
  const marketFetch = async url => {
    const u = new URL(url);
    if (u.pathname.endsWith('/ticker')) return Response.json({ price: '100' });
    if (u.pathname.endsWith('/stats')) return Response.json({ open: '90', high: '110', low: '80', volume: '1' });
    if (u.pathname.endsWith('/candles')) return Response.json(Array.from({ length: 50 }, (_, i) => [1700000000 - i * 300, 99, 101, 100, 100, 1]));
    return new Response('{}', { status: 404 });
  };
  const dataDir = tmp('rf-data-');
  const app = await startApp({ dataDir, fetchImpl: groqFetch, marketFetch });
  try {
    const r = await fetch(app.base + '/alpha', { redirect: 'manual' });
    assert.equal(r.status, 302); assert.equal(r.headers.get('location'), '/alpha/');
    const html = await (await fetch(app.base + '/alpha/')).text();
    assert.match(html, /Rutherford Alpha/);
    for (const ref of [...html.matchAll(/(?:src|href)="([^"#:]+)"/g)].map(m => m[1])) assert.equal((await fetch(app.base + '/alpha/' + ref)).status, 200, ref);
    assert.equal((await fetch(app.base + '/alpha/../Rutherford-Display-Lato-Light.ttf'.replace('/alpha/..', ''))).status, 200);
    const q = await (await fetch(app.base + '/alpha/api/quotes')).json();
    assert.equal(q[0].price, 100);
    await app.api('settings', { groqKey: 'gsk_shared' });
    const st = await (await fetch(app.base + '/alpha/api/state')).json();
    assert.equal(st.settings.keyFromRutherford, true);
    const ask = await fetch(app.base + '/alpha/api/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'hi' }) });
    assert.match(await ask.text(), /"done"/);
    assert.equal(groqSent[0], 'Bearer gsk_shared');
    // Alpha data is stored inside Rutherford's data folder
    await fetch(app.base + '/alpha/api/trade', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ side: 'buy', pair: 'BTC-USD', usd: 100 }) });
    assert.ok(fs.existsSync(path.join(dataDir, 'alpha', 'portfolio.json')));
  } finally { await app.close(); }
});

test('web search, reading a page and making an image all work as chat tools', async () => {
  const g = fakeGroq([
    { tools: [{ name: 'web_search', args: { query: 'bitcoin price today' } }, { name: 'read_webpage', args: { url: 'https://docs.example.com/guide' } }, { name: 'make_image', args: { prompt: 'neon race car' } }] },
    { text: 'BTC is about $70k [CoinDesk](https://www.coindesk.com/price/bitcoin). Here is your car.' }
  ]);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(2000, 7)]);
  const webCalls = [];
  const webFetch = async (url, opts) => {
    webCalls.push(url);
    if (url.startsWith('https://image.pollinations.ai/')) return new Response(jpeg, { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
    if (url === 'https://docs.example.com/guide') return new Response('<html><head><title>Guide</title><script>evil()</script></head><body><nav>menu</nav><h1>Install</h1><p>Run npm i &amp; go.</p></body></html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
    return new Response('nope', { status: 404 });
  };
  const lookup = async () => [{ address: '93.184.216.34' }];
  const app = await startApp({ dataDir: tmp('rf-data-'), fetchImpl: g.fetchImpl, webFetch, lookup });
  try {
    await app.api('settings', { groqKey: 'gsk_test' });
    const ev = await app.chat({ text: 'btc price? also read the guide and make me a neon race car' });
    const results = ev.filter(e => e.type === 'tool_result');
    assert.ok(results.every(r => r.ok), JSON.stringify(results));
    const toolMsgs = g.calls.find(c => c.body?.stream && c.body.messages.some(m => m.role === 'tool')).body.messages.filter(m => m.role === 'tool');
    assert.match(toolMsgs[0].content, /\$70,000/); assert.match(toolMsgs[0].content, /coindesk/);
    assert.match(toolMsgs[1].content, /## Install\nRun npm i & go\./); assert.doesNotMatch(toolMsgs[1].content, /evil|menu/);
    const img = ev.find(e => e.type === 'image'); assert.ok(img);
    assert.equal((await fetch(app.base + '/api/image/' + img.id)).status, 200);
    assert.ok(webCalls.some(u => u.includes(encodeURIComponent('neon race car'))));
    const done = ev.find(e => e.type === 'done').message;
    assert.equal(done.generated[0].id, img.id);
    assert.ok(done.sources.some(s => s.url.includes('coindesk')) && done.sources.some(s => s.url.includes('docs.example.com')));
    // main request advertised the tools
    assert.ok(g.calls[0].body.tools.some(t => t.function.name === 'web_search'));
  } finally { await app.close(); }
});

test('read_webpage refuses local network addresses', async () => {
  const web = require('../lib/web.cjs');
  for (const url of ['http://localhost:3737/api/state', 'http://192.168.1.1/', 'http://127.0.0.1/', 'file:///etc/passwd', 'http://[::1]/'])
    await assert.rejects(web.readPage({ url, fetchImpl: async () => new Response('x'), lookup: async () => [{ address: '8.8.8.8' }] }), undefined, url);
  await assert.rejects(web.readPage({ url: 'http://sneaky.example.com/', fetchImpl: async () => new Response('x'), lookup: async () => [{ address: '10.0.0.5' }] }), /blocked/);
});

test('web search can be switched off', async () => {
  const g = fakeGroq([{ text: 'ok' }]);
  const app = await startApp({ dataDir: tmp('rf-data-'), fetchImpl: g.fetchImpl });
  try {
    await app.api('settings', { groqKey: 'gsk_test', webSearch: false });
    await app.chat({ text: 'hi' });
    assert.ok(!g.calls[0].body.tools.some(t => t.function.name === 'web_search'));
    assert.ok(g.calls[0].body.tools.some(t => t.function.name === 'make_image'));
  } finally { await app.close(); }
});

test('Library: add text, a web page and a folder; the chat searches it', async () => {
  const folder = tmp('rf-docs-'); fs.mkdirSync(path.join(folder, 'guides'));
  fs.writeFileSync(path.join(folder, 'guides/tilemaps.md'), '# TileMap\n\nIn Godot 4 a TileMap uses a TileSet resource. Paint tiles with the TileMap editor and set collision per tile.');
  fs.writeFileSync(path.join(folder, 'image.png'), 'binary-ish');
  const webFetch = async () => new Response('<title>Signals</title><h1>Signals</h1><p>Use connect() to wire a signal to a callable.</p>', { headers: { 'Content-Type': 'text/html' } });
  const g = fakeGroq([{ tools: [{ name: 'search_library', args: { query: 'godot tilemap collision' } }] }, { text: 'Per your TileMap guide, set collision per tile.' }]);
  const app = await startApp({ dataDir: tmp('rf-data-'), fetchImpl: g.fetchImpl, webFetch, lookup: async () => [{ address: '1.1.1.1' }] });
  try {
    await app.api('settings', { groqKey: 'gsk_test' });
    await app.api('library/add', { title: 'Class notes.pdf', text: '--- Page 1 ---\nPhotosynthesis converts light to chemical energy.\n\n--- Page 2 ---\nChlorophyll absorbs red and blue light strongly.' });
    await app.api('library/url', { url: 'https://docs.example.com/signals' });
    const f = await app.api('library/folder', { path: folder }); assert.equal(f.added, 1);
    const lib = await app.api('library'); assert.equal(lib.stats.docs, 3);
    const hits = await app.api('library/search?q=' + encodeURIComponent('chlorophyll light'));
    assert.equal(hits[0].title, 'Class notes.pdf'); assert.equal(hits[0].where, 'p. 2');
    const ev = await app.chat({ text: 'how do I add collision to tiles?' });
    assert.ok(g.calls[0].body.tools.some(t => t.function.name === 'search_library'));
    assert.match(g.calls[0].body.messages[0].content, /Library has 3 document/);
    const toolMsg = g.calls[1].body.messages.find(m => m.role === 'tool');
    assert.match(toolMsg.content, /\[1\] guides\/tilemaps\.md/);
    assert.ok(ev.find(e => e.type === 'done'));
    await app.api('library/remove', { id: lib.docs[0].id });
    assert.equal((await app.api('library')).stats.docs, 2);
  } finally { await app.close(); }
});

test('phone access: off by default, PIN-protected, rate-limited, and the phone cannot change it', async () => {
  const port = 41000 + Math.floor(Math.random() * 2000);
  const app = await startApp({ dataDir: tmp('rf-data-'), phonePort: port });
  const phone = 'http://127.0.0.1:' + port;
  try {
    let st = await app.api('phone');
    assert.equal(st.enabled, false); assert.match(st.pin, /^\d{6}$/);
    await assert.rejects(fetch(phone + '/'), 'nothing listening while off');
    st = await app.api('phone', { enabled: true });
    assert.equal(st.running, true, st.error);
    // not signed in
    const page = await fetch(phone + '/'); assert.match(await page.text(), /Enter the PIN/);
    assert.equal((await fetch(phone + '/api/state')).status, 401);
    assert.equal((await fetch(phone + '/alpha/api/arena')).status, 401);
    assert.equal((await fetch(phone + '/manifest.json')).status, 200, 'home-screen manifest is public');
    const login = pin => fetch(phone + '/api/phone-login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'pin=' + pin });
    assert.match(await (await login('000000' === st.pin ? '111111' : '000000')).text(), /Wrong PIN/);
    const ok = await login(st.pin);
    assert.equal(ok.status, 303);
    const cookie = ok.headers.get('set-cookie').split(';')[0];
    assert.match(ok.headers.get('set-cookie'), /HttpOnly/);
    const auth = { headers: { Cookie: cookie } };
    assert.equal((await fetch(phone + '/api/state', auth)).status, 200);
    assert.equal((await fetch(phone + '/alpha/api/state', auth)).status, 200);
    const appHtml = await (await fetch(phone + '/', auth)).text(); assert.match(appHtml, /Message Rutherford/);
    // phone can't see the PIN or turn phone access off
    assert.equal((await fetch(phone + '/api/phone', auth)).status, 403);
    // cross-site POST blocked
    assert.equal((await fetch(phone + '/api/convo/delete', { method: 'POST', headers: { Cookie: cookie, Origin: 'https://evil.example.com', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    // brute force lockout
    for (let i = 0; i < 5; i++) await login('999999' === st.pin ? '888888' : '999999');
    assert.match(await (await login(st.pin)).text(), /Too many wrong PINs/);
    // new PIN signs everyone out
    await app.api('phone', { newPin: true });
    assert.equal((await fetch(phone + '/api/state', auth)).status, 401);
    await app.api('phone', { enabled: false });
    await assert.rejects(fetch(phone + '/'));
  } finally { await app.close(); }
});

// ---- free-brain chain ----
function multiProvider(script) {
  // script: { groq: [turns], gemini: [turns], ... } where turn = {text} | {status} | {tools}
  const calls = [];
  const hostOf = u => u.includes('groq.com') ? 'groq' : u.includes('googleapis.com') ? 'gemini' : u.includes('nvidia.com') ? 'nvidia' : u.includes('openrouter.ai') ? 'openrouter' : 'other';
  const fetchImpl = async (url, opts = {}) => {
    const p = hostOf(url); const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ p, url, body, auth: opts.headers?.Authorization });
    if (url.endsWith('/models')) {
      const data = { groq: [{ id: 'openai/gpt-oss-120b' }], gemini: [{ id: 'models/gemini-3.8-flash' }, { id: 'models/gemini-3.8-flash-lite' }, { id: 'models/imagen-4' }], nvidia: [{ id: 'openai/gpt-oss-120b' }, { id: 'meta/llama-3.3-70b-instruct' }], openrouter: [{ id: 'openai/gpt-oss-120b:free', pricing: { prompt: '0', completion: '0' } }, { id: 'anthropic/claude-x', pricing: { prompt: '0.000003', completion: '0.00001' } }] }[p];
      return new Response(JSON.stringify({ data }), { status: 200 });
    }
    const turn = (script[p] || []).shift();
    if (!turn) return new Response(JSON.stringify({ error: { message: 'no script for ' + p } }), { status: 500 });
    if (turn.status) return new Response(JSON.stringify([{ error: { message: turn.msg || 'limit' } }]), { status: turn.status, headers: turn.headers || {} });
    const events = [];
    if (turn.text) events.push({ choices: [{ delta: { content: turn.text } }] });
    (turn.tools || []).forEach(t => events.push({ choices: [{ delta: { tool_calls: [{ id: 'c' + Math.random(), type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args) } }] } }] })); // no "index", like Gemini
    events.push({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { total_tokens: 1234 } });
    return new Response(events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join('') + 'data: [DONE]\n\n', { status: 200 });
  };
  return { fetchImpl, calls };
}

test('free-brain chain: switches to the next provider when one hits its limit, and tracks usage', async () => {
  const mp = multiProvider({ groq: [{ status: 429, headers: { 'retry-after': '120' } }], gemini: [{ text: 'Answer from Gemini' }, { text: 'Second answer' }] });
  const app = await startApp({ dataDir: tmp('rf-data-'), fetchImpl: mp.fetchImpl });
  try {
    await app.api('settings', { groqKey: 'gsk_g' });
    const saved = await app.api('providers', { id: 'gemini', key: 'AIza_test' });
    assert.equal(saved.ok, true); assert.equal(saved.model, 'gemini-3.8-flash', 'picks a good flash model, skips image models');
    const ev = await app.chat({ text: 'hi' });
    assert.equal(ev.filter(e => e.type === 'text').map(e => e.delta).join(''), 'Answer from Gemini');
    assert.ok(ev.some(e => e.type === 'brain' && e.id === 'gemini'));
    const done = ev.find(e => e.type === 'done').message;
    assert.equal(done.provider, 'Google Gemini'); assert.equal(done.model, 'gemini-3.8-flash');
    const g = mp.calls.find(c => c.p === 'gemini' && c.body?.stream);
    assert.equal(g.auth, 'Bearer AIza_test'); assert.match(g.url, /generativelanguage\.googleapis\.com\/v1beta\/openai\/chat\/completions/);
    // Groq is resting now: the next message goes straight to Gemini
    await app.chat({ convoId: ev[0].convo.id, text: 'again' });
    assert.equal(mp.calls.filter(c => c.p === 'groq' && c.body?.stream).length, 1);
    const st = await app.api('providers');
    const gq = st.find(x => x.id === 'groq'), gm = st.find(x => x.id === 'gemini');
    assert.ok(gq.resting); assert.equal(gq.today.errors, 1);
    assert.equal(gm.today.requests, 2); assert.equal(gm.today.tokens, 2468);
    assert.ok(!JSON.stringify(await app.api('state')).includes('AIza_test'), 'keys never sent to the browser');
  } finally { await app.close(); }
});

test('OpenRouter only offers free models; reordering changes who answers first', async () => {
  const mp = multiProvider({ openrouter: [{ text: 'free answer' }] });
  const app = await startApp({ dataDir: tmp('rf-data-'), fetchImpl: mp.fetchImpl });
  try {
    await app.api('providers', { id: 'openrouter', key: 'sk-or-x' });
    const m = await app.api('providers/models?id=openrouter');
    assert.deepEqual(m.models.map(x => x.id), ['openai/gpt-oss-120b:free']);
    await app.api('providers', { id: 'nvidia', key: 'nvapi-x' });
    await app.api('providers', { order: ['openrouter', 'nvidia', 'groq', 'gemini'] });
    const ev = await app.chat({ text: 'hi' });
    assert.ok(ev.some(e => e.type === 'brain' && e.id === 'openrouter'));
    assert.equal(mp.calls.find(c => c.body?.stream).p, 'openrouter');
  } finally { await app.close(); }
});

test('think harder sends a high reasoning effort, and falls back if a provider refuses it', async () => {
  const mp = multiProvider({ groq: [{ status: 400, msg: 'reasoning_effort not supported' }, { text: 'ok' }] });
  const app = await startApp({ dataDir: tmp('rf-data-'), fetchImpl: mp.fetchImpl });
  try {
    await app.api('settings', { groqKey: 'gsk_g' });
    const ev = await app.chat({ text: 'hard question', think: true });
    assert.ok(ev.find(e => e.type === 'done'));
    const sent = mp.calls.filter(c => c.p === 'groq' && c.body?.stream);
    assert.equal(sent[0].body.reasoning_effort, 'high'); assert.equal(sent[1].body.reasoning_effort, undefined);
    assert.ok(sent[0].body.max_tokens > 8192);
  } finally { await app.close(); }
});

test('run_code tool: the AI can run JavaScript in a locked-down runner', async () => {
  const mp = multiProvider({ gemini: [{ tools: [{ name: 'run_code', args: { code: 'let s=0; for (let i=1;i<=100;i++) s+=i; console.log(s); console.log(require("fs") ? "fs?" : "")' } }] }, { text: 'The sum is 5050.' }] });
  const app = await startApp({ dataDir: tmp('rf-data-'), fetchImpl: mp.fetchImpl });
  try {
    await app.api('providers', { id: 'gemini', key: 'AIza_test' });
    const ev = await app.chat({ text: 'sum 1..100' });
    const code = ev.find(e => e.type === 'code');
    assert.match(code.output, /5050/);
    const toolMsg = mp.calls.filter(c => c.p === 'gemini' && c.body?.stream)[1].body.messages.find(m => m.role === 'tool');
    assert.match(toolMsg.content, /5050/);
    const done = ev.find(e => e.type === 'done').message;
    assert.equal(done.codeRuns.length, 1);
    assert.ok(mp.calls[1].body?.tools?.some(t => t.function?.name === 'run_code'));
  } finally { await app.close(); }
});

test('photos go to Gemini when there is no Groq key; no keys at all gives a setup message', async () => {
  const mp = multiProvider({ gemini: [{ text: 'A triangle' }] });
  const app = await startApp({ dataDir: tmp('rf-data-'), fetchImpl: mp.fetchImpl });
  try {
    let ev = await app.chat({ text: 'hi' });
    assert.equal(ev.find(e => e.type === 'error').code, 'nokey');
    await app.api('providers', { id: 'gemini', key: 'AIza_test' });
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    ev = await app.chat({ text: 'what is this', images: [png] });
    assert.ok(ev.find(e => e.type === 'done'));
    const body = mp.calls.find(c => c.p === 'gemini' && c.body?.stream).body;
    assert.equal(body.model, 'gemini-3.8-flash');
    assert.ok(body.messages.at(-1).content.some(c => c.type === 'image_url'));
  } finally { await app.close(); }
});

test('phone QR picks the real Wi-Fi address and hides virtual adapters', () => {
  const { lanAddresses } = require('../lib/phone.cjs');
  const ifaces = {
    'vEthernet (WSL (Hyper-V firewall))': [{ family: 'IPv4', address: '10.0.0.23', internal: false }],
    'Wi-Fi': [{ family: 'IPv4', address: '192.168.1.198', internal: false }],
    'Tailscale': [{ family: 'IPv4', address: '100.101.1.2', internal: false }],
    'Ethernet 3': [{ family: 'IPv4', address: '169.254.10.1', internal: false }],
  };
  const withRoute = lanAddresses('192.168.1.198', ifaces);
  assert.equal(withRoute[0].ip, '192.168.1.198'); assert.ok(withRoute[0].primary);
  assert.ok(withRoute.find(a => a.ip === '10.0.0.23').virtual);
  assert.ok(!withRoute.some(a => a.ip.startsWith('169.254.')));
  // even without a route (offline), the virtual adapter never comes first
  const noRoute = lanAddresses(null, ifaces);
  assert.equal(noRoute[0].ip, '192.168.1.198');
});

test('phone test button checks each address answers', async () => {
  const port = 39000 + Math.floor(Math.random() * 900);
  const app = await startApp({ dataDir: tmp('rf-data-'), phonePort: port });
  try {
    await app.api('phone', { enabled: true });
    const st = await app.api('phone', { test: true });
    assert.ok(Array.isArray(st.test));
    assert.equal(st.test.length, st.urls.length);
    for (const t of st.test) assert.equal(typeof t.ok, 'boolean');
    await app.api('phone', { enabled: false });
  } finally { await app.close?.(); }
});

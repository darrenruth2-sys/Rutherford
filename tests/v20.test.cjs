'use strict';
// Rutherford 20: run→fix loop, build mode, project brain, eyes, reviewer, save points,
// coding brains, Python, docs lookup, voice, personality.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tmp, fakeGroq, startApp } = require('./helpers.cjs');
const runner = require('../lib/runner.cjs');
const eyes = require('../lib/eyes.cjs');
const Savepoints = require('../lib/savepoints.cjs');
const Brain = require('../lib/projectbrain.cjs');
const docs = require('../lib/docs.cjs');

const hasPython = !!runner.findPython();
const hasBrowser = !!eyes.findBrowser();
const hasGit = Savepoints.hasGit();

function project(files) {
  const dir = tmp('rf-proj-');
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  return dir;
}
const sysPrompt = g => g.calls.find(c => c.body?.messages?.[0]?.role === 'system' && !/strict senior/.test(c.body.messages[0].content))?.body.messages[0].content || '';

test('run→fix loop: asks first, applies the pending fix, runs the test, sees the failure, fixes, passes', async () => {
  const proj = project({ 'math.js': 'exports.add = (a, b) => a - b;\n', 'test.js': "const assert = require('assert');\nassert.equal(require('./math').add(2, 3), 5);\nconsole.log('all good');\n" });
  const g = fakeGroq([
    { tools: [{ name: 'run_command', args: { command: 'node test.js', why: 'see if tests pass' } }] },
    { tools: [{ name: 'edit_file', args: { path: 'math.js', summary: 'fix add', edits: [{ find: 'a - b', replace: 'a + b' }] } }] },
    { tools: [{ name: 'run_command', args: { command: 'node test.js' } }] },
    { tools: [{ name: 'save_lesson', args: { lesson: 'add() had a minus sign; tests are in test.js (run: node test.js)' } }] },
    { text: 'Fixed and tested: all good.' }
  ]);
  const app = await startApp({ dataDir: tmp('rf-data-'), fetchImpl: g.fetchImpl });
  try {
    await app.api('settings', { groqKey: 'gsk_test', savePoints: false });
    await app.api('project/open', { path: proj });
    const approvals = [];
    const ev = await app.chatLive({ text: 'run the tests and fix what fails' }, async e => {
      if (e.type === 'approval') { approvals.push(e); await app.api('approval', { id: e.id, allow: true }); }
    });
    assert.equal(approvals.length, 2, 'asked before each command');
    assert.equal(approvals[0].command, 'node test.js'); assert.deepEqual(approvals[0].pending, []);
    assert.deepEqual(approvals[1].pending, ['math.js'], 'second approval also applies the pending edit');
    const cmds = ev.filter(e => e.type === 'command');
    assert.equal(cmds[0].ok, false); assert.match(cmds[0].output, /AssertionError|Expected/);
    assert.equal(cmds[1].ok, true); assert.match(cmds[1].output, /all good/);
    assert.ok(ev.some(e => e.type === 'change_status' && e.status === 'applied'));
    assert.equal(fs.readFileSync(path.join(proj, 'math.js'), 'utf8'), 'exports.add = (a, b) => a + b;\n');
    // the model got the real error output
    const toolMsgs = g.calls.flatMap(c => c.body?.messages || []).filter(m => m.role === 'tool');
    assert.ok(toolMsgs.some(m => /FAILED with exit code 1/.test(m.content)));
    // lesson saved, and shows up in the next chat's prompt
    assert.match(fs.readFileSync(path.join(proj, '.rutherford/lessons.md'), 'utf8'), /minus sign/);
    const done = ev.find(e => e.type === 'done').message;
    assert.equal(done.commands.length, 2);
    const g2 = fakeGroq([{ text: 'ok' }]);
    const app2 = await startApp({ dataDir: tmp('rf-data-'), fetchImpl: g2.fetchImpl });
    try { await app2.api('settings', { groqKey: 'k' }); await app2.api('project/open', { path: proj }); await app2.chat({ text: 'hi' }); assert.match(sysPrompt(g2), /minus sign/); assert.match(sysPrompt(g2), /math\.js \(1 lines\)/); }
    finally { await app2.close(); }
  } finally { await app.close(); }
});

test('run_command: saying no is respected and reported; "allow all" skips later prompts', async () => {
  const proj = project({ 'a.txt': 'x' });
  const g = fakeGroq([
    { tools: [{ name: 'run_command', args: { command: 'node -e "require(\'fs\').writeFileSync(\'hacked.txt\',\'1\')"' } }] },
    { text: 'OK, I won\'t.' },
    { tools: [{ name: 'run_command', args: { command: 'node -e "console.log(1)"' } }] },
    { tools: [{ name: 'run_command', args: { command: 'node -e "console.log(2)"' } }] },
    { text: 'Ran both.' }
  ]);
  const app = await startApp({ dataDir: tmp('rf-data-'), fetchImpl: g.fetchImpl });
  try {
    await app.api('settings', { groqKey: 'k', savePoints: false });
    await app.api('project/open', { path: proj });
    const ev = await app.chatLive({ text: 'do it' }, async e => { if (e.type === 'approval') await app.api('approval', { id: e.id, allow: false, reason: 'nah' }); });
    assert.ok(!fs.existsSync(path.join(proj, 'hacked.txt')), 'denied command never ran');
    assert.ok(ev.find(e => e.type === 'command').denied);
    assert.ok(g.calls.flatMap(c => c.body?.messages || []).some(m => m.role === 'tool' && /said NO.*nah/.test(m.content)));
    const convoId = ev[0].convo.id; let asked = 0;
    const ev2 = await app.chatLive({ convoId, text: 'run two things' }, async e => { if (e.type === 'approval') { asked++; await app.api('approval', { id: e.id, allow: true, always: true }); } });
    assert.equal(asked, 1, 'allow-all for this chat skips the second prompt');
    assert.deepEqual(ev2.filter(e => e.type === 'command').map(c => c.output.trim()), ['1', '2']);
    await assert.rejects(app.api('approval', { id: 'nope', allow: true }), /already finished/);
  } finally { await app.close(); }
});

test('auto-run safe commands mode runs tests without asking, still asks for anything else', async () => {
  assert.ok(runner.isSafe('npm test')); assert.ok(runner.isSafe('node --test')); assert.ok(runner.isSafe('git status'));
  assert.ok(!runner.isSafe('npm test && del *')); assert.ok(!runner.isSafe('rm -rf .')); assert.ok(!runner.isSafe('npm install evil')); assert.ok(!runner.isSafe('node x.js'));
  const proj = project({ 'package.json': '{"scripts":{"test":"node -e \\"console.log(\'tests ran\')\\""}}' });
  const g = fakeGroq([{ tools: [{ name: 'run_command', args: { command: 'npm test' } }] }, { tools: [{ name: 'run_command', args: { command: 'node -e "1"' } }] }, { text: 'done' }]);
  const app = await startApp({ dataDir: tmp('rf-data-'), fetchImpl: g.fetchImpl });
  try {
    await app.api('settings', { groqKey: 'k', autoRun: 'safe', savePoints: false });
    await app.api('project/open', { path: proj });
    const asked = [];
    const ev = await app.chatLive({ text: 'test it' }, async e => { if (e.type === 'approval') { asked.push(e.command); await app.api('approval', { id: e.id, allow: true }); } });
    assert.deepEqual(asked, ['node -e "1"']);
    assert.match(ev.find(e => e.type === 'command').output, /tests ran/);
  } finally { await app.close(); }
});

test('build mode: plan → edits applied right away → save points → plan persists for resume', { skip: !hasGit && 'git not installed' }, async () => {
  const proj = project({ 'README.md': '# game\n' });
  const g = fakeGroq([
    { tools: [{ name: 'update_plan', args: { goal: 'Snake game', steps: [{ text: 'Board + snake', status: 'doing' }, { text: 'Food + score', status: 'todo' }] } }] },
    { tools: [{ name: 'write_file', args: { path: 'snake.js', content: 'console.log("snake ok")\n', summary: 'snake' } }] },
    { tools: [{ name: 'run_command', args: { command: 'node snake.js' } }] },
    { tools: [{ name: 'update_plan', args: { goal: 'Snake game', steps: [{ text: 'Board + snake', status: 'done' }, { text: 'Food + score', status: 'todo' }] } }] },
    { text: 'Step 1 works. Say continue for step 2.' }
  ]);
  const app = await startApp({ dataDir: tmp('rf-data-'), fetchImpl: g.fetchImpl });
  try {
    await app.api('settings', { groqKey: 'k' });
    await app.api('project/open', { path: proj });
    const ev = await app.chatLive({ text: 'build me a snake game', build: true }, async e => { if (e.type === 'approval') { assert.deepEqual(e.pending, [], 'build mode already applied the file'); await app.api('approval', { id: e.id, allow: true }); } });
    assert.match(sysPrompt(g), /BUILD MODE is on/);
    assert.equal(ev.find(e => e.type === 'change').change.status, 'applied');
    assert.equal(fs.readFileSync(path.join(proj, 'snake.js'), 'utf8'), 'console.log("snake ok")\n');
    assert.match(ev.find(e => e.type === 'command').output, /snake ok/);
    assert.equal(ev.filter(e => e.type === 'plan').length, 2);
    const sps = ev.filter(e => e.type === 'savepoint');
    assert.ok(sps.length >= 2, 'save point before and after: ' + JSON.stringify(sps));
    const list = await app.api('savepoints');
    assert.ok(list.available && list.list.length >= 2);
    assert.match(list.list[0].message, /after: build me a snake game/);
    // plan saved in the project → resumes in a new chat
    const st = await app.api('state'); assert.deepEqual(st.project.plan, { goal: 'Snake game', left: 1, total: 2 });
    const g2 = fakeGroq([{ text: 'Continuing with step 2' }]);
    const app2 = await startApp({ dataDir: tmp('rf-data-'), fetchImpl: g2.fetchImpl });
    try { await app2.api('settings', { groqKey: 'k' }); await app2.api('project/open', { path: proj }); await app2.chat({ text: 'continue' }); assert.match(sysPrompt(g2), /\[x\] 1\. Board \+ snake\n\[ \] 2\. Food \+ score/); }
    finally { await app2.close(); }
    // going back to the first save point removes snake.js (and that restore can be undone)
    const first = list.list.at(-1);
    const r = await app.api('savepoints/restore', { hash: first.short });
    assert.equal(r.restored, first.short);
    assert.ok(!fs.existsSync(path.join(proj, 'snake.js')));
    assert.ok(fs.existsSync(path.join(proj, 'README.md')));
  } finally { await app.close(); }
});

test('save points skip node_modules and .env, and work with an existing repo', { skip: !hasGit && 'git not installed' }, () => {
  const proj = project({ 'a.js': '1', '.env': 'SECRET=1', '.env.example': 'SECRET=', 'node_modules/x/index.js': 'x' });
  spawnSync('git', ['init', '-q'], { cwd: proj });
  const sp = Savepoints.create(proj);
  assert.equal(sp.save('one').saved, true);
  assert.equal(sp.save('two').saved, false, 'nothing changed');
  const files = spawnSync('git', ['ls-files'], { cwd: proj, encoding: 'utf8' }).stdout.trim().split('\n').sort();
  assert.deepEqual(files, ['.env.example', 'a.js']);
  assert.throws(() => sp.restore('zzz'), /Invalid/);
});

test('project brain: map of functions, library versions, RUTHERFORD.md notes go into the prompt', async () => {
  const proj = project({
    'package.json': JSON.stringify({ dependencies: { phaser: '^3.80.0' }, scripts: { dev: 'vite', test: 'vitest' } }),
    'node_modules/phaser/package.json': '{"version":"3.80.1"}',
    'src/game.js': 'export class Game {\n  update(dt) {\n  }\n}\nfunction spawnEnemy(x) {}\nconst fire = (a) => a;\n',
    'scripts/tool.py': 'def main():\n    pass\nclass Thing:\n    pass\n',
    'RUTHERFORD.md': '# Notes\nAlways use TypeScript-free plain JS. Mobile first.\n'
  });
  const m = Brain.create(require('../lib/workspace.cjs').open(proj)).map();
  assert.match(m.text, /src\/game\.js \(\d+ lines\): Game, update, spawnEnemy, fire/);
  assert.match(m.text, /scripts\/tool\.py \(\d+ lines\): main, Thing/);
  const g = fakeGroq([{ text: 'ok' }]);
  const app = await startApp({ dataDir: tmp('rf-data-'), fetchImpl: g.fetchImpl });
  try {
    await app.api('settings', { groqKey: 'k' });
    const st = await app.api('project/open', { path: proj }); assert.equal(st.notes, true);
    await app.chat({ text: 'what does this do' });
    const p = sysPrompt(g);
    assert.match(p, /phaser@3\.80\.1/); assert.match(p, /npm scripts: dev, test/);
    assert.match(p, /Mobile first/); assert.match(p, /spawnEnemy/);
  } finally { await app.close(); }
});

test('second opinion: a different brain reviews code changes; real issues get fixed in the same answer', async () => {
  const proj = project({ 'a.js': 'let x = 1;\n' });
  const g = fakeGroq([
    { tools: [{ name: 'edit_file', args: { path: 'a.js', summary: 'divide', edits: [{ find: 'let x = 1;', replace: 'let x = 1 / y;' }] } }] },
    { text: 'Done.' },
    { review: '- a.js: `y` is never defined, this crashes.' },
    { tools: [{ name: 'edit_file', args: { path: 'a.js', summary: 'define y', edits: [{ find: 'let x = 1 / y;', replace: 'const y = 2;\nlet x = 1 / y;' }] } }] },
    { text: 'Good catch, fixed: y is defined now.' }
  ]);
  const app = await startApp({ dataDir: tmp('rf-data-'), fetchImpl: g.fetchImpl });
  try {
    await app.api('settings', { groqKey: 'k' });
    await app.api('providers', { id: 'gemini', key: 'gem-key' });
    await app.api('project/open', { path: proj });
    const ev = await app.chat({ text: 'make x divide by y' });
    const rv = ev.find(e => e.type === 'review');
    assert.equal(rv.ok, false); assert.match(rv.text, /never defined/);
    // the reviewer was a different provider than the writer
    const reviewCall = g.calls.find(c => /strict senior/.test(c.body?.messages?.[0]?.content || ''));
    assert.match(reviewCall.url, /generativelanguage/);
    // second edit merged into the still-pending first one
    const changes = ev.filter(e => e.type === 'change').map(e => e.change);
    assert.equal(changes.length, 2);
    assert.ok(ev.some(e => e.type === 'change_status' && e.id === changes[0].id && e.status === 'merged'));
    const final = await app.api('change?id=' + changes[1].id);
    assert.ok(final.diff.some(r => r.t === '+' && /const y = 2/.test(r.text)));
    await app.api('change/approve', { id: changes[1].id });
    assert.equal(fs.readFileSync(path.join(proj, 'a.js'), 'utf8'), 'const y = 2;\nlet x = 1 / y;\n');
    assert.match(ev.find(e => e.type === 'done').message.content, /fixed/);
  } finally { await app.close(); }
});

test('reviewer can be turned off; LGTM adds no extra round', async () => {
  const proj = project({ 'a.js': '1' });
  const mk = () => fakeGroq([{ tools: [{ name: 'write_file', args: { path: 'b.js', content: '2', summary: 'b' } }] }, { text: 'done' }]);
  for (const reviewer of [true, false]) {
    const g = mk();
    const app = await startApp({ dataDir: tmp('rf-data-'), fetchImpl: g.fetchImpl });
    try {
      await app.api('settings', { groqKey: 'k', reviewer });
      await app.api('project/open', { path: proj });
      const ev = await app.chat({ text: 'add b' });
      const reviews = g.calls.filter(c => /strict senior/.test(c.body?.messages?.[0]?.content || ''));
      assert.equal(reviews.length, reviewer ? 1 : 0);
      if (reviewer) assert.equal(ev.find(e => e.type === 'review').ok, true);
    } finally { await app.close(); }
  }
});

test('coding brain: projects use each provider\'s coding model, and fall back to the normal one when it\'s tired', async () => {
  const g = fakeGroq([{ status: 429, error: { message: 'pro quota' } }, { text: 'answer from flash' }, { text: 'chat answer' }]);
  const models = { 'gemini-2.5-pro': 1, 'gemini-2.5-flash': 1, 'gemini-2.5-flash-lite': 1 };
  const fetchImpl = async (url, o) => url.endsWith('/models') ? new Response(JSON.stringify({ data: Object.keys(models).map(id => ({ id: 'models/' + id })) }), { status: 200 }) : g.fetchImpl(url, o);
  const app = await startApp({ dataDir: tmp('rf-data-'), fetchImpl });
  try {
    const r = await app.api('providers', { id: 'gemini', key: 'gem' });
    assert.equal(r.ok, true); assert.equal(r.model, 'gemini-2.5-flash');
    const st = r.status.find(p => p.id === 'gemini'); assert.equal(st.codeModel, 'gemini-2.5-pro');
    await app.api('project/open', { path: project({ 'a.js': '1' }) });
    await app.chat({ text: 'refactor' });
    const used = g.calls.filter(c => c.body?.model).map(c => c.body.model);
    assert.deepEqual(used, ['gemini-2.5-pro', 'gemini-2.5-flash']);
    await app.api('project/close', {});
    await app.chat({ text: 'what is 2+2' });
    assert.equal(g.calls.filter(c => c.body?.model).at(-1).body.model, 'gemini-2.5-flash', 'normal chat uses the normal brain');
  } finally { await app.close(); }
});

test('python runner: exact math, charts come back as images, guard rails block damage', { skip: !hasPython && 'python not installed' }, async () => {
  let r = await runner.runPython('from fractions import Fraction\nprint(Fraction(1,3)+Fraction(1,6))');
  assert.equal(r.output.trim(), '1/2');
  r = await runner.runPython('import os\nos.remove(os.path.expanduser("~/../important.txt"))');
  assert.equal(r.ok, false); assert.match(r.output, /blocked/);
  r = await runner.runPython('import subprocess\nsubprocess.run(["echo","hi"])');
  assert.match(r.output, /blocked subprocess/);
  r = await runner.runPython('import socket\nsocket.create_connection(("example.com", 80))');
  assert.match(r.output, /blocked socket/);
  r = await runner.runPython('while True: pass', { timeoutSec: 2 });
  assert.equal(r.timedOut, true);
  // through the chat
  const g = fakeGroq([{ tools: [{ name: 'run_python', args: { code: 'print(sum(range(101)))' } }] }, { text: '5050' }]);
  const app = await startApp({ dataDir: tmp('rf-data-'), fetchImpl: g.fetchImpl });
  try {
    await app.api('settings', { groqKey: 'k' });
    const ev = await app.chat({ text: 'sum 1..100' });
    assert.equal(ev.find(e => e.type === 'code').output.trim(), '5050');
    assert.equal(ev.find(e => e.type === 'code').lang, 'python');
    assert.match(sysPrompt(g), /run_python/);
  } finally { await app.close(); }
});

test('python charts: a saved plot shows up in the chat', { skip: !(hasPython && spawnSync(runner.findPython()[0], [...runner.findPython().slice(1), '-c', 'import matplotlib']).status === 0) && 'matplotlib not installed' }, async () => {
  const g = fakeGroq([{ tools: [{ name: 'run_python', args: { code: 'import matplotlib.pyplot as plt\nplt.plot([1,2,3],[1,4,9])\nplt.savefig("chart.png")\nprint("saved")' } }] }, { text: 'Here is your chart.' }]);
  const app = await startApp({ dataDir: tmp('rf-data-'), fetchImpl: g.fetchImpl });
  try {
    await app.api('settings', { groqKey: 'k' });
    const ev = await app.chat({ text: 'plot y=x^2' });
    const img = ev.find(e => e.type === 'image'); assert.ok(img);
    const res = await fetch(app.base + '/api/image/' + img.id); assert.equal(res.status, 200); assert.equal(res.headers.get('content-type'), 'image/png');
  } finally { await app.close(); }
});

test('eyes: looks at the preview in a real browser, plays it, catches JS errors, a vision brain describes it', { skip: !hasBrowser && 'no Chrome/Edge' }, async () => {
  const html = '<!doctype html><title>Box</title><body><canvas id=c width=200 height=100></canvas><button id=go>Go</button><p id=s>0</p><script>let n=0;go.onclick=()=>s.textContent=++n;addEventListener("keydown",e=>{if(e.key==="ArrowRight")s.textContent="right"});oops();</script>';
  const g = fakeGroq([
    { tools: [{ name: 'show_preview', args: { title: 'Box', html } }] },
    { tools: [{ name: 'look_at_page', args: { target: 'preview', check: 'does Go work', actions: [{ click: '#go' }, { key: 'ArrowRight' }, { click: '#missing' }] } }] },
    { text: 'There is a ReferenceError: oops is not defined. Fixing.' }
  ]);
  const app = await startApp({ dataDir: tmp('rf-data-'), fetchImpl: g.fetchImpl });
  try {
    await app.api('settings', { groqKey: 'k' });
    const ev = await app.chat({ text: 'make a box game and check it' });
    const shot = ev.find(e => e.type === 'shot');
    assert.ok(shot, JSON.stringify(ev.filter(e => e.type === 'tool_result')));
    assert.match(shot.errors.join(' '), /oops is not defined/);
    assert.deepEqual(shot.notes, ['clicked #go', 'pressed ArrowRight', 'click: nothing matches "#missing"']);
    assert.match(shot.seen, /orange square/);
    const png = await fetch(app.base + '/api/image/' + shot.id); assert.equal(png.status, 200);
    assert.ok((await png.arrayBuffer()).byteLength > 500);
    const toolMsg = g.calls.flatMap(c => c.body?.messages || []).filter(m => m.role === 'tool').map(m => m.content).join('\n');
    assert.match(toolMsg, /JavaScript errors:\n- ReferenceError: oops is not defined/);
    // the vision brain got an actual image
    const vis = g.calls.find(c => Array.isArray(c.body?.messages?.[0]?.content));
    assert.match(vis.body.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
    assert.ok(ev.find(e => e.type === 'done').message.shots.length === 1);
  } finally { await app.close(); }
});

test('eyes: only local pages, and project files open from the project', { skip: !hasBrowser && 'no Chrome/Edge' }, async () => {
  const proj = project({ 'index.html': '<title>Mine</title><h1>Hello</h1>' });
  const g = fakeGroq([
    { tools: [{ name: 'look_at_page', args: { target: 'https://evil.example.com' } }] },
    { tools: [{ name: 'look_at_page', args: { target: '../../etc/passwd' } }] },
    { tools: [{ name: 'look_at_page', args: { target: 'index.html', phone: true } }] },
    { text: 'ok' }
  ]);
  const app = await startApp({ dataDir: tmp('rf-data-'), fetchImpl: g.fetchImpl });
  try {
    await app.api('settings', { groqKey: 'k' });
    await app.api('project/open', { path: proj });
    const ev = await app.chat({ text: 'look' });
    const results = ev.filter(e => e.type === 'tool_result' && e.name === 'look_at_page');
    assert.equal(results[0].ok, false); assert.match(results[0].label, /only opens local pages/);
    assert.equal(results[1].ok, false);
    assert.equal(results[2].ok, true);
    assert.match(g.calls.flatMap(c => c.body?.messages || []).filter(m => m.role === 'tool').at(-1).content, /Page title: Mine/);
  } finally { await app.close(); }
});

test('docs lookup: current version from npm, best-matching README sections', async () => {
  const readme = '# Phaser\nIntro text.\n## Install\nnpm i phaser\n## Arcade Physics\nUse this.physics.add.collider(a, b) for collisions.\n## Audio\nSounds stuff.\n' + 'filler '.repeat(3000);
  const fetchImpl = async url => {
    if (url.startsWith('https://registry.npmjs.org/phaser')) return new Response(JSON.stringify({ 'dist-tags': { latest: '4.2.1' }, description: 'game framework', readme, versions: { '4.2.1': {} }, time: { '4.2.1': '2026-09-01T00:00:00Z' } }), { status: 200 });
    if (url.includes('pypi.org')) return new Response('{}', { status: 404 });
    return new Response('', { status: 404 });
  };
  const r = await docs.lookup({ name: 'phaser', topic: 'arcade physics collider', fetchImpl });
  assert.equal(r.version, '4.2.1'); assert.match(r.docs, /physics\.add\.collider/); assert.ok(r.docs.length <= 9100);
  await assert.rejects(docs.lookup({ name: 'bad name!', fetchImpl }), /package name/);
  await assert.rejects(docs.lookup({ name: 'nothing-here', fetchImpl }), /Couldn't find/);
  // a placeholder npm package doesn't beat the real Python one
  const f2 = async url => url.includes('registry.npmjs.org') ? new Response(JSON.stringify({ 'dist-tags': { latest: '0.0.1' }, readme: 'x', versions: { '0.0.1': {} } }), { status: 200 }) : new Response(JSON.stringify({ info: { name: 'numpy', version: '2.3.0', summary: 'arrays', description: '# NumPy\n' + 'arrays '.repeat(200) }, releases: {} }), { status: 200 });
  const n = await docs.lookup({ name: 'numpy', fetchImpl: f2 });
  assert.equal(n.ecosystem, 'python'); assert.equal(n.version, '2.3.0');
});

test('voice typing: audio goes to Whisper with the Groq key, text comes back', async () => {
  const g = fakeGroq([]);
  const app = await startApp({ dataDir: tmp('rf-data-'), fetchImpl: g.fetchImpl });
  try {
    await assert.rejects(app.api('transcribe', { audio: Buffer.from('abc').toString('base64') }), /Groq key/);
    await app.api('settings', { groqKey: 'gsk_voice' });
    const r = await app.api('transcribe', { audio: 'data:audio/webm;base64,' + Buffer.from('fake-audio').toString('base64'), mime: 'audio/webm' });
    assert.equal(r.text, 'make me a snake game');
    const call = g.calls.find(c => c.url.endsWith('/audio/transcriptions'));
    assert.equal(call.form.get('model'), 'whisper-large-v3-turbo');
    assert.equal(await call.form.get('file').text(), 'fake-audio');
  } finally { await app.close(); }
});

test('personality: treats Darren as an adult, custom instructions, no provider name required', async () => {
  const g = fakeGroq([{ text: 'yo' }]);
  const app = await startApp({ dataDir: tmp('rf-data-'), fetchImpl: g.fetchImpl });
  try {
    await app.api('settings', { groqKey: 'k', customInstructions: 'Call me boss. Keep answers under 5 lines.' });
    await app.chat({ text: 'hey' });
    const p = sysPrompt(g);
    assert.match(p, /is an adult/); assert.match(p, /No lectures/); assert.match(p, /Swearing is fine/);
    assert.match(p, /Call me boss/);
    await assert.rejects(app.api('settings', { browserPath: 'C:\\Windows\\System32\\cmd.exe' }), /Edge, Chrome/);
    const st = await app.api('state');
    assert.equal(typeof st.caps.python, 'boolean'); assert.equal(typeof st.caps.browser, 'boolean'); assert.equal(typeof st.caps.git, 'boolean');
  } finally { await app.close(); }
});

test('stopping mid-command kills it', async () => {
  const proj = project({ 'a.txt': 'x' });
  const g = fakeGroq([{ tools: [{ name: 'run_command', args: { command: 'node -e "setTimeout(()=>{},60000)"' } }] }]);
  const app = await startApp({ dataDir: tmp('rf-data-'), fetchImpl: g.fetchImpl });
  try {
    await app.api('settings', { groqKey: 'k', autoRun: 'ask', savePoints: false });
    await app.api('project/open', { path: proj });
    const t0 = Date.now(); let convoId;
    const ev = await app.chatLive({ text: 'run forever' }, async e => {
      if (e.type === 'start') convoId = e.convo.id;
      if (e.type === 'approval') { await app.api('approval', { id: e.id, allow: true }); setTimeout(() => app.api('stop', { convoId }), 500); }
    });
    assert.ok(Date.now() - t0 < 15000);
    assert.ok(ev.some(e => e.type === 'error' && /Stopped/.test(e.message)));
  } finally { await app.close(); }
});

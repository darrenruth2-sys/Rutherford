'use strict';
// The chat brain: builds context, streams from Groq, runs tools in a loop.
const groq = require('./groq.cjs');
const { diffLines, hunks, stats } = require('./diff.cjs');
const web = require('./web.cjs');
const sandbox = require('./sandbox.cjs');
const runner = require('./runner.cjs');
const eyes = require('./eyes.cjs');
const docs = require('./docs.cjs');
const Brain = require('./projectbrain.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_STEPS = 16;
const MAX_STEPS_BUILD = 40;
const TOOL_RESULT_CAP = 14000;

const fn = (name, description, properties = {}, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });

const GENERAL_TOOLS = [
  fn('remember', 'Save one short, lasting fact about the user or their preferences to long-term memory (e.g. "Uses Windows 11", "Prefers short answers"). Only for things worth knowing in future chats. Never save passwords or keys.', { fact: { type: 'string' } }, ['fact']),
  fn('show_preview', 'Show a live preview panel next to the chat with a complete, self-contained HTML page (inline CSS/JS). Use for websites, landing pages, games, charts, mockups or any visual demo. The user can view it and download it.', { title: { type: 'string' }, html: { type: 'string', description: 'Full HTML document' } }, ['title', 'html'])
];
const WEB_TOOLS = [
  fn('web_search', 'Search the internet for current or specific information (news, prices, scores, docs, recent releases, anything after your training data, or facts you are unsure of). Returns findings with source URLs.', { query: { type: 'string', description: 'What to search for, like a search engine query' } }, ['query']),
  fn('read_webpage', 'Open a web page and read its text (docs, articles, a link the user gave you).', { url: { type: 'string' } }, ['url'])
];
const IMAGE_TOOL = fn('make_image', 'Create an image from a text description (art, logos, concept art, illustrations, game sprites, photos). Write a detailed visual prompt in English: subject, style, lighting, colors, composition.', { prompt: { type: 'string' }, width: { type: 'integer', description: 'Default 1024' }, height: { type: 'integer', description: 'Default 1024' } }, ['prompt']);
const CODE_TOOL = fn('run_code', 'Run JavaScript (Node.js) and see what it prints. Use it to do math exactly, check logic, test a function, or work with data instead of guessing. Print results with console.log. It has no file or internet access and a 10 second limit.', { code: { type: 'string' } }, ['code']);
const LIBRARY_TOOL = fn('search_library', "Search the user's personal Library (documents, books, docs and notes they added). Use it first for questions those documents could answer. Returns the best matching passages with titles and locations.", { query: { type: 'string', description: 'Keywords to look for' } }, ['query']);
const PYTHON_TOOL = fn('run_python', 'Run Python 3 and see what it prints. Great for homework math (sympy, fractions), statistics, data, and charts: save a chart with matplotlib plt.savefig("chart.png") and it appears in the chat. Runs in a scratch folder: no internet, can\'t delete or change the user\'s files, 30 second limit.', { code: { type: 'string' } }, ['code']);
const DOCS_TOOL = fn('lookup_docs', 'Get the CURRENT version and docs of a JavaScript (npm) or Python (pip) library, so you don\'t write outdated code. Use it before writing code with a library whose API may have changed, or when unsure how it works.', { name: { type: 'string', description: 'Package name, e.g. "phaser", "@supabase/supabase-js", "pygame"' }, topic: { type: 'string', description: 'What you need, e.g. "arcade physics collisions"' }, ecosystem: { type: 'string', enum: ['auto', 'npm', 'python'] } }, ['name']);
const EYES_TOOL = fn('look_at_page', 'Open a page in a real (hidden) browser, optionally click/press keys like a player would, then SEE a screenshot and get any JavaScript errors. Use it to check your own work: after building a preview, a game or a web page, look at it, then fix what\'s broken (blank screen, errors, overlapping or off-screen things, unreadable text).', {
  target: { type: 'string', description: '"preview" (the last preview you showed), a project file like "index.html", or a local address like "http://localhost:5173"' },
  check: { type: 'string', description: 'What to look for, e.g. "does the player move right and is the score visible?"' },
  phone: { type: 'boolean', description: 'Look at it phone-sized' },
  actions: { type: 'array', description: 'Optional steps before the screenshot', items: { type: 'object', properties: { click: { type: 'string', description: 'CSS selector' }, key: { type: 'string', description: 'e.g. ArrowRight, Space, Enter, a' }, hold_ms: { type: 'integer' }, type: { type: 'string' }, wait: { type: 'integer', description: 'ms' }, scroll: { type: 'integer' } } } }
}, ['target']);
const PLAN_TOOL = fn('update_plan', 'Write or update the build plan: a checklist of small, testable steps. Call it at the start of a big task, and again whenever a step starts (status "doing") or finishes ("done"). Always send the WHOLE list.', { goal: { type: 'string' }, steps: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, status: { type: 'string', enum: ['todo', 'doing', 'done', 'skipped'] }, note: { type: 'string' } }, required: ['text', 'status'] } } }, ['goal', 'steps']);
const COMMAND_TOOL = fn('run_command', 'Run a terminal command in the project folder and get its output (e.g. "npm test", "npm run build", "node server.js", "python main.py", "npm install phaser"). The user approves commands first. Use it to TEST your work and read the real errors, then fix them. Servers/watchers get stopped after the timeout, which is fine.', { command: { type: 'string' }, why: { type: 'string', description: 'One short line shown to the user' }, timeout_seconds: { type: 'integer', description: 'Default 90, max 600' } }, ['command']);
const LESSON_TOOL = fn('save_lesson', 'Save a lesson about THIS project for next time: a bug cause you found, a gotcha, a command that works. One sentence.', { lesson: { type: 'string' } }, ['lesson']);
const MAP_TOOL = fn('project_map', 'Get the full map of the project: every code file with its line count and functions/classes.', {});
const SAVEPOINT_TOOL = fn('save_point', 'Make a save point (snapshot of the whole project the user can go back to). Do it before risky changes and when a feature works.', { message: { type: 'string' } }, ['message']);
const PROJECT_TOOLS = [
  fn('list_files', 'List files in the open project (or a sub-folder).', { folder: { type: 'string', description: 'Optional sub-folder, e.g. "src"' } }),
  fn('read_file', 'Read a text file from the open project. Use line numbers for big files.', { path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } }, ['path']),
  fn('search_project', 'Find text across all files in the open project. Returns file, line number and the line.', { query: { type: 'string' } }, ['query']),
  fn('edit_file', 'Propose changes to an existing file by find-and-replace. Each "find" must be copied EXACTLY from the current file (read it first) and must appear only once. The user reviews and approves before anything is written.', {
    path: { type: 'string' }, summary: { type: 'string', description: 'One line: what this change does' },
    edits: { type: 'array', items: { type: 'object', properties: { find: { type: 'string' }, replace: { type: 'string' } }, required: ['find', 'replace'] } }
  }, ['path', 'edits', 'summary']),
  fn('write_file', 'Propose creating a new file, or completely replacing a small file, with the given content. The user reviews and approves first. Prefer edit_file for changes to existing files.', { path: { type: 'string' }, content: { type: 'string' }, summary: { type: 'string' } }, ['path', 'content', 'summary'])
];

function systemPrompt({ memory, project, userName = '', library = null, webOn = false, now = new Date(), custom = '', build = false, ctxInfo = {} }) {
  const who = userName || 'the user';
  return [
    `You are Rutherford, ${who}'s personal AI, built by Darren. You help with coding (apps, games, websites), homework and school, writing, and anything else.`,
    `Today is ${now.toDateString()}.` + (userName ? ` You're talking with ${userName}.` : ''),
    `Personality:
- This is ${who}'s private assistant and ${who} is an adult. Talk like a sharp, funny friend: casual and direct. Swearing is fine when it fits the vibe.
- No lectures, no moralizing, no "as an AI", no safety disclaimers, no "consult a professional" padding. Answer mature, edgy or blunt questions straight. Dark humor and roasting are fine.
- If there's ever something you really won't do, say so in one short sentence (no lecture) and help with whatever part you can.`,
    `How to answer:
- Lead with the answer, then the explanation. No filler, no "Great question!".
- Match length to the question: short questions get short answers.
- Use Markdown: headings only for long answers, bullet lists when they help, fenced code blocks with a language tag for code.
- Use LaTeX for math: $inline$ and $$display$$.
- Homework and school: give the correct answer and show the work step by step so it can be checked. Check math with run_python or run_code instead of doing it in your head. For essays/discussion posts, write in a natural voice. If a question or photo is unclear, say exactly what's unclear instead of guessing.
- If you're not sure about a fact, say so. Never invent sources, numbers or quotes.
- For anything visual (a website, a game, a mockup, a chart), call show_preview with one complete HTML file instead of pasting a huge code block. Then call look_at_page with target "preview" to check it actually works, and fix problems before you finish.`,
    project ? `A project folder is open: "${project}". You can list, read and search its files, propose edits, run commands (the user approves), make save points and save lessons.
How you code (work like a senior engineer):
- Look before you leap: read the relevant files before changing them. Never guess file contents. The project map below tells you where things are.
- Make focused edits with edit_file (exact find/replace). Use write_file for new files.
- TEST your work: run the tests, build, or the program with run_command and read the real output. If it fails, read the error, fix it, and run again until it works. For web pages and games, use look_at_page to see it.
- Check library docs with lookup_docs when an API may have changed (versions are listed below).
- When you find the cause of a tricky bug or a project gotcha, save_lesson so you don't repeat it.
- RUTHERFORD.md in the project root holds the user's notes and rules for this project. Follow it. If it doesn't exist and you're doing real work in the project, create it (short: what the app is, how to run/test it, key decisions).
` + (build ? '' : `- Your edits are PROPOSALS until the user clicks Apply (unless auto-apply is on). Running a command applies the pending edits first (the user sees this in the approval).
- Don't propose edits unless the user asked for a change; for questions, just answer.`) : `No project folder is open. If the user wants you to work on their code files, tell them to open a project with the folder button at the top. You can still build single-page apps and games with show_preview.`,
    build ? `BUILD MODE is on. Work like this until the job is done or you hit a real blocker:
1. If there's no plan for this task, make one with update_plan: 3–12 small steps, each one testable.
2. For each step: mark it "doing", build it, TEST it (run_command and/or look_at_page), fix until it works, mark it "done".
3. Your file changes are applied right away (each one has Undo, and save points are made automatically), so you can run and test them immediately.
4. Keep going step after step without waiting for the user. Only stop to ask when you truly need a decision from them.
5. At the end: a short summary of what works, how to run it, and anything left to do.` : '',
    ctxInfo.plan ? `Current build plan (resume from the first unfinished step if the user says continue):\n${ctxInfo.plan}` : '',
    ctxInfo.notes ? `RUTHERFORD.md (the user's project notes — follow them):\n${ctxInfo.notes}` : '',
    ctxInfo.deps ? `Project libraries and versions: ${ctxInfo.deps}` : '',
    ctxInfo.map ? `Project map (files: functions/classes):\n${ctxInfo.map}` : '',
    ctxInfo.lessons ? `Lessons learned in this project before (avoid repeating these mistakes):\n${ctxInfo.lessons}` : '',
    webOn ? `You can search the web (web_search) and read pages (read_webpage). Use them for anything current, anything you are unsure of, or when the user asks you to look something up. Cite sources as Markdown links.` : `Web search is unavailable (it needs a Groq key and must be on in Settings).`,
    `You can create images with make_image. After making one, say a sentence about it; the image is shown automatically.`,
    `You can run JavaScript with run_code${ctxInfo.python ? ' and Python with run_python (with numpy/sympy/matplotlib if installed)' : ''}. Use them for exact math, checking logic and crunching data. Don't guess a calculation you can run.`,
    library?.docs ? `The user's Library has ${library.docs} document(s) (${library.titles}). When a question could be answered from them, call search_library first and cite the document title.` : '',
    memory.trim() ? `What you know about the user (from memory — use it when relevant, don't recite it):\n${memory.trim()}` : '',
    `Use the remember tool when the user tells you a lasting fact or preference worth keeping, or asks you to remember something.`,
    custom.trim() ? `${who}'s custom instructions (follow these):\n${custom.trim()}` : ''
  ].filter(Boolean).join('\n\n');
}

// Turn stored conversation messages into model messages.
function historyToMessages(messages, { includeImagesFor = -1, images } = {}) {
  const out = []; let budget = 70000;
  for (let i = messages.length - 1; i >= 0 && out.length < 40; i--) {
    const m = messages[i];
    let text = String(m.content || '');
    if (m.role === 'user') {
      for (const a of m.attachments || []) {
        const body = i === messages.length - 1 ? a.text : String(a.text || '').slice(0, 3000) + (String(a.text || '').length > 3000 ? '\n…(trimmed, earlier attachment)' : '');
        text += `\n\n<attached_file name="${a.name}">\n${body}\n</attached_file>`;
      }
      const imgs = m.images || [];
      if (imgs.length && i === includeImagesFor) {
        out.unshift({ role: 'user', content: [{ type: 'text', text: text || 'Look at this image.' }, ...imgs.map(id => ({ type: 'image_url', image_url: { url: images.dataUrl(id) } }))] });
        budget -= text.length; continue;
      }
      if (imgs.length) text += `\n[${imgs.length} image(s) were attached here]`;
    } else if (m.role === 'assistant') {
      if (m.changes?.length) text += '\n\n[Proposed file changes: ' + m.changes.map(c => `${c.path} (${c.status})`).join(', ') + ']';
      if (m.preview) text += `\n\n[Showed preview: "${m.preview.title}"]`;
      for (const g of m.generated || []) text += `\n\n[Made image: "${g.prompt.slice(0, 120)}"]`;
      for (const c of m.commands || []) text += `\n\n[Ran \`${c.command}\`: ${c.denied ? 'user said no' : c.ok ? 'OK' : 'failed (exit ' + c.exitCode + ')'}]`;
    }
    if (!text.trim()) continue;
    budget -= text.length;
    if (budget < 0 && out.length) break;
    out.unshift({ role: m.role, content: text });
  }
  return out;
}

const short = (v, n = 80) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > n ? s.slice(0, n) + '…' : s; };

function changeView(ch, status = 'pending') {
  const rows = diffLines(ch.before, ch.after);
  return { id: ch.id, path: ch.path, isNew: ch.isNew, summary: ch.summary, status, ...stats(rows), diff: hunks(rows).slice(0, 1500) };
}

async function runTool(call, ctx) {
  const { workspace, store, emit, autoApprove } = ctx;
  let args;
  try { args = JSON.parse(call.function.arguments || '{}'); } catch { return { ok: false, text: 'Your tool arguments were not valid JSON. Try again.' }; }
  const name = call.function.name;
  const needProject = () => { if (!workspace) throw Error('No project folder is open. Ask the user to open one.'); };
  switch (name) {
    case 'remember': {
      const r = store.memory.add(args.fact);
      if (r.saved) emit({ type: 'memory', line: r.line });
      return { ok: true, text: r.saved ? 'Saved to memory.' : r.note, label: 'Remembered' };
    }
    case 'show_preview': {
      if (typeof args.html !== 'string' || args.html.length < 20) throw Error('html is required');
      if (args.html.length > 400000) throw Error('Preview too large (400 KB max)');
      const preview = { title: String(args.title || 'Preview').slice(0, 80), html: args.html };
      ctx.preview = preview; emit({ type: 'preview', ...preview });
      return { ok: true, text: 'Preview is now showing in the side panel. The user can download it. Do not repeat the HTML in your reply.', label: 'Preview: ' + preview.title };
    }
    case 'web_search': {
      if (!ctx.settings.webSearch) return { ok: false, text: 'Web search is turned off in Settings.', label: 'Web search is off' };
      const r = await web.webSearch({ key: ctx.providers.config('groq').key, query: args.query, fetchImpl: ctx.fetchImpl });
      ctx.sources.push(...r.sources.filter(s => !ctx.sources.some(x => x.url === s.url)));
      if (r.sources.length) emit({ type: 'sources', sources: r.sources });
      return { ok: true, text: r.text + (r.sources.length ? '\n\nSources:\n' + r.sources.map(s => `- ${s.title}: ${s.url}`).join('\n') : ''), label: `Searched the web: "${short(args.query, 50)}"` };
    }
    case 'read_webpage': {
      if (!ctx.settings.webSearch) return { ok: false, text: 'Web access is turned off in Settings.', label: 'Web access is off' };
      const r = await web.readPage({ url: args.url, fetchImpl: ctx.webFetch, lookup: ctx.lookup });
      const src = { title: r.title, url: r.url }; if (!ctx.sources.some(x => x.url === src.url)) { ctx.sources.push(src); emit({ type: 'sources', sources: [src] }); }
      return { ok: true, text: `${r.title}\n${r.url}\n\n${r.text}${r.truncated ? '\n…(page truncated)' : ''}`, label: 'Read ' + new URL(r.url).hostname.replace(/^www\./, '') };
    }
    case 'make_image': {
      const r = await web.makeImage({ prompt: args.prompt, width: args.width, height: args.height, token: ctx.settings.imageToken, fetchImpl: ctx.webFetch });
      const id = store.images.saveBuffer(r.buffer, r.ext);
      const img = { id, prompt: String(args.prompt).slice(0, 1500) };
      ctx.generated.push(img); emit({ type: 'image', ...img });
      return { ok: true, text: 'Image created and shown to the user.', label: 'Made an image' };
    }
    case 'run_code': {
      const r = await sandbox.runJs(String(args.code || ''));
      emit({ type: 'code', code: String(args.code || '').slice(0, 4000), output: r.output.slice(0, 4000), ok: r.ok });
      ctx.codeRuns.push({ code: String(args.code || '').slice(0, 4000), output: r.output.slice(0, 4000), ok: r.ok });
      return { ok: true, text: (r.ok ? 'Ran OK' : r.timedOut ? 'Timed out' : 'Error (exit ' + r.exitCode + ')') + ` in ${r.ms}ms. Output:\n` + r.output, label: r.ok ? 'Ran code' : 'Ran code (error)' };
    }
    case 'search_library': {
      if (!ctx.library) return { ok: false, text: 'Library unavailable.' };
      const hits = ctx.library.search(args.query, 6);
      if (hits.length) emit({ type: 'library', hits: hits.map(h => ({ title: h.title, where: h.where })) });
      return { ok: true, text: hits.length ? hits.map((h, i) => `[${i + 1}] ${h.title}${h.where ? ' (' + h.where + ')' : ''}\n${h.text}`).join('\n\n---\n\n') : 'Nothing in the Library matched. Try different keywords, or answer from general knowledge and say so.', label: `Searched Library: "${short(args.query, 40)}" (${hits.length} passage${hits.length === 1 ? '' : 's'})` };
    }
    case 'list_files': { needProject(); const r = workspace.listFiles(args.folder || ''); return { ok: true, text: r.files.join('\n') + (r.truncated ? '\n…(more files not shown)' : ''), label: 'Listed ' + r.count + ' files' + (args.folder ? ' in ' + args.folder : '') }; }
    case 'read_file': {
      needProject(); const r = workspace.readFile(args.path, { startLine: args.start_line, endLine: args.end_line });
      const numbered = r.content.split('\n').map((l, i) => String(r.startLine + i).padStart(4) + '│' + l).join('\n');
      return { ok: true, text: `${r.path} (lines ${r.startLine}-${r.endLine} of ${r.totalLines})\n${numbered}`, label: 'Read ' + r.path };
    }
    case 'search_project': { needProject(); const r = workspace.search(args.query); return { ok: true, text: r.matches.length ? r.matches.map(m => `${m.path}:${m.line}: ${m.text}`).join('\n') : 'No matches.', label: `Searched "${short(args.query, 40)}" — ${r.matches.length} hits` }; }
    case 'edit_file': case 'write_file': {
      needProject();
      const ch = workspace.propose({ path: args.path, edits: name === 'edit_file' ? args.edits : undefined, content: name === 'write_file' ? args.content : undefined, summary: args.summary });
      if (ch.replaces) { const old = ctx.changes.find(c => c.id === ch.replaces); if (old) old.status = 'merged'; emit({ type: 'change_status', id: ch.replaces, status: 'merged' }); }
      if (autoApprove) {
        savePointOnce(ctx);
        const r = workspace.approve(ch.id); const view = { ...changeView(ch, 'applied'), checkpoint: r.checkpoint };
        ctx.changes.push(view); emit({ type: 'change', change: view });
        return { ok: true, text: `Applied to ${ch.path} (auto-approve is on; the user can undo).`, label: (ch.isNew ? 'Created ' : 'Edited ') + ch.path };
      }
      const view = changeView(ch); ctx.changes.push(view); emit({ type: 'change', change: view });
      return { ok: true, text: `Change to ${ch.path} proposed (+${view.added} -${view.removed}). It is waiting for the user to click Apply — it is NOT written yet.`, label: 'Proposed change to ' + ch.path };
    }
    case 'run_python': {
      const r = await runner.runPython(String(args.code || ''));
      const pics = (r.files || []).map(f => { const id = store.images.saveBuffer(f.buffer, f.ext); const g = { id, prompt: 'Chart from Python: ' + f.name }; ctx.generated.push(g); emit({ type: 'image', ...g }); return f.name; });
      const run = { lang: 'python', code: String(args.code || '').slice(0, 4000), output: r.output.slice(0, 4000), ok: r.ok };
      ctx.codeRuns.push(run); emit({ type: 'code', ...run });
      return { ok: true, text: (r.ok ? 'Ran OK' : r.timedOut ? 'Timed out' : 'Error') + (r.ms != null ? ` in ${r.ms}ms` : '') + '. Output:\n' + r.output + (pics.length ? `\n(Showing ${pics.join(', ')} to the user.)` : ''), label: r.ok ? 'Ran Python' : 'Ran Python (error)' };
    }
    case 'lookup_docs': {
      const r = await docs.lookup({ name: args.name, topic: args.topic, ecosystem: args.ecosystem || 'auto', fetchImpl: ctx.webFetch });
      const src = { title: `${r.name} ${r.version} docs`, url: r.url }; if (!ctx.sources.some(x => x.url === src.url)) { ctx.sources.push(src); emit({ type: 'sources', sources: [src] }); }
      return { ok: true, text: `${r.name} — latest ${r.ecosystem === 'npm' ? 'npm' : 'PyPI'} version ${r.version}${r.updated ? ' (released ' + String(r.updated).slice(0, 10) + ')' : ''}\n${r.description}\nInstall: ${r.install}${r.homepage ? '\nDocs: ' + r.homepage : ''}${r.alsoOn ? `\n(Also a package with this name on ${r.alsoOn}; this is the main one.)` : ''}\n\n${r.docs}`, label: `Checked docs: ${r.name} ${r.version}` };
    }
    case 'look_at_page': return await lookAtPage(args, ctx);
    case 'update_plan': {
      const plan = ctx.plans.set({ goal: args.goal, steps: args.steps });
      ctx.plan = plan; emit({ type: 'plan', plan });
      const done = plan.steps.filter(x => x.status === 'done').length;
      return { ok: true, text: 'Plan saved.', label: `Plan: ${done}/${plan.steps.length} done` };
    }
    case 'run_command': {
      needProject();
      const command = String(args.command || '').trim().slice(0, 2000);
      if (!command) throw Error('command is required');
      const pending = ctx.changes.filter(c => c.status === 'pending');
      const autoOk = (ctx.settings.autoRun === 'safe' && runner.isSafe(command) && !pending.length) || ctx.allowAll?.();
      if (!autoOk) {
        const a = await ctx.ask({ kind: 'command', command, why: String(args.why || '').slice(0, 200), pending: pending.map(c => c.path) });
        if (!a.allow) {
          const rec = { command, denied: true, output: '', ok: false }; ctx.commands.push(rec); emit({ type: 'command', ...rec });
          return { ok: false, text: 'The user said NO to running this command' + (a.reason ? ': ' + a.reason : '') + '. Don\'t retry it; explain what they can run themselves, or continue another way.', label: 'You said no to: ' + short(command, 50) };
        }
        for (const c of pending) {
          try { savePointOnce(ctx); const r = workspace.approve(c.id); c.status = 'applied'; c.checkpoint = r.checkpoint; emit({ type: 'change_status', id: c.id, status: 'applied', checkpoint: r.checkpoint }); }
          catch (e) { c.status = 'expired'; emit({ type: 'change_status', id: c.id, status: 'expired' }); }
        }
      }
      const r = await runner.runCommand(command, { cwd: workspace.root, timeoutSec: args.timeout_seconds || 90, signal: ctx.signal });
      const rec = { command, ok: r.ok, exitCode: r.exitCode, timedOut: !!r.timedOut, ms: r.ms, output: r.output.slice(-6000) };
      ctx.commands.push(rec); emit({ type: 'command', ...rec });
      return { ok: r.ok || !!r.timedOut, text: `$ ${command}\n${r.ok ? 'Exit 0 (success)' : r.timedOut ? 'Stopped at the time limit' : 'FAILED with exit code ' + r.exitCode} after ${(r.ms / 1000).toFixed(1)}s\n\n${r.output}`, label: (r.ok ? 'Ran ' : r.timedOut ? 'Ran (stopped) ' : 'Failed: ') + short(command, 50) };
    }
    case 'save_lesson': {
      needProject();
      const r = ctx.brain.lessons.add(args.lesson);
      return { ok: true, text: r.saved ? 'Lesson saved for this project.' : 'Already known.', label: 'Saved a lesson' };
    }
    case 'project_map': { needProject(); const m = ctx.brain.map({ maxChars: 30000 }); return { ok: true, text: m.text || '(no code files found)', label: `Mapped ${m.files} files` }; }
    case 'save_point': {
      needProject();
      if (!ctx.savepoints) return { ok: false, text: 'Save points are off or Git isn\'t installed.', label: 'Save points unavailable' };
      const r = ctx.savepoints.save(String(args.message || 'save'));
      if (r.saved) emit({ type: 'savepoint', hash: r.hash, message: r.message });
      return { ok: true, text: r.saved ? `Save point ${r.hash} made.` : r.note, label: r.saved ? 'Save point: ' + short(args.message, 40) : 'Nothing new to save' };
    }
    default: return { ok: false, text: 'Unknown tool: ' + name };
  }
}


// One save point per answer, made right before the first file is written
function savePointOnce(ctx) {
  if (!ctx.savepoints || ctx.savedBefore) return;
  ctx.savedBefore = true;
  try { const r = ctx.savepoints.save('before: ' + ctx.request.slice(0, 120)); if (r.saved) ctx.emit({ type: 'savepoint', hash: r.hash, message: r.message }); }
  catch (e) { ctx.emit({ type: 'note', text: 'Save point skipped: ' + e.message }); }
}

async function lookAtPage(args, ctx) {
  const target = String(args.target || 'preview').trim();
  let url, tmpFile = null;
  if (/^preview$/i.test(target) || !target) {
    const p = ctx.preview || ctx.lastPreview;
    if (!p) throw Error('There is no preview in this chat yet. Make one with show_preview first.');
    tmpFile = path.join(os.tmpdir(), 'rf-preview-' + Date.now() + '.html'); fs.writeFileSync(tmpFile, p.html);
    url = require('node:url').pathToFileURL(tmpFile).href;
  } else if (/^https?:\/\//i.test(target)) {
    const u = new URL(target);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) throw Error('look_at_page only opens local pages (localhost). Use read_webpage for websites.');
    url = u.href;
  } else {
    if (!ctx.workspace) throw Error('Open a project to look at its files, or use target "preview".');
    url = require('node:url').pathToFileURL(ctx.workspace.resolve(target)).href;
  }
  let r;
  try { r = await eyes.look({ url, mobile: !!args.phone, actions: args.actions, browserPath: ctx.settings.browserPath || undefined }); }
  finally { if (tmpFile) setTimeout(() => { try { fs.unlinkSync(tmpFile); } catch {} }, 2000); }
  const id = ctx.store.images.saveBuffer(r.png, 'png');
  // Let a vision brain actually look at the screenshot
  let seen = '';
  try {
    const out = await ctx.providers.stream({ messages: [{ role: 'user', content: [
      { type: 'text', text: `You are checking a screenshot of a web page or game for a developer.${args.check ? ' They want to know: ' + args.check : ''}\nDescribe concisely what is actually visible: layout, text, colors, game objects. Then list anything that looks broken: blank/black areas, missing images, overlapping or cut-off elements, unreadable text, things off-screen, layout issues. Be specific and honest; if it looks fine, say so.` },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' + r.png.toString('base64') } }] }], maxTokens: 900, signal: ctx.signal, onText: () => {} }, { vision: true });
    seen = out.content.trim();
  } catch (e) { seen = '(Could not get a description of the screenshot: ' + e.message + ')'; }
  const shot = { id, target: target.slice(0, 120), errors: r.errors, notes: r.notes, seen: seen.slice(0, 3000) };
  ctx.shots.push(shot); ctx.emit({ type: 'shot', ...shot });
  const facts = [`Page title: ${r.title || '(none)'}`, r.info ? `Visible text: ${r.info.chars} characters, canvases: ${r.info.canvas}${r.info.overflowX ? ', page is WIDER than the screen (sideways scroll)' : ''}` : ''].filter(Boolean).join('\n');
  return { ok: true, text: `${facts}\n${r.notes.length ? 'Actions: ' + r.notes.join('; ') + '\n' : ''}JavaScript errors:${r.errors.length ? '\n- ' + r.errors.join('\n- ') : ' none'}\n${r.logs.length ? 'Console: ' + r.logs.slice(0, 10).join(' | ') + '\n' : ''}\nWhat the screenshot shows:\n${seen}`, label: r.errors.length ? `Looked at ${short(target, 30)}: ${r.errors.length} error${r.errors.length > 1 ? 's' : ''}` : `Looked at ${short(target, 30)}` };
}

// A second brain double-checks the code changes from this answer. Returns findings text or null.
async function review(ctx, brainId, signal) {
  const changed = ctx.changes.filter(c => c.status !== 'rejected' && c.status !== 'expired');
  if (!changed.length) return null;
  let diffText = '';
  for (const c of changed) {
    const rows = (c.diff || []).map(r => r.t === '…' ? '…' : (r.t === '+' ? '+' : r.t === '-' ? '-' : ' ') + r.text).join('\n');
    diffText += `\n### ${c.path}${c.isNew ? ' (new file)' : ''}: ${c.summary || ''}\n${rows}\n`;
    if (diffText.length > 30000) { diffText = diffText.slice(0, 30000) + '\n…(more changes not shown)'; break; }
  }
  const lastRun = ctx.commands.filter(c => !c.denied).slice(-2).map(c => `$ ${c.command} → ${c.ok ? 'OK' : 'FAILED'}\n${c.output.slice(-1500)}`).join('\n\n');
  const out = await ctx.providers.stream({ messages: [
    { role: 'system', content: 'You are a strict senior code reviewer. You only report REAL problems: bugs, crashes, broken logic, missing pieces the request needed, security holes, code that won\'t run. Not style or nitpicks. If everything is fine, reply with exactly: LGTM' },
    { role: 'user', content: `What the user asked for:\n${ctx.request.slice(0, 3000)}\n\nThe changes (diff, + added, - removed):\n${diffText}${lastRun ? '\n\nLatest command output:\n' + lastRun : ''}\n\nList each real problem as a short bullet with the file and what to fix. Or reply LGTM.` }
  ], maxTokens: 1500, signal, onText: () => {} }, { task: 'code', avoid: brainId });
  const text = out.content.trim();
  return { text, ok: /^\W*LGTM\b/i.test(text) || !text, by: out.providerName };
}

let pythonAvail; let browserAvail;
async function run({ store, workspace, library, providers, convo, emit, signal, fetchImpl, webFetch = fetch, lookup, think = false, build = false, ask, allowAll, savepoints = null, brain = null }) {
  const settings = store.settings.get();
  if (!providers.anyKey()) throw new groq.ProviderError('Add a free AI key in Settings first (Groq: console.groq.com/keys, or Gemini: aistudio.google.com/apikey).', { code: 'nokey' });
  const webOn = !!(settings.webSearch && providers.config('groq').key); // web search runs through Groq
  const lastIdx = convo.messages.length - 1;
  const hasImages = (convo.messages[lastIdx]?.images || []).length > 0;
  const request = String(convo.messages.filter(m => m.role === 'user').at(-1)?.content || '');
  const libStats = library?.stats();
  const libInfo = libStats?.docs ? { docs: libStats.docs, titles: library.list().slice(0, 12).map(d => d.title).join('; ') + (libStats.docs > 12 ? '; …' : '') } : null;
  if (pythonAvail === undefined) pythonAvail = !!runner.findPython();
  if (browserAvail === undefined) browserAvail = !!eyes.findBrowser(settings.browserPath);
  if (workspace && !brain) brain = Brain.create(workspace);

  // Plans live in the project (so a build can resume later) or, with no project, in this chat
  const plans = brain ? brain.plan : { get: () => convo.plan || null, set: p => (convo.plan = Brain.normalizePlan(p, convo.plan)) };
  const ctxInfo = { python: pythonAvail };
  const planNow = plans.get();
  if (planNow && (Brain.unfinished(planNow) || build)) ctxInfo.plan = Brain.planText(planNow);
  if (brain) {
    try { ctxInfo.notes = brain.notes.get(4000); } catch {}
    try { ctxInfo.deps = brain.deps().join(', ').slice(0, 1500); } catch {}
    try { ctxInfo.map = brain.map({ maxChars: 5000 }).text; } catch {}
    try { ctxInfo.lessons = brain.lessons.recent(20); } catch {}
  }

  const tools = [...GENERAL_TOOLS, IMAGE_TOOL, CODE_TOOL, DOCS_TOOL, ...(pythonAvail ? [PYTHON_TOOL] : []), ...(browserAvail ? [EYES_TOOL] : []), ...(webOn ? WEB_TOOLS : []), ...(libInfo ? [LIBRARY_TOOL] : []),
    ...((build || workspace) ? [PLAN_TOOL] : []),
    ...(workspace ? [...PROJECT_TOOLS, MAP_TOOL, COMMAND_TOOL, LESSON_TOOL, ...(savepoints ? [SAVEPOINT_TOOL] : [])] : [])];
  const messages = [{ role: 'system', content: systemPrompt({ memory: store.memory.get(), project: workspace?.name, userName: settings.userName, library: libInfo, webOn, custom: settings.customInstructions || '', build, ctxInfo }) }, ...historyToMessages(convo.messages, { includeImagesFor: hasImages ? lastIdx : -1, images: store.images })];

  const lastPreview = [...convo.messages].reverse().find(m => m.preview)?.preview || null;
  const ctx = { workspace, store, library, providers, emit, settings, fetchImpl, webFetch, lookup, signal, request, brain, plans, savepoints, lastPreview,
    ask: ask || (async () => ({ allow: false, reason: 'no one is there to approve' })), allowAll,
    autoApprove: !!settings.autoApprove || build, changes: [], preview: null, sources: [], generated: [], codeRuns: [], commands: [], shots: [], plan: null, review: null, savedBefore: false };
  let model = '', brainInfo = null;
  const task = workspace || build ? 'code' : 'chat';
  const maxSteps = build ? MAX_STEPS_BUILD : MAX_STEPS;
  // Some vision models reject tool definitions, so photo turns are answered directly.
  const steps = []; let text = ''; let usedTools = !hasImages; let toolRetries = 0; let reviewed = settings.reviewer === false;

  for (let step = 0; step < maxSteps; step++) {
    let r;
    try {
      r = await providers.stream({ messages, tools: usedTools ? tools : undefined, signal, maxTokens: think ? 12000 : 8192,
        onText: d => { text += d; emit({ type: 'text', delta: d }); }, onThinking: () => emit({ type: 'thinking' }) },
        { vision: hasImages, think, task: hasImages ? 'chat' : task, onSwitch: b => { if (brainInfo && brainInfo.id !== b.id) emit({ type: 'brain_switch', from: brainInfo.name, to: b.name }); brainInfo = b; emit({ type: 'brain', ...b }); } });
      model = r.model; brainInfo = { id: r.provider, name: r.providerName, model: r.model };
    } catch (e) {
      // Some providers reject malformed tool calls; nudge once, then fall back to plain text.
      if (e.code === 'tool_use_failed' && toolRetries < 2) {
        toolRetries++; if (toolRetries === 2) usedTools = false;
        messages.push({ role: 'user', content: 'Your last tool call was malformed. ' + (usedTools ? 'Call the tool again with valid JSON arguments that match the schema.' : 'Answer in plain text without tools.') });
        continue;
      }
      throw e;
    }
    if (!r.toolCalls.length) {
      if (r.finishReason === 'length') { const note = '\n\n_(Answer hit the length limit — say "continue" for the rest.)_'; text += note; emit({ type: 'text', delta: note }); break; }
      // Second opinion on code changes, once per answer
      if (!reviewed && ctx.changes.some(c => c.status !== 'rejected') && step < maxSteps - 2) {
        reviewed = true;
        emit({ type: 'tool', id: 'review', name: 'review', args: {} });
        let rv = null;
        try { rv = await review(ctx, brainInfo?.id, signal); } catch (e) { if (e.code === 'aborted') throw e; }
        if (rv) {
          ctx.review = { ok: rv.ok, text: rv.ok ? '' : rv.text.slice(0, 4000), by: rv.by };
          emit({ type: 'review', ...ctx.review });
          const rec = { name: 'review', label: rv.ok ? 'Second opinion: looks good' : 'Second opinion: found issues', ok: true };
          steps.push(rec); emit({ type: 'tool_result', id: 'review', ...rec });
          if (!rv.ok) {
            messages.push({ role: 'assistant', content: r.content || '(done)' });
            messages.push({ role: 'user', content: `A second reviewer (a different AI) checked your changes and reported:\n${rv.text.slice(0, 6000)}\n\nFix the real problems now${ctx.autoApprove ? ' (and re-test)' : ' (propose the edits)'}. If a point is wrong, say why in one line. Then give a short final summary. Don't repeat your earlier summary.` });
            text += '\n\n'; emit({ type: 'text', delta: '\n\n' });
            continue;
          }
        } else { emit({ type: 'tool_result', id: 'review', name: 'review', label: 'Second opinion skipped', ok: true }); }
      }
      break;
    }
    messages.push({ role: 'assistant', content: r.content || null, tool_calls: r.toolCalls });
    if (r.content) { text += '\n\n'; emit({ type: 'text', delta: '\n\n' }); }
    for (const call of r.toolCalls) {
      let args = {}; try { args = JSON.parse(call.function.arguments || '{}'); } catch {}
      const shownArgs = { ...args }; delete shownArgs.html; delete shownArgs.content; delete shownArgs.edits; delete shownArgs.code; delete shownArgs.steps; if (shownArgs.prompt) shownArgs.prompt = short(shownArgs.prompt, 60);
      emit({ type: 'tool', id: call.id, name: call.function.name, args: shownArgs });
      let result;
      try { result = await runTool(call, ctx); }
      catch (e) { if (e.code === 'aborted' || signal?.aborted) throw Object.assign(Error('Stopped'), { code: 'aborted' }); result = { ok: false, text: 'Error: ' + e.message, label: e.message }; }
      const rec = { name: call.function.name, label: result.label || call.function.name, ok: result.ok };
      steps.push(rec);
      emit({ type: 'tool_result', id: call.id, ...rec });
      messages.push({ role: 'tool', tool_call_id: call.id, content: result.text.length > TOOL_RESULT_CAP ? result.text.slice(0, TOOL_RESULT_CAP) + '\n…(truncated — read a smaller line range)' : result.text });
    }
    if (step === maxSteps - 1) { const note = '\n\n_(Paused after ' + maxSteps + ' steps. Say "keep going" to continue' + (build ? ' the build' : '') + '.)_'; text += note; emit({ type: 'text', delta: note }); }
  }
  // Save point after a build/auto-apply answer that changed files
  if (savepoints && ctx.changes.some(c => c.status === 'applied')) {
    try { const sp = savepoints.save('after: ' + request.slice(0, 120)); if (sp.saved) emit({ type: 'savepoint', hash: sp.hash, message: sp.message }); } catch {}
  }
  return { content: text.trim(), steps, changes: ctx.changes.map(({ diff, ...c }) => c), preview: ctx.preview, sources: ctx.sources.slice(0, 20), generated: ctx.generated, codeRuns: ctx.codeRuns.slice(0, 10), commands: ctx.commands.slice(0, 20), shots: ctx.shots.slice(0, 8), plan: ctx.plan, review: ctx.review, model, provider: brainInfo?.name || null, think, build };
}

module.exports = { run, systemPrompt, historyToMessages, GENERAL_TOOLS, PROJECT_TOOLS, WEB_TOOLS, changeView, _reset: () => { pythonAvail = undefined; browserAvail = undefined; } };

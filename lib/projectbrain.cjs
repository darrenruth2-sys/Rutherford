'use strict';
// What Rutherford knows about the open project, so it doesn't start from zero every chat:
//  - map():     every code file with its functions/classes (a "table of contents" for the code)
//  - deps():    libraries + versions from package.json / requirements.txt / etc.
//  - notes:     RUTHERFORD.md in the project root (your rules for this project; you or the AI edit it)
//  - lessons:   bugs fixed / gotchas learned, kept in .rutherford/lessons.md
//  - plan:      the Build mode checklist, kept in .rutherford/plan.json so a build can resume
const fs = require('node:fs');
const path = require('node:path');

const CODE_EXT = /\.(c?m?[jt]sx?|py|gd|cs|java|kt|go|rs|rb|php|lua|swift|c|cc|cpp|h|hpp|vue|svelte|html?|css|scss|dart|sql)$/i;

// Language-aware-enough symbol finder (regex; fast, no parsers to install)
const PATTERNS = [
  [/\.(c?m?[jt]sx?|vue|svelte)$/i, [
    /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)\s*\(/,
    /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
    /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function/,
    /^\s*(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
    /^\s{2,4}(?:static\s+)?(?:async\s+)?(?!if\b|for\b|while\b|switch\b|catch\b|return\b|function\b)([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/,
    /^\s*(?:app|router|server)\.(get|post|put|delete|patch|use)\(\s*['"`]([^'"`]+)/
  ]],
  [/\.py$/i, [/^\s*(?:async\s+)?def\s+(\w+)/, /^\s*class\s+(\w+)/]],
  [/\.gd$/i, [/^\s*(?:static\s+)?func\s+(\w+)/, /^\s*class_name\s+(\w+)/, /^\s*class\s+(\w+)/, /^\s*signal\s+(\w+)/]],
  [/\.(cs|java|kt|swift|dart)$/i, [/^\s*(?:public|private|protected|internal|static|final|abstract|sealed|partial|override|virtual|async|open|data|\s)*\s*(?:class|interface|struct|enum|record|object)\s+(\w+)/, /^\s*(?:public|private|protected|internal|static|override|virtual|async|suspend|\s)+[\w<>\[\],?\s]+\s+(\w+)\s*\([^;]*\)\s*(?:\{|=>|$)/, /^\s*(?:fun|func)\s+(\w+)/]],
  [/\.go$/i, [/^func\s+(?:\([^)]*\)\s*)?(\w+)/, /^type\s+(\w+)/]],
  [/\.rs$/i, [/^\s*(?:pub\s+)?fn\s+(\w+)/, /^\s*(?:pub\s+)?(?:struct|enum|trait|impl)\s+(\w+)/]],
  [/\.(rb)$/i, [/^\s*def\s+([\w.?!]+)/, /^\s*(?:class|module)\s+(\w+)/]],
  [/\.php$/i, [/^\s*(?:public|private|protected|static|\s)*function\s+(\w+)/, /^\s*class\s+(\w+)/]],
  [/\.lua$/i, [/^\s*(?:local\s+)?function\s+([\w.:]+)/]],
  [/\.(c|cc|cpp|h|hpp)$/i, [/^[A-Za-z_][\w\s\*&:<>,]*\s+\**([A-Za-z_]\w*)\s*\([^;]*\)\s*\{?\s*$/, /^\s*(?:class|struct)\s+(\w+)/]],
  [/\.html?$/i, [/<title>([^<]{1,60})<\/title>/i, /<script[^>]+src=["']([^"']+)/i, /\bid=["']([\w-]{2,40})["']/]],
  [/\.s?css$/i, [/^(:root|body|#[\w-]+|\.[\w-]+)\s*[,{]/]],
  [/\.sql$/i, [/^\s*create\s+(?:or\s+replace\s+)?(?:table|view|function|policy|index)\s+(?:if\s+not\s+exists\s+)?([\w."]+)/i]]
];
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'constructor', 'else', 'new', 'await', 'typeof']);

function symbolsOf(rel, text, max = 40) {
  const pats = PATTERNS.find(([re]) => re.test(rel))?.[1];
  if (!pats) return [];
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && out.length < max; i++) {
    const ln = lines[i]; if (ln.length > 400) continue;
    for (const re of pats) {
      const m = re.exec(ln); if (!m) continue;
      const name = m[2] ? m[1].toUpperCase() + ' ' + m[2] : m[1];
      if (!name || KEYWORDS.has(name) || out.some(o => o.name === name)) break;
      out.push({ name, line: i + 1 }); break;
    }
  }
  return out;
}

function create(workspace) {
  const root = workspace.root;
  const meta = path.join(root, '.rutherford');
  const cache = new Map(); // rel -> {mtime, size, lines, symbols}

  function map({ maxChars = 7000 } = {}) {
    const files = workspace.tree().filter(n => n.type === 'file' && CODE_EXT.test(n.path));
    const rows = [];
    for (const f of files.slice(0, 1500)) {
      const abs = path.join(root, f.path);
      let st; try { st = fs.statSync(abs); } catch { continue; }
      if (st.size > 400000) { rows.push({ path: f.path, lines: null, symbols: [], big: true }); continue; }
      let c = cache.get(f.path);
      if (!c || c.mtime !== st.mtimeMs || c.size !== st.size) {
        let text = ''; try { text = fs.readFileSync(abs, 'utf8'); } catch {}
        c = { mtime: st.mtimeMs, size: st.size, lines: text.split('\n').length - (text.endsWith('\n') ? 1 : 0), symbols: symbolsOf(f.path, text) };
        cache.set(f.path, c);
      }
      rows.push({ path: f.path, lines: c.lines, symbols: c.symbols });
    }
    // Text form, trimmed to fit: list every file, symbols for as many as fit
    let text = ''; let full = true;
    for (const r of rows) {
      const head = `${r.path}${r.lines ? ` (${r.lines} lines)` : ' (big file)'}`;
      const syms = r.symbols.map(s => s.name).join(', ');
      const line = syms ? `${head}: ${syms}\n` : head + '\n';
      if (text.length + line.length > maxChars) {
        if (text.length + head.length + 1 > maxChars) { text += `…and ${rows.length - rows.indexOf(r)} more files (use project_map or list_files)\n`; full = false; break; }
        text += head + '\n'; full = false; continue;
      }
      text += line;
    }
    return { files: rows.length, text: text.trim(), full, rows };
  }

  function readMaybe(rel, max) { try { const t = fs.readFileSync(path.join(root, rel), 'utf8'); return t.length > max ? t.slice(0, max) + '\n…(trimmed)' : t; } catch { return ''; } }

  function deps() {
    const out = [];
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      const all = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      // Prefer exact installed versions when node_modules exists
      for (const [name, want] of Object.entries(all).slice(0, 60)) {
        let v = want; try { v = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version; } catch {}
        out.push(`${name}@${v}`);
      }
      if (pkg.scripts) out.push('npm scripts: ' + Object.keys(pkg.scripts).slice(0, 15).join(', '));
    } catch {}
    const req = readMaybe('requirements.txt', 3000);
    if (req) out.push(...req.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).slice(0, 40).map(l => 'py: ' + l));
    if (fs.existsSync(path.join(root, 'project.godot'))) { const g = readMaybe('project.godot', 4000); const v = /config\/features=PackedStringArray\("([\d.]+)/.exec(g); out.push('Godot project' + (v ? ' ' + v[1] : '')); }
    if (fs.existsSync(path.join(root, 'pubspec.yaml'))) out.push('Flutter/Dart project');
    if (fs.existsSync(path.join(root, 'Cargo.toml'))) out.push('Rust (Cargo) project');
    if (fs.existsSync(path.join(root, 'go.mod'))) out.push('Go module');
    try { if (fs.readdirSync(root).some(f => /\.(csproj|sln)$/.test(f))) out.push('.NET project'); } catch {}
    return out;
  }

  const notesFile = path.join(root, 'RUTHERFORD.md');
  const notes = { exists: () => fs.existsSync(notesFile), get: (max = 6000) => readMaybe('RUTHERFORD.md', max) };

  const lessonsFile = path.join(meta, 'lessons.md');
  const lessons = {
    get() { try { return fs.readFileSync(lessonsFile, 'utf8'); } catch { return ''; } },
    add(text) {
      const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
      if (!clean) throw Error('Lesson is empty');
      const cur = this.get();
      if (cur.toLowerCase().includes(clean.toLowerCase())) return { saved: false };
      fs.mkdirSync(meta, { recursive: true });
      // keep the newest 60 lessons
      const lines = (cur.trim() ? cur.trim().split('\n') : []).concat(`- ${new Date().toISOString().slice(0, 10)}: ${clean}`).slice(-60);
      fs.writeFileSync(lessonsFile, lines.join('\n') + '\n');
      return { saved: true, line: clean };
    },
    recent(n = 25) { return this.get().trim().split('\n').filter(Boolean).slice(-n).join('\n'); }
  };

  const planFile = path.join(meta, 'plan.json');
  const plan = {
    get() { try { return JSON.parse(fs.readFileSync(planFile, 'utf8')); } catch { return null; } },
    set(p) {
      const out = normalizePlan(p, this.get());
      fs.mkdirSync(meta, { recursive: true }); fs.writeFileSync(planFile, JSON.stringify(out, null, 2));
      return out;
    },
    clear() { try { fs.unlinkSync(planFile); } catch {} return null; },
    unfinished() { return unfinished(this.get()); },
    text() { return planText(this.get()); }
  };
  return { map, deps, notes, lessons, plan, symbolsOf };
}

function normalizePlan(p, prev) {
  const steps = (Array.isArray(p?.steps) ? p.steps : []).slice(0, 40).map((s, i) => ({ id: i + 1, text: String(typeof s === 'string' ? s : s?.text || s?.step || '').slice(0, 300), status: ['todo', 'doing', 'done', 'skipped'].includes(s?.status) ? s.status : 'todo', ...(s?.note ? { note: String(s.note).slice(0, 300) } : {}) })).filter(s => s.text);
  if (!steps.length) throw Error('A plan needs at least one step');
  const goal = String(p.goal || prev?.goal || '').slice(0, 500);
  return { goal, steps, updated: new Date().toISOString(), created: prev?.goal === goal && prev?.created ? prev.created : new Date().toISOString() };
}
const unfinished = p => p ? p.steps.filter(s => s.status === 'todo' || s.status === 'doing').length : 0;
function planText(p) {
  if (!p) return '';
  const mark = { todo: '[ ]', doing: '[~]', done: '[x]', skipped: '[-]' };
  return `Goal: ${p.goal}\n` + p.steps.map(s => `${mark[s.status]} ${s.id}. ${s.text}${s.note ? ' (' + s.note + ')' : ''}`).join('\n');
}

module.exports = { create, symbolsOf, normalizePlan, planText, unfinished };

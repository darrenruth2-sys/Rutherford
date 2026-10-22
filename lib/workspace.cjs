'use strict';
// Project folder access: safe paths, read/search, and approval-gated changes with undo.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.rutherford', '.venv', 'venv', '__pycache__', 'coverage', '.cache']);
const MAX_FILE = 2 * 1024 * 1024;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

function isText(buf) {
  if (buf.includes(0)) return false;
  return !buf.toString('utf8').includes('�');
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  try { fs.writeFileSync(tmp, content); fs.renameSync(tmp, file); }
  finally { try { fs.unlinkSync(tmp); } catch {} }
}

function open(rootDir) {
  const root = fs.realpathSync(path.resolve(rootDir));
  if (!fs.statSync(root).isDirectory()) throw Error('Project must be a folder');
  const meta = path.join(root, '.rutherford');
  const pending = new Map(); // id -> proposed change (in memory until approved)

  // Resolve a project-relative path. mustExist=false allows new files.
  function resolve(rel, mustExist = true) {
    if (typeof rel !== 'string' || !rel.trim() || rel.includes('\0')) throw Error('Invalid path');
    const parts = rel.trim().replaceAll('\\', '/').replace(/^\.\//, '').split('/').filter(p => p && p !== '.');
    if (!parts.length || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) throw Error('Use a path inside the project, like src/app.js');
    if (parts.some(p => p === '..' || SKIP.has(p))) throw Error('That path is off-limits: ' + rel);
    const target = path.resolve(root, ...parts);
    if (!target.startsWith(root + path.sep)) throw Error('Path leaves the project');
    if (fs.existsSync(target)) {
      const real = fs.realpathSync(target);
      if (!real.startsWith(root + path.sep)) throw Error('Link points outside the project');
      return real;
    }
    if (mustExist) throw Error('File not found: ' + parts.join('/'));
    // new file: parent dirs that exist must also stay inside
    let dir = path.dirname(target);
    while (!fs.existsSync(dir)) dir = path.dirname(dir);
    const realDir = fs.realpathSync(dir);
    if (realDir !== root && !realDir.startsWith(root + path.sep)) throw Error('Path leaves the project');
    return target;
  }
  const relOf = abs => path.relative(root, abs).replaceAll('\\', '/');

  function walk(cb, dir = root, depth = 0, budget = { n: 8000 }) {
    if (depth > 10 || budget.n <= 0) return;
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (budget.n-- <= 0) return;
      if (SKIP.has(e.name) || e.isSymbolicLink() || (e.name.startsWith('.') && e.name !== '.env.example')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { cb(abs, 'dir', depth); walk(cb, abs, depth + 1, budget); }
      else if (e.isFile()) cb(abs, 'file', depth);
    }
  }

  function listFiles(sub = '') {
    const base = sub ? resolve(sub) : root;
    if (!fs.statSync(base).isDirectory()) throw Error('Not a folder: ' + sub);
    const out = [];
    walk((abs, type) => { if (out.length < 600) out.push(relOf(abs) + (type === 'dir' ? '/' : '')); }, base);
    return { root: path.basename(root), count: out.length, truncated: out.length >= 600, files: out };
  }

  function tree() {
    const nodes = [];
    walk((abs, type, depth) => { if (nodes.length < 2000) nodes.push({ path: relOf(abs), type, depth }); });
    return nodes;
  }

  function readFile(rel, { startLine, endLine } = {}) {
    const abs = resolve(rel);
    const st = fs.statSync(abs);
    if (!st.isFile()) throw Error('Not a file: ' + rel);
    if (st.size > MAX_FILE) throw Error('File too big to read (over 2 MB)');
    const buf = fs.readFileSync(abs);
    if (!isText(buf)) throw Error('Not a text file: ' + rel);
    let text = buf.toString('utf8');
    const lines = text.split('\n');
    const s = Math.max(1, Number(startLine) || 1), e = Math.min(lines.length, Number(endLine) || lines.length);
    text = lines.slice(s - 1, e).join('\n');
    return { path: relOf(abs), totalLines: lines.length, startLine: s, endLine: e, content: text };
  }

  function search(query, { maxResults = 60 } = {}) {
    if (typeof query !== 'string' || !query.trim()) throw Error('Search needs some text');
    const q = query.toLowerCase();
    const hits = []; let filesScanned = 0;
    walk((abs, type) => {
      if (type !== 'file' || hits.length >= maxResults) return;
      let st; try { st = fs.statSync(abs); } catch { return; }
      if (st.size > 600000) return;
      const buf = fs.readFileSync(abs); if (!isText(buf)) return;
      filesScanned++;
      const rel = relOf(abs);
      if (rel.toLowerCase().includes(q)) hits.push({ path: rel, line: 0, text: '(file name match)' });
      buf.toString('utf8').split('\n').forEach((ln, i) => {
        if (hits.length < maxResults && ln.toLowerCase().includes(q)) hits.push({ path: rel, line: i + 1, text: ln.trim().slice(0, 200) });
      });
    });
    return { query, filesScanned, matches: hits };
  }

  // ---- Proposed changes (nothing touches disk until approve) ----
  function currentText(abs) {
    if (!fs.existsSync(abs)) return null;
    const buf = fs.readFileSync(abs);
    if (!isText(buf)) throw Error('Can only change text files');
    return buf.toString('utf8');
  }

  function propose({ path: rel, content, edits, summary }) {
    const abs = resolve(rel, false);
    const before = currentText(abs);
    // A change to this file is already waiting for approval: build on top of it and replace it
    const relPath = relOf(abs);
    const prev = [...pending.values()].reverse().find(c => c.path === relPath && c.beforeHash === (before === null ? null : sha(before)));
    const base = prev ? prev.after : before;
    let after;
    if (typeof content === 'string') after = content;
    else if (Array.isArray(edits) && edits.length) {
      if (base === null) throw Error('File does not exist yet; send full content instead of edits');
      after = base;
      for (const ed of edits) {
        if (typeof ed?.find !== 'string' || !ed.find) throw Error('Each edit needs a "find" string');
        const count = after.split(ed.find).length - 1;
        if (count === 0) throw Error('Could not find this text in ' + rel + ': ' + JSON.stringify(ed.find.slice(0, 120)) + '. Read the file again and copy the text exactly.');
        if (count > 1) throw Error('That text appears ' + count + ' times in ' + rel + '. Include more surrounding lines so it is unique.');
        after = after.replace(ed.find, () => String(ed.replace ?? ''));
      }
    } else throw Error('Provide either full content or a list of edits');
    if (after.length > MAX_FILE) throw Error('Result would be over 2 MB');
    if (before === after) throw Error('No change: the new text is the same as the old');
    const id = crypto.randomUUID();
    if (prev && after === prev.after) throw Error('No change: that is already in the pending change');
    const change = { id, path: relPath, isNew: before === null, before: before ?? '', after, beforeHash: before === null ? null : sha(before), summary: String(summary || '').slice(0, 300) + (prev ? ' (includes the earlier pending change)' : ''), created: Date.now(), replaces: prev?.id };
    if (prev) pending.delete(prev.id);
    pending.set(id, change);
    if (pending.size > 50) pending.delete(pending.keys().next().value);
    return change;
  }

  function getPending(id) { return pending.get(id) || null; }
  function reject(id) { return { rejected: pending.delete(id) }; }

  function approve(id) {
    const ch = pending.get(id);
    if (!ch) throw Error('That change expired or was already handled');
    const abs = resolve(ch.path, false);
    const now = currentText(abs);
    if ((now === null ? null : sha(now)) !== ch.beforeHash) throw Error(ch.path + ' changed since this was proposed. Ask Rutherford to redo it.');
    const cp = { id: new Date().toISOString().replace(/[:.]/g, '-') + '-' + id.slice(0, 6), path: ch.path, isNew: ch.isNew, afterHash: sha(ch.after), summary: ch.summary, time: new Date().toISOString() };
    const dir = path.join(meta, 'checkpoints', cp.id);
    fs.mkdirSync(dir, { recursive: true });
    if (!ch.isNew) fs.writeFileSync(path.join(dir, 'before.txt'), ch.before);
    fs.writeFileSync(path.join(dir, 'checkpoint.json'), JSON.stringify(cp, null, 2));
    atomicWrite(abs, ch.after);
    pending.delete(id);
    return { applied: true, checkpoint: cp.id, path: ch.path };
  }

  function checkpoints() {
    const dir = path.join(meta, 'checkpoints');
    let ids = []; try { ids = fs.readdirSync(dir); } catch {}
    return ids.sort().reverse().slice(0, 50).map(id => { try { return JSON.parse(fs.readFileSync(path.join(dir, id, 'checkpoint.json'), 'utf8')); } catch { return null; } }).filter(c => c && !c.undone);
  }

  function undo(cpId) {
    if (typeof cpId !== 'string' || !/^[\w-]+$/.test(cpId)) throw Error('Invalid checkpoint');
    const dir = path.join(meta, 'checkpoints', cpId);
    const cp = JSON.parse(fs.readFileSync(path.join(dir, 'checkpoint.json'), 'utf8'));
    if (cp.undone) throw Error('Already undone');
    const abs = resolve(cp.path, false);
    const now = currentText(abs);
    if (now === null || sha(now) !== cp.afterHash) throw Error(cp.path + ' was edited after this change, so undo would wipe those edits. Undo refused. The original is saved at .rutherford/checkpoints/' + cpId + '/before.txt');
    if (cp.isNew) fs.unlinkSync(abs); else atomicWrite(abs, fs.readFileSync(path.join(dir, 'before.txt'), 'utf8'));
    cp.undone = new Date().toISOString();
    fs.writeFileSync(path.join(dir, 'checkpoint.json'), JSON.stringify(cp, null, 2));
    return { undone: true, path: cp.path };
  }

  return { root, name: path.basename(root), resolve, listFiles, tree, readFile, search, propose, getPending, approve, reject, checkpoints, undo };
}

module.exports = { open };

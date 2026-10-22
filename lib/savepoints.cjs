'use strict';
// Save points: snapshots of your project you can always go back to, using Git under the hood.
// - Uses the project's own Git repo if it has one; otherwise makes a local one (never pushed anywhere).
// - Skips node_modules, build folders and secret .env files (via .git/info/exclude, which isn't part of your project).
// - Restoring first saves where you are now, so a restore can itself be undone.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EXCLUDE = ['node_modules/', 'dist/', 'build/', '.next/', '.cache/', 'coverage/', '__pycache__/', '.venv/', 'venv/', '.rutherford/', '.env', '.env.*', '!.env.example', '*.log', '.DS_Store', 'Thumbs.db'];
let gitOk;
function hasGit() {
  if (gitOk !== undefined) return gitOk;
  try { gitOk = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 8000 }).status === 0; } catch { gitOk = false; }
  return gitOk;
}

function create(root) {
  const git = (args, opts = {}) => {
    const r = spawnSync('git', ['-c', 'user.name=Rutherford', '-c', 'user.email=rutherford@localhost', '-c', 'core.autocrlf=false', '-c', 'core.quotepath=off', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 32 * 1024 * 1024, ...opts });
    if (r.error) throw Error('Git failed: ' + r.error.message);
    return r;
  };
  const must = (args) => { const r = git(args); if (r.status !== 0) throw Error((r.stderr || r.stdout || 'git error').trim().split('\n').slice(-3).join(' ')); return r.stdout; };

  function isRepoRoot() {
    const r = git(['rev-parse', '--show-toplevel']);
    if (r.status !== 0) return false;
    try { return fs.realpathSync(r.stdout.trim()) === fs.realpathSync(root); } catch { return false; }
  }
  function ensure() {
    if (!hasGit()) throw Error('Git is not installed. Get it free from https://git-scm.com/download/win, then restart Rutherford.');
    if (!isRepoRoot()) {
      if (git(['rev-parse', '--is-inside-work-tree']).status === 0) throw Error('This folder is inside another Git project. Open that project\'s top folder to use save points.');
      must(['init', '-q']);
    }
    const ex = path.join(root, '.git', 'info', 'exclude');
    try {
      const cur = fs.existsSync(ex) ? fs.readFileSync(ex, 'utf8') : '';
      if (!cur.includes('# rutherford')) { fs.mkdirSync(path.dirname(ex), { recursive: true }); fs.appendFileSync(ex, '\n# rutherford: keep these out of save points\n' + EXCLUDE.join('\n') + '\n'); }
    } catch {}
  }
  const hasCommits = () => git(['rev-parse', '--verify', '-q', 'HEAD']).status === 0;
  function dirty() { return must(['status', '--porcelain', '--untracked-files=all']).trim().length > 0; }

  // Make a save point if anything changed since the last one. Returns {saved, hash, message}.
  function save(message) {
    ensure();
    const msg = ('Save point: ' + String(message || 'save').replace(/\s+/g, ' ').trim()).slice(0, 200);
    if (hasCommits() && !dirty()) return { saved: false, note: 'Nothing changed since the last save point' };
    must(['add', '-A', '--', '.']);
    const r = git(['commit', '-q', '--allow-empty-message', '--no-verify', '-m', msg]);
    if (r.status !== 0) { if (/nothing to commit/.test(r.stdout + r.stderr)) return { saved: false, note: 'Nothing to save' }; throw Error((r.stderr || r.stdout).trim().split('\n').pop()); }
    return { saved: true, hash: must(['rev-parse', '--short', 'HEAD']).trim(), message: msg };
  }

  function list(n = 30) {
    if (!hasGit() || !isRepoRoot() || !hasCommits()) return [];
    const out = must(['log', '-n', String(n), '--date=iso-strict', '--pretty=format:%h%x1f%H%x1f%ad%x1f%s', '--shortstat']);
    const items = []; let cur = null;
    for (const line of out.split('\n')) {
      if (line.includes('\x1f')) { const [short, hash, date, subject] = line.split('\x1f'); cur = { short, hash, date, message: subject, files: 0 }; items.push(cur); }
      else if (cur && /files? changed/.test(line)) cur.files = Number(/(\d+) files? changed/.exec(line)?.[1] || 0);
    }
    return items;
  }

  // Put every file back the way it was at that save point (saves the current state first).
  function restore(hash) {
    if (typeof hash !== 'string' || !/^[0-9a-f]{4,40}$/.test(hash)) throw Error('Invalid save point');
    ensure();
    if (git(['cat-file', '-e', hash + '^{commit}']).status !== 0) throw Error('Save point not found');
    const before = save('before going back to ' + hash);
    must(['restore', '--source=' + hash, '--staged', '--worktree', '--', '.']);
    const after = save('went back to ' + hash);
    return { restored: hash, safety: before.hash || null, now: after.hash || null };
  }

  function diffSince(hash) { ensure(); return must(['diff', '--stat', hash]).trim(); }

  return { ensure, save, list, restore, dirty: () => { try { return isRepoRoot() && dirty(); } catch { return false; } }, isRepo: () => hasGit() && isRepoRoot(), diffSince };
}

module.exports = { create, hasGit, _reset: () => { gitOk = undefined; } };

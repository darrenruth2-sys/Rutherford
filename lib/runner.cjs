'use strict';
// Runs things on this computer for the AI:
//  - runCommand: a terminal command inside the open project (the user approves it first)
//  - runPython:  a Python snippet in a throwaway folder, with guard rails (no deleting files,
//                no starting programs, no internet, can't write outside its folder)
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const IS_WIN = process.platform === 'win32';

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (IS_WIN) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
    else process.kill(-child.pid, 'SIGKILL');
  } catch { try { child.kill('SIGKILL'); } catch {} }
}

// Keep the start and (mostly) the end of long output: errors are usually at the end.
function clip(text, max = 24000) {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.2);
  return text.slice(0, head) + `\n\n…(${text.length - max} characters cut)…\n\n` + text.slice(text.length - (max - head));
}

// Commands that only test/build/inspect. In "auto-run safe commands" mode these run without asking.
const SAFE = [
  /^npm (test|t|run (test|build|lint|check|typecheck|format:check)[\w:-]*)$/,
  /^(npx )?(tsc|eslint|prettier --check|vitest run|jest|mocha)( [\w./@=:-]+)*$/,
  /^node --test( [\w./-]+)*$/, /^node --check [\w./-]+$/,
  /^(python3?|py) -m (pytest|unittest|py_compile)( [\w./:-]+)*$/, /^pytest( [\w./:-]+)*$/,
  /^git (status|diff|log)( [\w./=-]+)*$/,
  /^(npm|node|python3?|py|git|pip3?) (--version|-v|-V)$/,
  /^(dotnet (build|test)|cargo (build|test|check)|go (build|test|vet) ?[\w./-]*)$/
];
function isSafe(cmd) {
  const c = String(cmd || '').trim().replace(/\s+/g, ' ');
  if (/[;&|<>`$()\n\r]/.test(c)) return false; // no chaining, redirects or substitutions
  return SAFE.some(re => re.test(c));
}

function runCommand(command, { cwd, timeoutSec = 90, signal } = {}) {
  return new Promise(resolve => {
    const cmd = String(command || '').trim();
    if (!cmd) return resolve({ ok: false, output: 'No command given', exitCode: null, ms: 0 });
    const started = Date.now();
    const t = Math.min(Math.max(Number(timeoutSec) || 90, 3), 600);
    const child = IS_WIN
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', '"' + cmd + '"'], { cwd, windowsHide: true, windowsVerbatimArguments: true, env: { ...process.env, FORCE_COLOR: '0', CI: '1' } })
      : spawn('/bin/sh', ['-c', cmd], { cwd, detached: true, env: { ...process.env, FORCE_COLOR: '0', CI: '1' } });
    let out = ''; let timedOut = false;
    const add = d => { out += d.toString(); if (out.length > 400000) out = out.slice(-200000); };
    child.stdout.on('data', add); child.stderr.on('data', add);
    child.stdin.end();
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, t * 1000);
    const onAbort = () => { timedOut = true; killTree(child); };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, output: 'Could not start: ' + e.message, exitCode: null, ms: Date.now() - started }); });
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      // eslint-disable-next-line no-control-regex
      let output = clip(out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')).trim();
      if (timedOut) output += `\n\n(Stopped after ${t}s. If this is a server that keeps running, that's expected: it started OK if there are no errors above.)`;
      resolve({ ok: !timedOut && code === 0, timedOut, exitCode: code, ms: Date.now() - started, output: output || '(no output)' });
    });
  });
}

// ---------- Python ----------
let pythonCmd; // cached: ['python3'] / ['py','-3'] / null
function findPython() {
  if (pythonCmd !== undefined) return pythonCmd;
  const tries = IS_WIN ? [['py', '-3'], ['python'], ['python3']] : [['python3'], ['python']];
  for (const t of tries) {
    try {
      const r = spawnSync(t[0], [...t.slice(1), '-c', 'import sys;print(sys.version_info[0])'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
      // The Windows Store "python" stub prints nothing useful
      if (r.status === 0 && r.stdout.trim() === '3') return (pythonCmd = t);
    } catch {}
  }
  return (pythonCmd = null);
}

// Guard rails, installed before the user's code runs. Not a hard security sandbox:
// it stops accidents (deleting/overwriting files, launching programs, going online).
const PRELUDE = String.raw`
import sys, os
_RF_DIR = os.path.realpath(os.getcwd())
def _rf_inside(p):
    try:
        if isinstance(p, int): return True
        return os.path.realpath(os.fsdecode(p)).startswith(_RF_DIR)
    except Exception: return False
_RF_BLOCK = {'subprocess.Popen','os.system','os.exec','os.spawn','os.posix_spawn','os.fork','os.forkpty','os.kill','os.startfile','socket.connect','socket.bind','socket.getaddrinfo','urllib.Request','shutil.rmtree','winreg.SetValue','winreg.CreateKey','winreg.DeleteKey'}
_RF_INSIDE_ONLY = {'os.remove','os.unlink','os.rmdir','os.rename','os.replace','os.mkdir','os.chmod','os.truncate','shutil.move','shutil.copyfile'}
def _rf_hook(event, args):
    if event in _RF_BLOCK:
        raise PermissionError('Rutherford blocked ' + event + ' (Python runs in a safe box: no programs, internet or deleting).')
    if event in _RF_INSIDE_ONLY and args and not _rf_inside(args[0]):
        raise PermissionError('Rutherford blocked ' + event + ' outside the scratch folder.')
    if event == 'open' and len(args) > 1 and args[0] is not None:
        mode = args[1] if isinstance(args[1], str) else ''
        flags = args[2] if len(args) > 2 and isinstance(args[2], int) else 0
        writing = any(c in mode for c in 'wax+') or (flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND))
        if writing and not _rf_inside(args[0]):
            raise PermissionError('Rutherford blocked writing outside the scratch folder: ' + str(args[0]))
sys.addaudithook(_rf_hook)
del _rf_hook
`;

function runPython(code, { timeoutSec = 30, maxOut = 20000 } = {}) {
  return new Promise(resolve => {
    const py = findPython();
    if (!py) return resolve({ ok: false, missing: true, output: 'Python is not installed on this computer. Install it from https://www.python.org/downloads/ (tick "Add python.exe to PATH"), then restart Rutherford.', files: [] });
    if (typeof code !== 'string' || !code.trim()) return resolve({ ok: false, output: 'No code given', files: [] });
    if (code.length > 100000) return resolve({ ok: false, output: 'Code too long (100 KB max)', files: [] });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-py-'));
    fs.writeFileSync(path.join(dir, 'main.py'), PRELUDE + '\n' + 'exec(compile(open("your_code.py", encoding="utf-8").read(), "your_code.py", "exec"))\n');
    fs.writeFileSync(path.join(dir, 'your_code.py'), code);
    const started = Date.now();
    const env = { PATH: process.env.PATH, MPLBACKEND: 'Agg', TEMP: dir, TMP: dir, TMPDIR: dir, MPLCONFIGDIR: dir };
    for (const k of ['SYSTEMROOT', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'LANG']) if (process.env[k]) env[k] = process.env[k]; // so packages you pip-installed are found
    // -E ignore PYTHON* env vars, -B don't write .pyc files, UTF-8 output
    const child = spawn(py[0], [...py.slice(1), '-E', '-B', '-X', 'utf8', 'main.py'], { cwd: dir, windowsHide: true, detached: !IS_WIN, env });
    let out = ''; let killed = false;
    const add = d => { if (out.length < maxOut * 2) out += d.toString(); };
    child.stdout.on('data', add); child.stderr.on('data', add);
    const timer = setTimeout(() => { killed = true; killTree(child); }, timeoutSec * 1000);
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, output: 'Could not start Python: ' + e.message, files: [] }); });
    child.on('close', exitCode => {
      clearTimeout(timer);
      // Pictures the code saved (e.g. plt.savefig("chart.png")) come back to the chat
      const files = [];
      try {
        for (const f of fs.readdirSync(dir)) {
          if (/\.(png|jpe?g|gif|svg|webp)$/i.test(f) && files.length < 4) {
            const buf = fs.readFileSync(path.join(dir, f)); if (buf.length < 8 * 1024 * 1024) files.push({ name: f, ext: path.extname(f).slice(1).toLowerCase().replace('jpeg', 'jpg'), buffer: buf });
          }
        }
      } catch {}
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      let output = out.replace(/^\s*File ".*main\.py".*\n(?:(?!\s*File ).*\n)*?(?=\s*File |\S)/gm, '').replace(/^\s*[~^]+\s*$\n?/gm, '').replace(/File "your_code\.py", /g, '');
      if (output.length > maxOut) output = output.slice(0, maxOut) + '\n…(output cut off)';
      if (killed) output += `\n(Stopped: took longer than ${timeoutSec}s)`;
      resolve({ ok: !killed && exitCode === 0, timedOut: killed, exitCode, ms: Date.now() - started, output: output.trim() || (files.length ? '(saved ' + files.map(f => f.name).join(', ') + ')' : '(no output; use print() to show results)'), files });
    });
  });
}

module.exports = { runCommand, runPython, findPython, isSafe, clip, killTree, _reset: () => { pythonCmd = undefined; } };

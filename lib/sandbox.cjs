'use strict';
// Runs JavaScript the AI wrote in a separate, locked-down Node process:
// no file access, no starting other programs, 10 second limit, small memory, output capped.
const { spawn } = require('node:child_process');

function permissionFlag() {
  const [maj, min] = process.versions.node.split('.').map(Number);
  return maj > 23 || (maj === 23 && min >= 5) || (maj === 22 && min >= 13) ? '--permission' : '--experimental-permission';
}

function runJs(code, { timeoutMs = 10000, maxOut = 20000 } = {}) {
  return new Promise(resolve => {
    if (typeof code !== 'string' || !code.trim()) return resolve({ ok: false, output: 'No code given' });
    if (code.length > 100000) return resolve({ ok: false, output: 'Code too long (100 KB max)' });
    const started = Date.now();
    const child = spawn(process.execPath, [permissionFlag(), '--max-old-space-size=128', '--no-warnings', '-'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { NODE_OPTIONS: '' } });
    let out = '', killed = false;
    const add = d => { if (out.length < maxOut) out += d.toString(); };
    child.stdout.on('data', add); child.stderr.on('data', add);
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, output: 'Could not start the code runner: ' + e.message }); });
    child.on('close', codeNum => {
      clearTimeout(timer);
      let output = out.length >= maxOut ? out.slice(0, maxOut) + '\n…(output cut off)' : out;
      output = output.replace(/^.*ExperimentalWarning.*\n?/gm, '');
      resolve({ ok: !killed && codeNum === 0, timedOut: killed, exitCode: codeNum, ms: Date.now() - started, output: killed ? output + `\n(Stopped: took longer than ${timeoutMs / 1000}s)` : output || '(no output; use console.log to print results)' });
    });
    child.stdin.end(code);
  });
}

module.exports = { runJs, permissionFlag };

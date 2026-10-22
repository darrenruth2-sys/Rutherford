'use strict';
// "Eyes": opens a page in a hidden copy of Edge/Chrome, optionally clicks or presses keys
// (to test a game or a form), takes a screenshot and collects JavaScript errors.
// Talks to the browser over the DevTools protocol (built into Edge/Chrome), so nothing to install.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function candidates() {
  const env = process.env;
  if (process.platform === 'win32') {
    const pf = [env['PROGRAMFILES(X86)'], env.PROGRAMFILES, env.LOCALAPPDATA].filter(Boolean);
    return pf.flatMap(b => [path.join(b, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(b, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(b, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')]);
  }
  if (process.platform === 'darwin') return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'];
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium', '/opt/pw-browsers/chromium/chrome-linux/chrome', ...(() => { try { return fs.readdirSync('/opt/pw-browsers').filter(d => /^chromium-\d+$/.test(d)).map(d => `/opt/pw-browsers/${d}/chrome-linux/chrome`); } catch { return []; } })()];
}
function findBrowser(custom) {
  if (custom && fs.existsSync(custom)) return custom;
  return candidates().find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

// Minimal DevTools-protocol client over the built-in WebSocket
function cdp(wsUrl) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket !== 'function') return reject(Error('Needs Node.js 22 or newer for the browser eyes. Update from nodejs.org.'));
    const ws = new WebSocket(wsUrl); let id = 0; const waiting = new Map(); const listeners = [];
    ws.onopen = () => resolve({
      send: (method, params = {}) => new Promise((res, rej) => { const i = ++id; waiting.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); }),
      on: fn => listeners.push(fn),
      close: () => { try { ws.close(); } catch {} }
    });
    ws.onerror = () => reject(Error('Could not talk to the browser'));
    ws.onmessage = ev => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
      if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.rej(Error(m.error.message)) : w.res(m.result); }
      else if (m.method) listeners.forEach(fn => fn(m));
    };
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * look({url, width, height, actions, waitMs, browserPath})
 * actions: [{click: "css selector"} | {click_at: [x,y]} | {key: "ArrowRight", hold_ms?} | {type: "text"} | {wait: ms} | {scroll: px}]
 * Returns {png: Buffer, errors: [...], logs: [...], title, notes}
 */
async function look({ url, width = 1280, height = 800, mobile = false, actions = [], waitMs = 1500, browserPath, timeoutMs = 45000 }) {
  if (mobile) { width = 390; height = 844; }
  const exe = findBrowser(browserPath);
  if (!exe) throw Error('No Edge or Chrome found. Rutherford uses Microsoft Edge (comes with Windows) or Chrome to look at pages.');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rf-eyes-'));
  const args = ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-sync', '--hide-scrollbars', '--mute-audio', '--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--allow-file-access-from-files', `--window-size=${width},${height}`, 'about:blank'];
  // Linux CI machines/containers often can't use Chrome's sandbox (normal desktops keep it)
  if (process.getuid?.() === 0 || (process.platform === 'linux' && process.env.CI)) args.unshift('--no-sandbox');
  const child = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
  let session = null;
  const kill = () => {
    try { session?.close(); } catch {}
    try { if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => {}); else process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
    setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} }, 1500);
  };
  const deadline = setTimeout(kill, timeoutMs);
  try {
    // Wait for "DevTools listening on ws://127.0.0.1:PORT/devtools/browser/..."
    const port = await new Promise((resolve, reject) => {
      let err = ''; const t = setTimeout(() => reject(Error('The browser did not start')), 20000);
      child.stderr.on('data', d => { err += d; const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(err); if (m) { clearTimeout(t); resolve(Number(m[1])); } });
      child.on('exit', c => { clearTimeout(t); reject(Error('The browser closed right away (' + c + ')' + (err ? ': ' + err.split('\n').slice(-3).join(' ').slice(0, 300) : ''))); });
    });
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find(t => t.type === 'page');
    session = await cdp(page.webSocketDebuggerUrl);
    const errors = [], logs = [];
    session.on(m => {
      if (m.method === 'Runtime.exceptionThrown') { const d = m.params.exceptionDetails; const where = d.url && !/rf-preview-\d+\.html$/.test(d.url) ? ` (${d.url.split('/').pop()} line ${d.lineNumber + 1})` : ` (line ${d.lineNumber + 1})`; errors.push((d.exception?.description || d.text || 'Error').split('\n')[0].slice(0, 400) + where); }
      if (m.method === 'Runtime.consoleAPICalled') { const text = m.params.args.map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300); if (m.params.type === 'error') errors.push('console.error: ' + text); else if (logs.length < 30) logs.push(`console.${m.params.type}: ${text}`); }
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push((m.params.entry.text + (m.params.entry.url ? ' ' + m.params.entry.url : '')).slice(0, 300));
    });
    await session.send('Runtime.enable'); await session.send('Log.enable'); await session.send('Page.enable');
    await session.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: !!mobile });
    let loaded = false; session.on(m => { if (m.method === 'Page.loadEventFired') loaded = true; });
    const nav = await session.send('Page.navigate', { url });
    if (nav.errorText) throw Error('Could not open ' + url + ': ' + nav.errorText);
    for (let i = 0; i < 100 && !loaded; i++) await sleep(100);
    await sleep(Math.min(Math.max(Number(waitMs) || 0, 0), 10000));
    const notes = [];
    const evalJs = async expr => (await session.send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.value;
    for (const a of (Array.isArray(actions) ? actions : []).slice(0, 30)) {
      try {
        if (a.click) {
          const box = await evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(a.click)});if(!e)return null;e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()`);
          if (!box) { notes.push(`click: nothing matches "${a.click}"`); continue; }
          await clickAt(session, box[0], box[1]); notes.push(`clicked ${a.click}`);
        } else if (Array.isArray(a.click_at)) { await clickAt(session, a.click_at[0], a.click_at[1]); notes.push(`clicked at ${a.click_at.join(',')}`); }
        else if (a.key) { await pressKey(session, a.key, a.hold_ms); notes.push(`pressed ${a.key}${a.hold_ms ? ` for ${a.hold_ms}ms` : ''}`); }
        else if (typeof a.type === 'string') { await session.send('Input.insertText', { text: a.type.slice(0, 500) }); notes.push('typed text'); }
        else if (a.scroll) { await evalJs(`window.scrollBy(0, ${Number(a.scroll) || 0})`); notes.push('scrolled'); }
        if (a.wait || a.click || a.key || a.click_at) await sleep(Math.min(Number(a.wait) || 250, 5000));
      } catch (e) { notes.push('action failed: ' + e.message); }
    }
    const title = await evalJs('document.title').catch(() => '');
    const info = await evalJs(`(()=>{const b=document.body;if(!b)return null;const t=(b.innerText||'').trim();return {chars:t.length,canvas:document.querySelectorAll('canvas').length,overflowX:document.documentElement.scrollWidth>innerWidth+2,height:document.documentElement.scrollHeight}})()`).catch(() => null);
    const shot = await session.send('Page.captureScreenshot', { format: 'png' });
    return { png: Buffer.from(shot.data, 'base64'), errors: [...new Set(errors)].slice(0, 20), logs, title, notes, info };
  } finally { clearTimeout(deadline); kill(); }
}

async function clickAt(s, x, y) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await s.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
}
const KEYS = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Enter: 13, Escape: 27, Space: 32, ' ': 32, Tab: 9, Backspace: 8, Shift: 16 };
async function pressKey(s, key, holdMs = 0) {
  const k = key === 'Space' ? ' ' : String(key);
  const code = k.length === 1 ? (k === ' ' ? 'Space' : /[a-z]/i.test(k) ? 'Key' + k.toUpperCase() : /\d/.test(k) ? 'Digit' + k : k) : k;
  const vk = KEYS[k] || (k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0);
  await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, text: k.length === 1 ? k : undefined });
  if (holdMs) await sleep(Math.min(holdMs, 4000));
  await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
}

module.exports = { look, findBrowser };

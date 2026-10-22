'use strict';
// Phone access: lets your phone open Rutherford over your home Wi-Fi (or Tailscale), protected by a PIN.
// Off by default. The laptop itself never needs the PIN; every other device does.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

const COOKIE = 'rf_session';
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const isLoopback = a => !a || a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';

const dgram = require('node:dgram');
// Virtual adapters (Hyper-V, WSL, VirtualBox, VMware, Docker, VPNs) have addresses your phone can't reach.
const VIRTUAL = /vEthernet|WSL|Hyper-?V|VirtualBox|VBox|VMware|VMnet|Docker|docker|veth|virbr|br-|Loopback|Bluetooth|Npcap|ZeroTier|TAP-|TUN|Wintun|NordLynx|ProtonVPN|OpenVPN|WireGuard|Cisco|AnyConnect|GlobalProtect|Fortinet|utun|awdl|llw/i;

// The address this computer actually uses to reach the internet = your real Wi-Fi/Ethernet address.
// A UDP "connect" only picks a route; it sends no packets.
function routeIp(timeoutMs = 800) {
  return new Promise(resolve => {
    let done = false; const finish = v => { if (done) return; done = true; try { sock.close(); } catch {} resolve(v); };
    const sock = dgram.createSocket('udp4');
    sock.on('error', () => finish(null));
    setTimeout(() => finish(null), timeoutMs).unref?.();
    try { sock.connect(53, '1.1.1.1', () => { try { finish(sock.address().address); } catch { finish(null); } }); } catch { finish(null); }
  });
}

function lanAddresses(primary = null, ifaces = os.networkInterfaces()) {
  const out = [];
  for (const [name, list] of Object.entries(ifaces)) for (const a of list || []) {
    if (a.family !== 'IPv4' && a.family !== 4) continue;
    if (a.internal || a.address.startsWith('169.254.')) continue;
    const tailscale = a.address.startsWith('100.') && (/tailscale/i.test(name) || !VIRTUAL.test(name));
    const isPrimary = a.address === primary;
    const virtual = !isPrimary && !tailscale && VIRTUAL.test(name);
    const kind = isPrimary ? 'Home Wi-Fi (use this one)' : tailscale ? 'Tailscale (works away from home)' : virtual ? 'Virtual adapter (phone can’t use this)' : /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address) ? 'Home network' : 'Network';
    out.push({ ip: a.address, name, kind, primary: isPrimary, virtual });
  }
  const rank = a => a.primary ? 0 : a.virtual ? 3 : a.kind.startsWith('Tailscale') ? 2 : 1;
  return out.sort((x, y) => rank(x) - rank(y));
}

function create({ dataDir, handler, defaultPort = 3780 }) {
  const file = path.join(dataDir, 'phone.json');
  let cfg = { enabled: false, port: defaultPort, pin: '', sessions: [] };
  try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch {}
  const save = () => { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(cfg, null, 1), { mode: 0o600 }); };
  const newPin = () => String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  if (!cfg.pin) { cfg.pin = newPin(); save(); }
  let server = null, lastError = null;
  const fails = new Map(); // ip -> {n, until}

  function cookieToken(req) { const m = new RegExp('(?:^|;\\s*)' + COOKIE + '=([a-f0-9]{64})').exec(req.headers.cookie || ''); return m ? m[1] : null; }
  function authed(req) { const t = cookieToken(req); return !!t && cfg.sessions.some(s => s.hash === sha(t)); }

  function loginPage(res, msg = '') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rutherford · Sign in</title><link rel="manifest" href="/manifest.json"><meta name="theme-color" content="#0c0916"><link rel="apple-touch-icon" href="/icon-192.png">
<style>body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#0c0916;color:#ece8f7;font:16px system-ui,sans-serif}form{width:min(340px,90vw);text-align:center}img{width:110px;filter:drop-shadow(0 0 18px rgba(168,101,255,.5))}h1{font-weight:300;letter-spacing:.14em;text-transform:uppercase;font-size:20px}input{width:100%;box-sizing:border-box;font-size:28px;letter-spacing:.4em;text-align:center;padding:12px;border-radius:14px;border:1px solid #3a2f5e;background:#151027;color:#fff;outline:none}input:focus{border-color:#a865ff}button{margin-top:14px;width:100%;padding:13px;border:0;border-radius:12px;background:#a865ff;color:#120a22;font-weight:700;font-size:16px}p{color:#9b93b6;font-size:14px}.e{color:#ff5d78}</style></head>
<body><form method="post" action="/api/phone-login"><img src="/rutherford-neon-r.png" alt=""><h1>Rutherford</h1><p>Enter the PIN shown in Rutherford → Settings → Phone access on your computer.</p>
<input name="pin" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="6" autofocus required><button>Unlock</button>${msg ? `<p class="e">${msg}</p>` : ''}</form></body></html>`);
  }

  async function readForm(req) { let b = ''; for await (const c of req) { b += c; if (b.length > 2000) break; } return b.includes('=') && !b.trim().startsWith('{') ? Object.fromEntries(new URLSearchParams(b)) : (() => { try { return JSON.parse(b); } catch { return {}; } })(); }

  // Gate for requests that did NOT come from this computer
  async function gate(req, res) {
    const ip = req.socket.remoteAddress || '';
    const url = new URL(req.url, 'http://x');
    if (!cfg.enabled) { res.writeHead(403); res.end('Phone access is off'); return true; }
    if (url.pathname === '/api/phone-login' && req.method === 'POST') {
      const f = fails.get(ip);
      if (f && f.n >= 5 && Date.now() < f.until) { loginPage(res, 'Too many wrong PINs. Wait 10 minutes.'); return true; }
      const body = await readForm(req);
      const ok = typeof body.pin === 'string' && body.pin.length === cfg.pin.length && crypto.timingSafeEqual(Buffer.from(body.pin), Buffer.from(cfg.pin));
      if (!ok) { const n = (f && Date.now() < f.until ? f.n : 0) + 1; fails.set(ip, { n, until: Date.now() + 600000 }); loginPage(res, 'Wrong PIN'); return true; }
      fails.delete(ip);
      const token = crypto.randomBytes(32).toString('hex');
      cfg.sessions.push({ hash: sha(token), created: new Date().toISOString(), device: String(req.headers['user-agent'] || '').slice(0, 120) });
      cfg.sessions = cfg.sessions.slice(-20); save();
      res.writeHead(303, { Location: '/', 'Set-Cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` });
      res.end(); return true;
    }
    const open = ['/manifest.json', '/icon-192.png', '/icon-512.png', '/rutherford-neon-r.png'];
    if (open.includes(url.pathname)) return false;
    if (!authed(req)) {
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/alpha/api/')) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":"Sign in with your PIN"}'); }
      else loginPage(res);
      return true;
    }
    if (req.method === 'POST') { const o = req.headers.origin; if (o && o !== 'http://' + req.headers.host) { res.writeHead(403); res.end('Forbidden'); return true; } }
    // Phone can't change phone-access settings or see the PIN
    if (url.pathname.startsWith('/api/phone')) { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end('{"error":"Change phone access from the computer"}'); return true; }
    return false;
  }

  function start() {
    if (server) return Promise.resolve();
    return new Promise(resolve => {
      server = http.createServer((req, res) => handler(req, res, { remote: true }));
      server.once('error', e => { lastError = e.code === 'EADDRINUSE' ? `Port ${cfg.port} is busy` : e.message; server = null; resolve(); });
      server.listen(cfg.port, '0.0.0.0', () => { lastError = null; resolve(); });
    });
  }
  function stop() { return new Promise(r => { if (!server) return r(); server.close(() => r()); server.closeAllConnections?.(); server = null; }); }

  async function status() {
    const primary = await routeIp();
    const all = lanAddresses(primary).map(a => ({ ...a, url: `http://${a.ip}:${cfg.port}` }));
    const urls = all.filter(a => !a.virtual);
    return { enabled: cfg.enabled, running: !!server, port: cfg.port, pin: cfg.pin, error: lastError, devices: cfg.sessions.length,
      urls: urls.length ? urls : all, hidden: urls.length ? all.filter(a => a.virtual).map(a => a.ip) : [] };
  }
  // Checks that each address answers from this computer (finds wrong/dead addresses; can't see the firewall).
  async function test(fetchImpl = fetch) {
    const st = await status();
    if (!st.running) return { ...st, test: [] };
    st.test = await Promise.all(st.urls.map(async u => {
      try { const r = await fetchImpl(u.url + '/manifest.json', { signal: AbortSignal.timeout(2500) }); return { url: u.url, ok: r.ok }; }
      catch { return { url: u.url, ok: false }; }
    }));
    return st;
  }
  async function update(b) {
    if (b.test) return test();
    if (b.newPin) { cfg.pin = newPin(); cfg.sessions = []; }
    if (b.signOutAll) cfg.sessions = [];
    if (b.port !== undefined) { const p = Number(b.port); if (!(p >= 1024 && p <= 65535)) throw Error('Port must be 1024–65535'); if (p !== cfg.port) { cfg.port = p; if (server) { await stop(); } } }
    if (b.enabled !== undefined) cfg.enabled = !!b.enabled;
    save();
    if (cfg.enabled) await start(); else await stop();
    return status();
  }

  return { gate, start, stop, status, update, test, isLoopback, get enabled() { return cfg.enabled; } };
}

module.exports = { create, isLoopback, lanAddresses, routeIp };

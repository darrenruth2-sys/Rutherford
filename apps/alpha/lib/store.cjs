'use strict';
// JSON file storage for Alpha: settings, portfolio, forecasts. All local.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 }); fs.renameSync(tmp, file); }
  finally { try { fs.unlinkSync(tmp); } catch {} }
}
const read = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return structuredClone(fallback); } };

const DEFAULT_SETTINGS = { groqKey: '', model: 'openai/gpt-oss-120b', watchlist: ['BTC-USD', 'ETH-USD', 'SOL-USD', 'DOGE-USD', 'SPY', 'AAPL', 'NVDA', 'TSLA'], feePct: 0.25, stockFeePct: 0.05, maxPositionPct: 50, autoForecast: false, autoEveryMin: 15, alpacaKeyId: '', alpacaSecret: '', alpacaLiveKeyId: '', alpacaLiveSecret: '', arenaOn: true, botEveryMin: 5, aiEveryMin: 15, evolveHours: 24, botStartCash: 1000, botsUsePolymarket: true };
const freshPortfolio = (cash = 1000) => ({ startCash: cash, cash, positions: {}, trades: [], created: new Date().toISOString() });

function create(dir) {
  const f = name => path.join(dir, name + '.json');
  return {
    dir,
    settings: {
      get: () => ({ ...DEFAULT_SETTINGS, ...read(f('settings'), {}) }),
      set(patch) { const s = { ...this.get() }; for (const k of Object.keys(DEFAULT_SETTINGS)) if (patch[k] !== undefined) s[k] = patch[k]; write(f('settings'), s); return s; }
    },
    portfolio: { get: () => read(f('portfolio'), freshPortfolio()), set: p => (write(f('portfolio'), p), p), reset: cash => { const p = freshPortfolio(cash); write(f('portfolio'), p); return p; } },
    forecasts: { get: () => read(f('forecasts'), []), set: list => (write(f('forecasts'), list.slice(-20000)), list) },
    arena: { get: () => read(f('arena'), null), set: a => (write(f('arena'), a), a) },
    live: { get: () => read(f('live'), null), set: a => (write(f('live'), a), a) },
    picks: { get: () => read(f('picks'), null), set: a => (write(f('picks'), a), a) }
  };
}

module.exports = { create, DEFAULT_SETTINGS, freshPortfolio };

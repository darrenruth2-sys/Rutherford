'use strict';
// Forecast strategies + honest scoring. Signals come from 5-minute candles.
const sma = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

const STRATEGIES = [
  { id: 'momentum', name: 'Momentum', about: 'Bets the last hour\'s move keeps going.' },
  { id: 'reversion', name: 'Mean reversion', about: 'Bets price snaps back toward its 1-hour average.' },
  { id: 'trend', name: 'Trend cross', about: 'Up when the 1-hour average is above the 3-hour average.' },
  { id: 'calm-momentum', name: 'Calm momentum', about: 'Momentum, but sits out when the last hour was choppy (>2.5% range).' },
  { id: 'coin', name: 'Coin flip', about: 'Random. The baseline every strategy has to beat.' }
];
const HORIZONS = [15, 60, 240]; // minutes

// candles: oldest→newest 5-min candles. Returns {strategy, direction:'up'|'down'|null, why}
function signals(candles, rand = Math.random) {
  const c = candles.map(x => x.c);
  if (c.length < 37) return STRATEGIES.map(s => ({ strategy: s.id, direction: s.id === 'coin' ? (rand() < 0.5 ? 'up' : 'down') : null, why: s.id === 'coin' ? 'Coin flip' : 'Not enough price history yet' }));
  const last = c.at(-1), hourAgo = c.at(-13), hour = c.slice(-12), fast = sma(c.slice(-12)), slow = sma(c.slice(-36));
  const mom = (last - hourAgo) / hourAgo;
  const range = (Math.max(...candles.slice(-12).map(x => x.h)) - Math.min(...candles.slice(-12).map(x => x.l))) / last;
  const pct = x => (x * 100).toFixed(2) + '%';
  const dir = x => (x > 0 ? 'up' : x < 0 ? 'down' : null);
  return [
    { strategy: 'momentum', direction: dir(mom), why: `Moved ${pct(mom)} in the last hour` },
    { strategy: 'reversion', direction: dir(sma(hour) - last), why: `Price is ${pct((last - sma(hour)) / sma(hour))} from its 1h average` },
    { strategy: 'trend', direction: dir(fast - slow), why: `1h avg is ${pct((fast - slow) / slow)} vs 3h avg` },
    { strategy: 'calm-momentum', direction: range > 0.025 ? null : dir(mom), why: range > 0.025 ? `Sitting out: 1h range was ${pct(range)}` : `Calm hour (${pct(range)} range), moved ${pct(mom)}` },
    { strategy: 'coin', direction: rand() < 0.5 ? 'up' : 'down', why: 'Coin flip' }
  ];
}

// 95% Wilson score interval for a win rate
function wilson(wins, n) {
  if (!n) return null;
  const z = 1.96, p = wins / n, d = 1 + z * z / n;
  const centre = (p + z * z / (2 * n)) / d, half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0, centre - half) * 100, Math.min(1, centre + half) * 100];
}

function verdict(wins, n) {
  if (n < 20) return { tag: 'too-early', text: `Too early: need ${20 - n} more results` };
  const [lo, hi] = wilson(wins, n);
  if (lo > 50) return { tag: 'edge', text: 'Beating a coin flip so far' };
  if (hi < 50) return { tag: 'worse', text: 'Worse than a coin flip (try the opposite?)' };
  return { tag: 'noise', text: 'Not distinguishable from a coin flip yet' };
}

function scoreboard(forecasts) {
  const done = forecasts.filter(f => f.result === 'win' || f.result === 'loss');
  const row = (list, extra) => { const wins = list.filter(f => f.result === 'win').length, n = list.length; return { ...extra, n, wins, accuracy: n ? wins / n * 100 : null, ci: wilson(wins, n), verdict: verdict(wins, n) }; };
  const strategies = [...STRATEGIES, { id: 'me', name: 'Me', about: 'Your own calls.' }].map(s => ({
    ...row(done.filter(f => f.strategy === s.id), { id: s.id, name: s.name, about: s.about }),
    pending: forecasts.filter(f => f.strategy === s.id && !f.result).length,
    byHorizon: HORIZONS.map(h => row(done.filter(f => f.strategy === s.id && f.horizon === h), { horizon: h }))
  }));
  return { strategies, totals: { settled: done.length, pending: forecasts.filter(f => !f.result).length, pushes: forecasts.filter(f => f.result === 'push').length } };
}

module.exports = { STRATEGIES, HORIZONS, signals, wilson, verdict, scoreboard };

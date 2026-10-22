'use strict';
// Small line diff for showing proposed changes. Returns rows: {t:' '|'+'|'-', a, b, text}
function diffLines(before, after) {
  const A = before === '' ? [] : before.split('\n'), B = after.split('\n');
  let s = 0; while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let ea = A.length, eb = B.length; while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) { ea--; eb--; }
  const a = A.slice(s, ea), b = B.slice(s, eb);
  let mid = [];
  if (a.length * b.length <= 4_000_000) {
    const n = a.length, m = b.length, L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) { if (a[i] === b[j]) { mid.push([' ', a[i]]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) mid.push(['-', a[i++]]); else mid.push(['+', b[j++]]); }
    while (i < n) mid.push(['-', a[i++]]); while (j < m) mid.push(['+', b[j++]]);
  } else { mid = [...a.map(x => ['-', x]), ...b.map(x => ['+', x])]; }
  const rows = []; let la = 1, lb = 1;
  for (let k = 0; k < s; k++) rows.push({ t: ' ', a: la++, b: lb++, text: A[k] });
  for (const [t, text] of mid) rows.push(t === ' ' ? { t, a: la++, b: lb++, text } : t === '-' ? { t, a: la++, text } : { t, b: lb++, text });
  for (let k = ea; k < A.length; k++) rows.push({ t: ' ', a: la++, b: lb++, text: A[k] });
  return rows;
}

// Keep only changed lines plus `ctx` lines around them; gaps become {t:'…'}
function hunks(rows, ctx = 3) {
  const keep = new Array(rows.length).fill(false);
  rows.forEach((r, i) => { if (r.t !== ' ') for (let k = Math.max(0, i - ctx); k <= Math.min(rows.length - 1, i + ctx); k++) keep[k] = true; });
  const out = []; let gap = false;
  rows.forEach((r, i) => { if (keep[i]) { out.push(r); gap = false; } else if (!gap) { out.push({ t: '…' }); gap = true; } });
  return out;
}

function stats(rows) { return { added: rows.filter(r => r.t === '+').length, removed: rows.filter(r => r.t === '-').length }; }

module.exports = { diffLines, hunks, stats };

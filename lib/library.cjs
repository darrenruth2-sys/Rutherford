'use strict';
// The Library: your own searchable knowledge base. Docs are split into passages and
// indexed locally with BM25 (the classic search-engine ranking). Nothing leaves your computer.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const STOP = new Set('a an and are as at be but by for from has have he her his i if in into is it its of on or our she so than that the their them then there these they this to was we were what when where which who will with you your not no can do does did just also about how more'.split(' '));
const TEXT_EXT = /\.(md|markdown|txt|rst|adoc|html?|xml|json|ya?ml|toml|csv|js|mjs|cjs|jsx|ts|tsx|py|java|c|h|cpp|hpp|cs|go|rs|rb|php|lua|gd|gdscript|swift|kt|sql|sh|ps1|css|scss|vue|svelte|tex|ini|cfg)$/i;
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', '.cache']);

function tokenize(text) {
  const out = [];
  for (const raw of String(text).match(/[\p{L}\p{N}_]+/gu) || []) {
    const parts = raw.length > 3 && /[a-z][A-Z]/.test(raw) ? [raw, ...raw.split(/(?<=[a-z])(?=[A-Z])/)] : [raw];
    for (let w of parts) {
      w = w.toLowerCase();
      if (w.length < 2 || w.length > 40 || STOP.has(w)) continue;
      if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1); // light plural folding
      out.push(w);
    }
  }
  return out;
}

// Split text into ~1400 char passages on paragraph boundaries, remembering page/heading for citations.
function chunk(text, size = 1400) {
  const chunks = []; let buf = '', where = '', page = '', heading = '';
  const flush = () => { const t = buf.trim(); if (t.length > 30) chunks.push({ text: t, where }); buf = ''; };
  for (let para of String(text).split(/\n\s*\n/)) {
    const pm = /^--- Page (\d+) ---/m.exec(para); if (pm) { if (buf) flush(); page = 'p. ' + pm[1]; } // start a new passage on each PDF page so citations are exact
    const hm = /^#{1,4}\s+(.{2,80})$/m.exec(para); if (hm) heading = hm[1].trim();
    if (buf.length + para.length > size && buf) { flush(); }
    if (!buf) where = [page, heading].filter(Boolean).join(' · ');
    para = para.replace(/^--- Page \d+ ---\s*/m, ''); if (!para.trim()) continue;
    if (para.length > size * 1.5) { for (let i = 0; i < para.length; i += size) { buf = para.slice(i, i + size); flush(); where = [page, heading].filter(Boolean).join(' · '); } continue; }
    buf += (buf ? '\n\n' : '') + para;
  }
  flush();
  return chunks;
}

function create(dir) {
  const docsFile = path.join(dir, 'docs.json');
  const chunkDir = path.join(dir, 'chunks');
  let docs = []; try { docs = JSON.parse(fs.readFileSync(docsFile, 'utf8')); } catch {}
  let index = null; // built lazily

  const saveDocs = () => { fs.mkdirSync(dir, { recursive: true }); const tmp = docsFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(docs, null, 1)); fs.renameSync(tmp, docsFile); };
  const readChunks = id => { try { return JSON.parse(fs.readFileSync(path.join(chunkDir, id + '.json'), 'utf8')); } catch { return []; } };

  function build() {
    const postings = new Map(); const meta = []; let totalLen = 0;
    for (const d of docs) {
      readChunks(d.id).forEach((c, i) => {
        const toks = tokenize(d.title + ' ' + c.where + ' ' + c.text);
        const tf = new Map(); for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
        const ci = meta.length; meta.push({ doc: d.id, i, len: toks.length }); totalLen += toks.length;
        for (const [t, n] of tf) { let p = postings.get(t); if (!p) postings.set(t, p = []); p.push(ci, n); }
      });
    }
    index = { postings, meta, avg: meta.length ? totalLen / meta.length : 1 };
    return index;
  }

  function add({ title, text, source = '', kind = 'text' }) {
    text = String(text || '');
    if (text.trim().length < 20) throw Error('That document has no readable text');
    if (text.length > 25_000_000) throw Error('Document too large (25 MB of text max)');
    const id = crypto.randomUUID();
    const chunks = chunk(text);
    fs.mkdirSync(chunkDir, { recursive: true });
    fs.writeFileSync(path.join(chunkDir, id + '.json'), JSON.stringify(chunks));
    const doc = { id, title: String(title || 'Untitled').slice(0, 200), source: String(source).slice(0, 500), kind, chars: text.length, chunks: chunks.length, added: new Date().toISOString() };
    docs.push(doc); saveDocs(); index = null;
    return doc;
  }

  function addFolder(folder, { maxFiles = 4000, maxBytes = 300 * 1024 * 1024 } = {}) {
    const root = fs.realpathSync(path.resolve(String(folder || '').trim().replace(/^"|"$/g, '')));
    if (!fs.statSync(root).isDirectory()) throw Error('Not a folder');
    let files = 0, bytes = 0; const added = [];
    const walk = d => {
      let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (files >= maxFiles || bytes >= maxBytes) return;
        if (e.name.startsWith('.') || SKIP_DIR.has(e.name) || e.isSymbolicLink()) continue;
        const abs = path.join(d, e.name);
        if (e.isDirectory()) { walk(abs); continue; }
        if (!TEXT_EXT.test(e.name)) continue;
        const st = fs.statSync(abs); if (st.size > 5 * 1024 * 1024 || st.size < 40) continue;
        let text = fs.readFileSync(abs, 'utf8'); if (text.includes('\0')) continue;
        if (/\.html?$/i.test(e.name)) text = require('./web.cjs').htmlToText(text).text;
        try { added.push(add({ title: path.relative(root, abs).replaceAll('\\', '/'), text, source: abs, kind: 'file' })); files++; bytes += st.size; } catch {}
      }
    };
    walk(root);
    if (!added.length) throw Error('No readable text files found in that folder (supported: .md, .txt, .html, code files and more)');
    return { folder: root, added: added.length, bytes, capped: files >= maxFiles || bytes >= maxBytes };
  }

  function remove(id) {
    const before = docs.length; docs = docs.filter(d => d.id !== id);
    if (docs.length === before) throw Error('Document not found');
    try { fs.unlinkSync(path.join(chunkDir, id + '.json')); } catch {}
    saveDocs(); index = null; return { removed: true };
  }

  function search(query, k = 6) {
    const ix = index || build();
    const q = [...new Set(tokenize(query))];
    if (!q.length || !ix.meta.length) return [];
    const N = ix.meta.length, k1 = 1.4, b = 0.75, scores = new Map(), hits = new Map();
    for (const t of q) {
      const p = ix.postings.get(t); if (!p) continue;
      const df = p.length / 2, idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (let j = 0; j < p.length; j += 2) {
        const ci = p[j], tf = p[j + 1], len = ix.meta[ci].len;
        scores.set(ci, (scores.get(ci) || 0) + idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * len / ix.avg)));
        hits.set(ci, (hits.get(ci) || 0) + 1);
      }
    }
    // reward passages that match more of the query words
    for (const [ci, s] of scores) scores.set(ci, s * (0.5 + 0.5 * hits.get(ci) / q.length));
    const top = [...scores].sort((a, b) => b[1] - a[1]).slice(0, k);
    const cache = new Map();
    return top.map(([ci, score]) => {
      const m = ix.meta[ci]; const d = docs.find(x => x.id === m.doc);
      if (!cache.has(m.doc)) cache.set(m.doc, readChunks(m.doc));
      const c = cache.get(m.doc)[m.i];
      return { docId: m.doc, title: d?.title, source: d?.source, where: c.where, text: c.text, score: Math.round(score * 100) / 100 };
    });
  }

  const list = () => [...docs].reverse();
  const stats = () => ({ docs: docs.length, chunks: docs.reduce((a, d) => a + d.chunks, 0), chars: docs.reduce((a, d) => a + d.chars, 0) });
  return { add, addFolder, remove, search, list, stats };
}

module.exports = { create, tokenize, chunk };

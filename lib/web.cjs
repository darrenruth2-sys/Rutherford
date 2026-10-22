'use strict';
// Web tools: search (via Groq's built-in browser_search), read a webpage, and make images (Pollinations).
const dns = require('node:dns').promises;
const net = require('node:net');
const groq = require('./groq.cjs');

// ---------- Web search ----------
async function webSearch({ key, query, fetchImpl = fetch, model = 'openai/gpt-oss-20b', now = new Date() }) {
  if (!key) throw Error('Web search needs your Groq key');
  query = String(query || '').trim().slice(0, 400);
  if (!query) throw Error('Search needs some words');
  const body = {
    model, max_tokens: 2500,
    tools: [{ type: 'browser_search' }],
    messages: [
      { role: 'system', content: `You are a web research helper. Today is ${now.toDateString()}. Search the web, then report the key facts that answer the query in a compact bullet list. Put the source URL after each fact in parentheses. Include dates when they matter. Say clearly if results conflict or nothing reliable was found.` },
      { role: 'user', content: query }
    ]
  };
  let res;
  try { res = await fetchImpl(groq.BASE + '/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) }); }
  catch { throw Error('Could not reach Groq for web search'); }
  let data = null; try { data = await res.json(); } catch {}
  if (!res.ok) {
    if (res.status === 429) throw Error('Web search hit the Groq rate limit. Wait a minute and try again.');
    throw Error('Web search failed (HTTP ' + res.status + ')' + (data?.error?.message ? ': ' + String(data.error.message).slice(0, 200) : ''));
  }
  const msg = data?.choices?.[0]?.message || {};
  const sources = []; const seen = new Set();
  for (const t of msg.executed_tools || []) {
    for (const r of t?.search_results?.results || []) if (r?.url && !seen.has(r.url)) { seen.add(r.url); sources.push({ title: String(r.title || r.url).slice(0, 140), url: r.url }); }
  }
  for (const m of String(msg.content || '').matchAll(/https?:\/\/[^\s)\]>"']+/g)) {
    const url = m[0].replace(/[.,;]+$/, '');
    if (!seen.has(url)) { seen.add(url); sources.push({ title: new URL(url).hostname.replace(/^www\./, ''), url }); }
  }
  const text = String(msg.content || '').trim();
  if (!text) throw Error('Web search returned nothing');
  return { text, sources: sources.slice(0, 12) };
}

// ---------- Read a webpage ----------
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const x = ip.toLowerCase();
  return x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80') || x.startsWith('::ffff:127.') || x.startsWith('::ffff:10.') || x.startsWith('::ffff:192.168.');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©' };
function htmlToText(html) {
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '').trim();
  let s = html
    .replace(/<(script|style|noscript|svg|nav|footer|header|aside|form|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(h[1-6])[^>]*>/gi, '\n\n## ')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<(br|\/p|\/div|\/tr|\/h[1-6]|\/li|\/pre|\/blockquote|\/section|\/article)[^>]*>/gi, '\n')
    .replace(/<(td|th)[^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m);
  s = s.split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).filter((l, i, a) => l || (a[i - 1] && a[i - 1].trim())).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title: title.replace(/\s+/g, ' '), text: s };
}

async function readPage({ url, fetchImpl = fetch, lookup = h => dns.lookup(h, { all: true }), maxChars = 30000 }) {
  let u; try { u = new URL(String(url).trim()); } catch { throw Error('That is not a valid URL'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw Error('Only http(s) links');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) throw Error('Local network addresses are blocked');
  const ips = net.isIP(host) ? [{ address: host }] : await lookup(host).catch(() => { throw Error("Couldn't find that website"); });
  if (ips.some(a => isPrivateIp(a.address))) throw Error('Local network addresses are blocked');
  let res;
  try { res = await fetchImpl(u.href, { headers: { 'User-Agent': 'Mozilla/5.0 (Rutherford AI reader)', Accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' }, redirect: 'follow', signal: AbortSignal.timeout(20000) }); }
  catch { throw Error("Couldn't load that page"); }
  if (!res.ok) throw Error('Page returned HTTP ' + res.status);
  const type = res.headers.get('content-type') || '';
  if (!/text|json|xml/.test(type)) throw Error('That link is not a web page (' + (type.split(';')[0] || 'unknown type') + ')');
  const raw = (await res.text()).slice(0, 3_000_000);
  const { title, text } = /html/.test(type) || /^\s*</.test(raw) ? htmlToText(raw) : { title: '', text: raw };
  return { url: res.url || u.href, title: title || u.hostname, text: text.slice(0, maxChars), truncated: text.length > maxChars };
}

// ---------- Make an image ----------
async function makeImage({ prompt, width = 1024, height = 1024, token = '', fetchImpl = fetch }) {
  prompt = String(prompt || '').trim().slice(0, 1500);
  if (!prompt) throw Error('Describe the image');
  const w = Math.max(256, Math.min(1536, Math.round(Number(width) / 64) * 64 || 1024));
  const h = Math.max(256, Math.min(1536, Math.round(Number(height) / 64) * 64 || 1024));
  const seed = Math.floor(Math.random() * 1e9);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${w}&height=${h}&seed=${seed}&nologo=true&model=flux`;
  let res;
  try { res = await fetchImpl(url, { headers: token ? { Authorization: 'Bearer ' + token } : {}, signal: AbortSignal.timeout(120000) }); }
  catch { throw Error('Image service did not respond. Try again in a moment.'); }
  if (res.status === 429) throw Error('Image service is busy (free tier allows about one image every 15 seconds). Wait a bit and retry.');
  if (!res.ok) throw Error('Image service error (HTTP ' + res.status + ')');
  const type = res.headers.get('content-type') || '';
  if (!type.startsWith('image/')) throw Error('Image service returned something that is not an image');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 500) throw Error('Image came back empty');
  return { buffer: buf, ext: type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg', width: w, height: h };
}

module.exports = { webSearch, readPage, makeImage, htmlToText, isPrivateIp };

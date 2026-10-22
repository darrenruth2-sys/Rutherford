'use strict';
// Live docs lookup: the current version and README of a JavaScript (npm) or Python (PyPI) library,
// trimmed to the parts that match what the AI is asking about. Free, no keys.
// Also voice-to-text through Groq's Whisper.

const tokens = s => String(s || '').toLowerCase().match(/[a-z0-9_$.]{2,}/g) || [];

// Split markdown into sections and keep the ones that best match the topic
function pickSections(md, topic, maxChars = 9000) {
  const text = String(md || '').replace(/<!--[\s\S]*?-->/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/<img[^>]*>/gi, '').replace(/<\/?(p|div|br|picture|source|a|h\d|span|sup|sub|b|strong|em|i|center|details|summary)\b[^>]*>/gi, '').replace(/\[\]\([^)]*\)/g, '').replace(/\n{3,}/g, '\n\n');
  const parts = text.split(/\n(?=#{1,4} )/);
  if (!topic || text.length <= maxChars) return text.slice(0, maxChars);
  const q = new Set(tokens(topic));
  const scored = parts.map((p, i) => {
    const t = tokens(p); let hit = 0; for (const w of t) if (q.has(w)) hit++;
    const head = tokens(p.split('\n')[0]); let hh = 0; for (const w of head) if (q.has(w)) hh++;
    return { p, i, score: hit / Math.sqrt(t.length + 20) + hh * 2 + (i === 0 ? 0.5 : 0) };
  }).sort((a, b) => b.score - a.score);
  const keep = []; let n = 0;
  for (const s of scored) { if (n + s.p.length > maxChars) continue; keep.push(s); n += s.p.length; if (n > maxChars * 0.9) break; }
  return keep.sort((a, b) => a.i - b.i).map(s => s.p.trim()).join('\n\n');
}

async function getJson(url, fetchImpl) {
  const r = await fetchImpl(url, { headers: { Accept: 'application/json', 'User-Agent': 'Rutherford' }, signal: AbortSignal.timeout(15000) });
  if (r.status === 404) return null;
  if (!r.ok) throw Error('HTTP ' + r.status + ' from ' + new URL(url).hostname);
  return r.json();
}

// Many npm packages (monorepos) don't publish a README; get it from GitHub instead
async function githubReadme(repo, fetchImpl) {
  const url = typeof repo === 'string' ? repo : repo?.url; if (!url) return '';
  const m = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[#/].*)?$/.exec(url); if (!m) return '';
  const dir = typeof repo === 'object' && repo.directory ? repo.directory.replace(/^\/|\/$/g, '') + '/' : '';
  for (const f of [dir + 'README.md', dir + 'readme.md', 'README.md']) {
    try { const r = await fetchImpl(`https://raw.githubusercontent.com/${m[1]}/${m[2]}/HEAD/${f}`, { signal: AbortSignal.timeout(12000) }); if (r.ok) { const t = await r.text(); if (t.length > 100) return t; } } catch {}
  }
  return '';
}

async function lookup(opts) {
  const { name, ecosystem = 'auto' } = opts;
  if (ecosystem !== 'auto') return lookupIn(opts);
  // Both registries: some names exist on both (e.g. "numpy" is a tiny placeholder on npm). Keep the real one.
  const [a, b] = await Promise.allSettled([lookupIn({ ...opts, ecosystem: 'npm' }), lookupIn({ ...opts, ecosystem: 'python' })]);
  const npm = a.status === 'fulfilled' ? a.value : null, py = b.status === 'fulfilled' ? b.value : null;
  if (npm && py) return (py.docs.length > npm.docs.length * 3 || /^0\.0\./.test(npm.version)) ? { ...py, alsoOn: 'npm' } : { ...npm, alsoOn: 'PyPI' };
  if (npm || py) return npm || py;
  throw (a.reason?.message?.startsWith("Couldn't") ? a.reason : b.reason) || Error('Not found: ' + name);
}

async function lookupIn({ name, ecosystem, topic = '', fetchImpl = fetch }) {
  const pkg = String(name || '').trim();
  if (!pkg || pkg.length > 214 || !/^(@[\w.-]+\/)?[\w.-]+$/.test(pkg)) throw Error('Give a package name like "phaser", "react", "@supabase/supabase-js" or "numpy"');
  const tries = ecosystem === 'python' ? ['python'] : ['npm'];
  for (const eco of tries) {
    if (eco === 'npm') {
      const j = await getJson('https://registry.npmjs.org/' + pkg.replace('/', '%2F'), fetchImpl);
      if (!j || j.error) continue;
      const latest = j['dist-tags']?.latest; const v = j.versions?.[latest] || {};
      let readme = j.readme || v.readme || '';
      if (readme.length < 200) readme = (await githubReadme(v.repository || j.repository, fetchImpl)) || readme;
      return { ecosystem: 'npm', name: pkg, version: latest, description: j.description || v.description || '', homepage: j.homepage || v.homepage || '', updated: j.time?.[latest] || '', install: `npm install ${pkg}`,
        docs: pickSections(readme, topic) || '(no README published)', url: 'https://www.npmjs.com/package/' + pkg };
    }
    if (eco === 'python') {
      const j = await getJson('https://pypi.org/pypi/' + encodeURIComponent(pkg) + '/json', fetchImpl);
      if (!j?.info) continue;
      const i = j.info; const files = j.releases?.[i.version] || [];
      return { ecosystem: 'python', name: i.name, version: i.version, description: i.summary || '', homepage: i.project_urls?.Documentation || i.home_page || i.project_urls?.Homepage || '', updated: files[0]?.upload_time || '', install: `pip install ${i.name}`, requires: i.requires_python || '',
        docs: pickSections(i.description || '', topic) || '(no description published)', url: 'https://pypi.org/project/' + i.name + '/' };
    }
  }
  throw Error(`Couldn't find a package called "${pkg}" on ${ecosystem === 'python' ? 'PyPI' : 'npm'}. For web/game engines (MDN, Godot, Unity), use web search or read their docs page instead.`);
}

// ---------- Voice: Groq Whisper ----------
async function transcribe({ key, audio, mime = 'audio/webm', fetchImpl = fetch, language }) {
  if (!key) throw Error('Voice typing uses your Groq key. Add one in Settings → Free AI brains.');
  if (!audio?.length) throw Error('No audio recorded');
  if (audio.length > 24 * 1024 * 1024) throw Error('Recording too long (about 25 MB max)');
  const ext = /ogg/.test(mime) ? 'ogg' : /mp4|m4a|aac/.test(mime) ? 'm4a' : /wav/.test(mime) ? 'wav' : 'webm';
  const fd = new FormData();
  fd.append('file', new Blob([audio], { type: mime }), 'voice.' + ext);
  fd.append('model', 'whisper-large-v3-turbo');
  fd.append('response_format', 'json');
  if (language) fd.append('language', language);
  const r = await fetchImpl('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: fd, signal: AbortSignal.timeout(60000) });
  let j = null; try { j = await r.json(); } catch {}
  if (!r.ok) throw Error(r.status === 429 ? 'Voice limit hit for now. Try again in a minute.' : r.status === 401 ? 'Groq rejected the key. Check Settings.' : 'Voice typing failed: ' + (j?.error?.message || 'HTTP ' + r.status));
  return { text: String(j?.text || '').trim() };
}

module.exports = { lookup, pickSections, transcribe };

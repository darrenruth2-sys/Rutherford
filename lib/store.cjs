'use strict';
// Local storage for settings, memory, conversations and images. Everything stays on this computer.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  try { fs.writeFileSync(tmp, data, { mode: 0o600 }); fs.renameSync(tmp, file); }
  finally { try { fs.unlinkSync(tmp); } catch {} }
}
const readJSON = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };

const DEFAULTS = { userName: 'Darren', groqKey: '', model: 'openai/gpt-oss-120b', visionModel: 'meta-llama/llama-4-scout-17b-16e-instruct', projectPath: '', recentProjects: [], autoApprove: false, webSearch: true, imageToken: '', providers: {}, providerOrder: [], customInstructions: '', autoRun: 'ask', reviewer: true, savePoints: true, browserPath: '' };

function create(dataDir) {
  const dirs = { convos: path.join(dataDir, 'conversations'), images: path.join(dataDir, 'images') };
  const settingsFile = path.join(dataDir, 'settings.json');
  const memoryFile = path.join(dataDir, 'memory.md');

  const settings = {
    get() { return { ...DEFAULTS, ...readJSON(settingsFile, {}) }; },
    // What the browser is allowed to see: never the key itself
    public() { const s = this.get(); return { ...s, groqKey: undefined, imageToken: undefined, providers: undefined, hasImageToken: !!s.imageToken, hasKey: !!s.groqKey, keyHint: s.groqKey ? '…' + s.groqKey.slice(-4) : '' }; },
    update(patch) {
      const s = this.get();
      for (const k of Object.keys(DEFAULTS)) if (patch[k] !== undefined) s[k] = patch[k];
      if (typeof s.groqKey !== 'string' || s.groqKey.length > 300) throw Error('Invalid API key');
      s.imageToken = String(s.imageToken || '').trim().slice(0, 300);
      s.webSearch = s.webSearch !== false;
      if (!s.providers || typeof s.providers !== 'object' || Array.isArray(s.providers)) s.providers = {};
      s.providerOrder = (Array.isArray(s.providerOrder) ? s.providerOrder : []).filter(x => typeof x === 'string').slice(0, 10);
      s.groqKey = s.groqKey.trim();
      s.userName = String(s.userName || '').trim().slice(0, 40);
      s.customInstructions = String(s.customInstructions || '').slice(0, 4000);
      s.autoRun = s.autoRun === 'safe' ? 'safe' : 'ask';
      s.reviewer = s.reviewer !== false; s.savePoints = s.savePoints !== false;
      s.browserPath = String(s.browserPath || '').trim().slice(0, 500);
      if (s.browserPath && !/(msedge|chrome|chromium|brave)(\.exe)?$/i.test(s.browserPath)) throw Error('Browser path must point to Edge, Chrome, Chromium or Brave');
      s.recentProjects = (Array.isArray(s.recentProjects) ? s.recentProjects : []).filter(p => typeof p === 'string').slice(0, 8);
      write(settingsFile, JSON.stringify(s, null, 2));
      return this.public();
    }
  };

  const memory = {
    get() { try { return fs.readFileSync(memoryFile, 'utf8'); } catch { return ''; } },
    set(text) { if (typeof text !== 'string' || text.length > 20000) throw Error('Memory is limited to 20,000 characters'); write(memoryFile, text); return text; },
    add(line) {
      const clean = String(line || '').replace(/\s+/g, ' ').trim().slice(0, 400);
      if (!clean) throw Error('Nothing to remember');
      const cur = this.get();
      if (cur.toLowerCase().includes(clean.toLowerCase())) return { saved: false, note: 'Already in memory' };
      this.set((cur.trim() ? cur.trim() + '\n' : '') + '- ' + clean + '\n');
      return { saved: true, line: clean };
    }
  };

  const idOk = id => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id);
  const convoFile = id => { if (!idOk(id)) throw Error('Invalid conversation id'); return path.join(dirs.convos, id + '.json'); };

  const convos = {
    list() {
      let names = []; try { names = fs.readdirSync(dirs.convos).filter(n => /^[0-9a-f-]{36}\.json$/.test(n)); } catch {}
      return names.map(n => { const c = readJSON(path.join(dirs.convos, n), null); return c && { id: c.id, title: c.title, updated: c.updated, pinned: !!c.pinned }; })
        .filter(Boolean).sort((a, b) => (b.pinned - a.pinned) || b.updated.localeCompare(a.updated));
    },
    get(id) { const c = readJSON(convoFile(id), null); if (!c) throw Error('Conversation not found'); return c; },
    create() {
      const now = new Date().toISOString();
      const c = { id: crypto.randomUUID(), title: 'New chat', created: now, updated: now, messages: [] };
      write(convoFile(c.id), JSON.stringify(c)); return c;
    },
    save(c) { c.updated = new Date().toISOString(); write(convoFile(c.id), JSON.stringify(c)); return c; },
    rename(id, title) { const c = this.get(id); c.title = String(title || '').trim().slice(0, 80) || c.title; return this.save(c); },
    pin(id, pinned) { const c = this.get(id); c.pinned = !!pinned; return this.save(c); },
    remove(id) { try { fs.unlinkSync(convoFile(id)); } catch {} return { deleted: true }; },
    search(q) {
      q = String(q || '').toLowerCase().trim(); if (!q) return this.list();
      return this.list().filter(item => { if (item.title.toLowerCase().includes(q)) return true; try { return this.get(item.id).messages.some(m => String(m.content).toLowerCase().includes(q)); } catch { return false; } });
    }
  };

  const images = {
    save(dataUrl) {
      const m = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
      if (!m) throw Error('Unsupported image');
      const buf = Buffer.from(m[2], 'base64'); if (buf.length > 4 * 1024 * 1024) throw Error('Image over 4 MB');
      const id = crypto.randomUUID() + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
      fs.mkdirSync(dirs.images, { recursive: true }); fs.writeFileSync(path.join(dirs.images, id), buf);
      return id;
    },
    saveBuffer(buf, ext = 'jpg') {
      if (!['png', 'jpg', 'webp', 'gif'].includes(ext)) throw Error('Unsupported image type');
      const id = crypto.randomUUID() + '.' + ext;
      fs.mkdirSync(dirs.images, { recursive: true }); fs.writeFileSync(path.join(dirs.images, id), buf);
      return id;
    },
    file(id) { if (!/^[0-9a-f-]{36}\.(png|jpg|webp|gif)$/.test(id)) throw Error('Invalid image id'); return path.join(dirs.images, id); },
    dataUrl(id) {
      const f = this.file(id); const ext = path.extname(f).slice(1);
      return 'data:image/' + (ext === 'jpg' ? 'jpeg' : ext) + ';base64,' + fs.readFileSync(f).toString('base64');
    }
  };

  return { settings, memory, convos, images, dataDir };
}

module.exports = { create, DEFAULTS };

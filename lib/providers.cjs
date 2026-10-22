'use strict';
// The free-brain chain: several free AI providers, used in order. When one hits its free limit
// (or is down), Rutherford switches to the next one automatically and remembers to rest the
// tired one for a while. Also counts today's usage per provider for the usage meter.
const fs = require('node:fs');
const path = require('node:path');
const llm = require('./groq.cjs');

const PROVIDERS = {
  groq: { id: 'groq', name: 'Groq', base: 'https://api.groq.com/openai/v1', keyUrl: 'console.groq.com/keys', defaultModel: 'openai/gpt-oss-120b', vision: 'meta-llama/llama-4-scout-17b-16e-instruct', think: m => /gpt-oss|qwen3|deepseek-r1/i.test(m) ? { reasoning_effort: /gpt-oss/i.test(m) ? 'high' : 'default' } : {}, codePrefer: [/gpt-oss-120b/, /kimi-k2/, /qwen3/] },
  gemini: { id: 'gemini', name: 'Google Gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai', keyUrl: 'aistudio.google.com/apikey', defaultModel: 'gemini-2.5-flash', visionSelf: true, think: () => ({ reasoning_effort: 'high' }), prefer: [/gemini-\d(\.\d)?-flash$/, /gemini-\d(\.\d)?-flash(?!-lite)/, /flash/], codePrefer: [/gemini-\d(\.\d)?-pro$/, /gemini-\d(\.\d)?-pro(?!.*(tts|image|vision))/, /gemini-\d(\.\d)?-flash$/] },
  nvidia: { id: 'nvidia', name: 'NVIDIA (free)', base: 'https://integrate.api.nvidia.com/v1', keyUrl: 'build.nvidia.com', defaultModel: 'openai/gpt-oss-120b', think: m => /gpt-oss/i.test(m) ? { reasoning_effort: 'high' } : {}, prefer: [/gpt-oss-120b/, /deepseek-v\d/, /qwen.*coder/, /glm-\d/, /llama-3\.3-70b/, /gpt-oss/], codePrefer: [/qwen3-coder-480b/, /qwen.*coder/, /deepseek-v3\.\d/, /kimi-k2/, /gpt-oss-120b/] },
  openrouter: { id: 'openrouter', name: 'OpenRouter (free models)', base: 'https://openrouter.ai/api/v1', keyUrl: 'openrouter.ai/keys', defaultModel: 'openai/gpt-oss-120b:free', headers: { 'HTTP-Referer': 'http://localhost', 'X-Title': 'Rutherford' }, think: () => ({ reasoning: { effort: 'high' } }), freeOnly: true, prefer: [/gpt-oss-120b:free/, /qwen3-coder:free/, /deepseek.*:free/, /llama.*:free/, /:free$/], codePrefer: [/qwen3-coder:free/, /deepseek.*:free/, /gpt-oss-120b:free/, /:free$/] }
};
const ORDER = ['groq', 'gemini', 'nvidia', 'openrouter'];

function create({ dataDir, settings, fetchImpl, now = () => Date.now() }) {
  const usageFile = path.join(dataDir, 'usage.json');
  let usage = {}; try { usage = JSON.parse(fs.readFileSync(usageFile, 'utf8')); } catch {}
  const cooling = {}; // provider -> {until, reason}
  const modelCooling = {}; // 'provider|model' -> until (coding brains)
  const day = () => new Date(now()).toISOString().slice(0, 10);
  const saveUsage = () => { try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(usageFile, JSON.stringify(usage)); } catch {} };
  function track(id, u, ok = true) {
    const d = day(); if (usage.day !== d) usage = { day: d };
    const r = usage[id] ||= { requests: 0, tokens: 0, errors: 0 };
    if (ok) { r.requests++; r.tokens += Number(u?.total_tokens) || 0; } else r.errors++;
    r.last = now(); saveUsage();
  }

  // Keys/models live in settings: providers.{id}.{key,model,enabled}; Groq also keeps its old fields
  function config(id) {
    const s = settings.get(); const c = s.providers?.[id] || {};
    if (id === 'groq') return { key: c.key || s.groqKey, model: c.model || s.model || PROVIDERS.groq.defaultModel, codeModel: c.codeModel || '', vision: s.visionModel || PROVIDERS.groq.vision, enabled: c.enabled !== false };
    return { key: c.key || '', model: c.model || PROVIDERS[id].defaultModel, codeModel: c.codeModel || '', enabled: c.enabled !== false };
  }
  function order() { const s = settings.get(); return (Array.isArray(s.providerOrder) && s.providerOrder.length ? s.providerOrder : ORDER).filter(id => PROVIDERS[id]); }
  function available({ vision = false } = {}) {
    return order().map(id => ({ p: PROVIDERS[id], c: config(id) }))
      .filter(({ c }) => c.key && c.enabled)
      .filter(({ p, c }) => !vision || p.visionSelf || (p.id === 'groq' && c.vision))
      .map(({ p, c }) => ({ ...p, key: c.key, model: vision && p.id === 'groq' ? c.vision : c.model, codeModel: vision ? '' : c.codeModel, cooling: cooling[p.id] && cooling[p.id].until > now() ? cooling[p.id] : null }));
  }
  const anyKey = () => order().some(id => config(id).key && config(id).enabled);

  function shouldFallback(e) {
    if (e.code === 'aborted') return false;
    if (e.partial) return false; // already streamed text; switching would garble the answer
    return e.status === 429 || e.status === 401 || e.status === 403 || e.status === 402 || e.status === 404 || e.status >= 500 || e.code === 'network' || e.status === 400;
  }
  function rest(id, e) {
    const mins = e.status === 429 ? Math.max(1, Math.ceil((e.retryAfter || 60) / 60)) : e.status === 401 || e.status === 403 ? 60 * 24 : e.status === 402 || e.status === 404 ? 60 : 2;
    cooling[id] = { until: now() + mins * 60000, reason: e.message };
  }

  // Try each provider in order until one answers. onSwitch tells the UI which brain is answering.
  // task 'code' uses each provider's coding brain first (falls back to its normal brain if that's tired).
  // avoid: a provider id to try last (the reviewer uses a different brain than the writer).
  async function stream(req, { vision = false, think = false, task = 'chat', avoid = null, onSwitch = () => {} } = {}) {
    let list = available({ vision });
    if (!list.length) throw new llm.ProviderError(vision ? 'Photos need a Gemini key or a Groq key in Settings.' : 'Add at least one free AI key in Settings (Groq, Gemini, NVIDIA or OpenRouter).', { code: 'nokey' });
    // rested providers go last, but are still tried if nothing else works
    list = [...list.filter(x => !x.cooling), ...list.filter(x => x.cooling)];
    if (avoid && list.length > 1) list = [...list.filter(x => x.id !== avoid), ...list.filter(x => x.id === avoid)];
    // candidates: (provider, model) pairs
    const cands = [];
    for (const p of list) {
      const mk = `${p.id}|${p.codeModel}`;
      if (task === 'code' && p.codeModel && p.codeModel !== p.model && !(modelCooling[mk] > now())) cands.push({ p, model: p.codeModel, code: true });
      cands.push({ p, model: p.model, code: false });
    }
    let lastErr = null;
    for (const { p, model, code } of cands) {
      const extra = think && p.think ? p.think(model) : {};
      onSwitch({ id: p.id, name: p.name, model });
      const attempt = async ex => llm.stream({ ...req, key: p.key, model, provider: p, extra: ex, fetchImpl });
      try {
        let r;
        try { r = await attempt(extra); }
        catch (e) { if (e.status === 400 && Object.keys(extra).length && !e.partial) r = await attempt({}); else throw e; } // provider didn't like the "think harder" option
        track(p.id, r.usage); if (!code) delete cooling[p.id];
        return { ...r, provider: p.id, providerName: p.name, model };
      } catch (e) {
        track(p.id, null, false); lastErr = e;
        if (e.code === 'tool_use_failed' || !shouldFallback(e)) throw e;
        if (code) { modelCooling[`${p.id}|${model}`] = now() + (e.status === 429 ? Math.max(60, e.retryAfter || 600) * 1000 : 3600000); continue; } // only the coding brain rests
        rest(p.id, e);
      }
    }
    throw lastErr;
  }

  function status() {
    const d = day(); const u = usage.day === d ? usage : {};
    return order().map(id => { const c = config(id); return { id, name: PROVIDERS[id].name, keyUrl: PROVIDERS[id].keyUrl, hasKey: !!c.key, keyHint: c.key ? '…' + c.key.slice(-4) : '', enabled: c.enabled, model: c.model, codeModel: c.codeModel, today: u[id] || { requests: 0, tokens: 0, errors: 0 }, resting: cooling[id] && cooling[id].until > now() ? { until: cooling[id].until, reason: cooling[id].reason } : null }; });
  }

  async function models(id) {
    const c = config(id); if (!c.key) throw Error('Add a key for ' + PROVIDERS[id].name + ' first');
    let list = await llm.listModels(c.key, { fetchImpl, provider: PROVIDERS[id] });
    if (PROVIDERS[id].freeOnly) list = list.filter(m => m.free || /:free$/.test(m.id));
    list = list.filter(m => !/whisper|tts|guard|embed|imagen|veo|aqa|audio|image-generation|orpheus|playai/i.test(m.id));
    return list;
  }
  // Pick a good default when the saved model isn't available
  function pickModel(id, list) {
    const ids = list.map(m => m.id); const cur = config(id).model;
    if (ids.includes(cur)) return cur;
    for (const re of PROVIDERS[id].prefer || []) { const hit = ids.find(x => re.test(x)); if (hit) return hit; }
    return ids[0] || cur;
  }
  // Pick the best coding brain this key can use ('' = same as the normal brain)
  function pickCodeModel(id, list) {
    const ids = list.map(m => m.id); const cur = config(id).codeModel;
    if (cur && ids.includes(cur)) return cur;
    for (const re of PROVIDERS[id].codePrefer || []) { const hit = ids.find(x => re.test(x)); if (hit) return hit === config(id).model ? '' : hit; }
    return '';
  }

  return { stream, status, models, pickModel, pickCodeModel, config, anyKey, available, PROVIDERS, ORDER };
}

module.exports = { create, PROVIDERS, ORDER };

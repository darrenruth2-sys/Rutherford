'use strict';
// OpenAI-compatible streaming client with tool-call support.
// Works with Groq, Google Gemini, Cerebras, OpenRouter and anything else that speaks the same format.
const BASE = 'https://api.groq.com/openai/v1';
const GROQ = { id: 'groq', name: 'Groq', base: BASE, keyUrl: 'console.groq.com/keys' };

class ProviderError extends Error {
  constructor(message, { status, code, retryAfter, provider } = {}) { super(message); this.status = status; this.code = code; this.retryAfter = retryAfter; this.provider = provider; }
}

function friendly(status, body, headers, p = GROQ) {
  const raw = Array.isArray(body) ? body[0] : body; // Gemini sometimes wraps errors in an array
  const detail = raw?.error?.message ? ' — ' + String(raw.error.message).slice(0, 300) : '';
  const retryAfter = Number(headers?.get?.('retry-after')) || null;
  const o = { status, retryAfter, provider: p.id };
  if (status === 401 || status === 403) return new ProviderError(`${p.name} rejected your API key. Open Settings and paste a fresh key from ${p.keyUrl}.`, o);
  if (status === 429) return new ProviderError(`${p.name} free limit hit.` + (retryAfter ? ' Try again in ~' + Math.ceil(retryAfter) + 's.' : ' Wait a minute and try again.') + detail, o);
  if (status === 402) return new ProviderError(`${p.name} wants payment for that model. Pick a free model in Settings.` + detail, { ...o, status: 402 });
  if (status === 413) return new ProviderError('That was too much text for this model in one go. Try a shorter message, fewer attachments, or start a new chat.', o);
  if (status === 404) return new ProviderError(`Model not found on ${p.name}. Pick another model in Settings.` + detail, o);
  if (status >= 500) return new ProviderError(`${p.name} is having trouble right now (HTTP ${status}). Try again shortly.`, o);
  return new ProviderError(`${p.name} rejected the request (HTTP ${status})` + detail, { ...o, code: raw?.error?.code });
}

async function listModels(key, { fetchImpl = fetch, provider = GROQ } = {}) {
  const res = await fetchImpl(provider.base + '/models', { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(15000) });
  let body = null; try { body = await res.json(); } catch {}
  if (!res.ok) throw friendly(res.status, body, res.headers, provider);
  return (body?.data || []).filter(m => m.active !== false).map(m => ({ id: String(m.id).replace(/^models\//, ''), owner: m.owned_by, context: m.context_window || m.context_length, free: m.pricing ? Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0 : undefined })).sort((a, b) => a.id.localeCompare(b.id));
}

// Streams one completion. Calls onText(delta) as text arrives. Returns {content, toolCalls, finishReason, usage}.
async function stream({ key, model, messages, tools, maxTokens = 8192, signal, onText = () => {}, onThinking = () => {}, fetchImpl = fetch, provider = GROQ, extra = {} }) {
  const p = provider;
  const body = { model, messages, stream: true, max_tokens: maxTokens, ...extra };
  if (tools?.length) { body.tools = tools; body.tool_choice = 'auto'; }
  let res;
  try {
    res = await fetchImpl(p.base + '/chat/completions', {
      method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', ...(p.headers || {}) },
      body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000)
    });
  } catch (e) {
    if (signal?.aborted) throw new ProviderError('Stopped', { code: 'aborted' });
    throw new ProviderError(`Could not reach ${p.name}. Check your internet connection.`, { code: 'network', provider: p.id });
  }
  if (!res.ok) { let b = null; try { b = await res.json(); } catch {} throw friendly(res.status, b, res.headers, p); }

  let content = '', finishReason = null, usage = null, buf = '';
  const calls = [];
  const decoder = new TextDecoder();
  const handle = line => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let j; try { j = JSON.parse(data); } catch { return; }
    if (j.error) throw new ProviderError(`${p.name} error: ` + (j.error.message || 'unknown'), { code: j.error.code, provider: p.id, status: j.error.code === 429 || /rate/i.test(j.error.message || '') ? 429 : undefined });
    if (j.x_groq?.usage) usage = j.x_groq.usage;
    if (j.usage) usage = j.usage;
    const ch = j.choices?.[0]; if (!ch) return;
    const d = ch.delta || {};
    if (d.reasoning || d.reasoning_content) onThinking(d.reasoning || d.reasoning_content);
    if (d.content) { content += d.content; onText(d.content); }
    for (const tc of d.tool_calls || []) {
      // Some providers (e.g. Gemini) leave out "index"; match by id or start a new call
      let i = tc.index;
      if (i == null) { const byId = tc.id ? calls.findIndex(c => c?.id === tc.id) : -1; i = byId >= 0 ? byId : tc.id || !calls.length ? calls.length : calls.length - 1; }
      calls[i] ||= { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (tc.id) calls[i].id = tc.id;
      if (tc.function?.name) calls[i].function.name += tc.function.name;
      if (tc.function?.arguments) calls[i].function.arguments += typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments);
    }
    if (ch.finish_reason) finishReason = ch.finish_reason;
  };
  try {
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl; while ((nl = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, nl).trim()); buf = buf.slice(nl + 1); }
    }
    if (buf.trim()) handle(buf.trim());
  } catch (e) {
    if (e instanceof ProviderError) { e.partial = !!content; throw e; }
    if (signal?.aborted) throw new ProviderError('Stopped', { code: 'aborted' });
    const err = new ProviderError(`Connection to ${p.name} dropped mid-answer. Try again.`, { code: 'network', provider: p.id }); err.partial = !!content; throw err;
  }
  const toolCalls = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || 'call_' + i + '_' + Math.random().toString(36).slice(2, 6) }));
  return { content, toolCalls, finishReason, usage };
}

module.exports = { stream, listModels, ProviderError, BASE, GROQ, friendly };

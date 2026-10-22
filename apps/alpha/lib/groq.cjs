'use strict';
// Groq (OpenAI-compatible) streaming client with tool-call support.
const BASE = 'https://api.groq.com/openai/v1';

class ProviderError extends Error {
  constructor(message, { status, code, retryAfter } = {}) { super(message); this.status = status; this.code = code; this.retryAfter = retryAfter; }
}

function friendly(status, body, headers) {
  const detail = body?.error?.message ? ' — ' + String(body.error.message).slice(0, 300) : '';
  const retryAfter = Number(headers?.get?.('retry-after')) || null;
  if (status === 401 || status === 403) return new ProviderError('Groq rejected your API key. Open Settings and paste a fresh key from console.groq.com/keys.', { status });
  if (status === 429) return new ProviderError('Groq rate limit hit (free tier).' + (retryAfter ? ' Try again in ~' + Math.ceil(retryAfter) + 's.' : ' Wait a minute and try again.') + detail, { status, retryAfter });
  if (status === 413) return new ProviderError('That was too much text for this model in one go. Try a shorter message, fewer attachments, or start a new chat.', { status });
  if (status === 404) return new ProviderError('Model not found on Groq. Pick another model in Settings.' + detail, { status });
  if (status >= 500) return new ProviderError('Groq is having trouble right now (HTTP ' + status + '). Try again shortly.', { status });
  return new ProviderError('Groq rejected the request (HTTP ' + status + ')' + detail, { status, code: body?.error?.code });
}

async function listModels(key, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(BASE + '/models', { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(15000) });
  let body = null; try { body = await res.json(); } catch {}
  if (!res.ok) throw friendly(res.status, body, res.headers);
  return (body?.data || []).filter(m => m.active !== false).map(m => ({ id: m.id, owner: m.owned_by, context: m.context_window })).sort((a, b) => a.id.localeCompare(b.id));
}

// Streams one completion. Calls onText(delta) as text arrives. Returns {content, toolCalls, finishReason, usage}.
async function stream({ key, model, messages, tools, maxTokens = 8192, signal, onText = () => {}, onThinking = () => {}, fetchImpl = fetch }) {
  const body = { model, messages, stream: true, max_tokens: maxTokens };
  if (tools?.length) { body.tools = tools; body.tool_choice = 'auto'; }
  let res;
  try {
    res = await fetchImpl(BASE + '/chat/completions', {
      method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(180000)
    });
  } catch (e) {
    if (signal?.aborted) throw new ProviderError('Stopped', { code: 'aborted' });
    throw new ProviderError('Could not reach Groq. Check your internet connection.', { code: 'network' });
  }
  if (!res.ok) { let b = null; try { b = await res.json(); } catch {} throw friendly(res.status, b, res.headers); }

  let content = '', finishReason = null, usage = null, buf = '';
  const calls = [];
  const decoder = new TextDecoder();
  const handle = line => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let j; try { j = JSON.parse(data); } catch { return; }
    if (j.error) throw new ProviderError('Groq error: ' + (j.error.message || 'unknown'), { code: j.error.code });
    if (j.x_groq?.usage) usage = j.x_groq.usage;
    if (j.usage) usage = j.usage;
    const ch = j.choices?.[0]; if (!ch) return;
    const d = ch.delta || {};
    if (d.reasoning) onThinking(d.reasoning);
    if (d.content) { content += d.content; onText(d.content); }
    for (const tc of d.tool_calls || []) {
      const i = tc.index ?? calls.length;
      calls[i] ||= { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (tc.id) calls[i].id = tc.id;
      if (tc.function?.name) calls[i].function.name += tc.function.name;
      if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments;
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
    if (e instanceof ProviderError) throw e;
    if (signal?.aborted) throw new ProviderError('Stopped', { code: 'aborted' });
    throw new ProviderError('Connection to Groq dropped mid-answer. Try again.', { code: 'network' });
  }
  const toolCalls = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || 'call_' + i }));
  return { content, toolCalls, finishReason, usage };
}

module.exports = { stream, listModels, ProviderError, BASE };

'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = prefix => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// Fake Groq: each call to /chat/completions pops the next scripted turn.
// A turn is {text} or {tools:[{name,args}]} or {status, error}.
function fakeGroq(turns) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    if (url.endsWith('/audio/transcriptions')) { calls.push({ url, form: opts.body }); return new Response(JSON.stringify({ text: ' make me a snake game ' }), { status: 200 }); }
    const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
    calls.push({ url, body });
    if (body?.tools?.some(t => t.type === 'browser_search')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: '- Bitcoin trades near $70,000 today (https://www.coindesk.com/price/bitcoin)', executed_tools: [{ type: 'browser_search', search_results: { results: [{ title: 'Bitcoin price | CoinDesk', url: 'https://www.coindesk.com/price/bitcoin' }] } }] } }] }), { status: 200 });
    }
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'openai/gpt-oss-120b', active: true }, { id: 'meta-llama/llama-4-scout-17b-16e-instruct', active: true }] }), { status: 200 });
    // The second-opinion reviewer says LGTM unless a test scripts {review: '...'}
    const isReview = /strict senior code reviewer/.test(body?.messages?.[0]?.content || '');
    const isVision = Array.isArray(body?.messages?.[0]?.content) && /checking a screenshot/.test(body.messages[0].content[0]?.text || '');
    let turn;
    if (isReview) turn = turns[0]?.review !== undefined ? { text: turns.shift().review } : { text: 'LGTM' };
    else if (isVision && turns[0]?.vision === undefined) turn = { text: 'A page with an orange square and a Start button. Looks fine.' };
    else if (isVision) turn = { text: turns.shift().vision };
    else turn = turns.shift();
    if (!turn) throw Error('fake groq: no more scripted turns');
    if (turn.status) return new Response(JSON.stringify({ error: turn.error || { message: 'nope' } }), { status: turn.status, headers: turn.headers || {} });
    const events = [];
    if (turn.text) for (const piece of turn.text.match(/.{1,7}/gs)) events.push({ choices: [{ delta: { content: piece } }] });
    (turn.tools || []).forEach((t, i) => {
      const args = JSON.stringify(t.args);
      events.push({ choices: [{ delta: { tool_calls: [{ index: i, id: 'call_' + i + '_' + calls.length, type: 'function', function: { name: t.name, arguments: '' } }] } }] });
      events.push({ choices: [{ delta: { tool_calls: [{ index: i, function: { arguments: args.slice(0, 10) } }] } }] });
      events.push({ choices: [{ delta: { tool_calls: [{ index: i, function: { arguments: args.slice(10) } }] } }] });
    });
    events.push({ choices: [{ delta: {}, finish_reason: turn.tools ? 'tool_calls' : (turn.finish || 'stop') }] });
    const sse = events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join('') + 'data: [DONE]\n\n';
    // split mid-line to prove the parser buffers correctly
    const enc = new TextEncoder().encode(sse);
    const stream = new ReadableStream({ start(c) { for (let i = 0; i < enc.length; i += 37) c.enqueue(enc.slice(i, i + 37)); c.close(); } });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  return { fetchImpl, calls };
}

async function startApp(opts = {}) {
  const { createApp, listen } = require('../server.cjs');
  const server = createApp({ alphaTimers: false, ...opts });
  const port = await listen(server, 0);
  const base = 'http://127.0.0.1:' + port;
  const api = async (p, body) => {
    const r = await fetch(base + '/api/' + p, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json(); if (!r.ok) throw Object.assign(Error(j.error), { status: r.status }); return j;
  };
  const chat = async body => {
    const r = await fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const text = await r.text();
    return text.split('\n\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
  };
  // Like chat(), but calls onEvent as events arrive (to answer approval prompts mid-answer)
  const chatLive = async (body, onEvent) => {
    const r = await fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = ''; const events = [];
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf('\n\n')) >= 0) { const c = buf.slice(0, i); buf = buf.slice(i + 2); if (c.startsWith('data: ')) { const ev = JSON.parse(c.slice(6)); events.push(ev); await onEvent?.(ev); } }
    }
    return events;
  };
  return { server, base, api, chat, chatLive, close: () => new Promise(r => server.close(r)) };
}

module.exports = { tmp, fakeGroq, startApp };

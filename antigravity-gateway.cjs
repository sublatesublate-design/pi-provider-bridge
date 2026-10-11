'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_TEXT = 1024 * 1024;

class GatewayError extends Error {
  constructor(status) { super(status === 401 ? 'Unauthorized' : status === 413 ? 'Request too large' : status === 502 ? 'Upstream request failed' : 'Invalid request'); this.status = status; }
}
const bad = () => { throw new GatewayError(400); };
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function string(v, max = MAX_TEXT, nonempty = false) {
  if (typeof v !== 'string' || v.length > max || (nonempty && !v.length)) bad();
  return v;
}
function credentials(v) {
  if (!record(v) || Object.keys(v).some(k => !['token', 'projectId'].includes(k))) bad();
  const token = string(v.token, 16384, true);
  const projectId = string(v.projectId, 256, true);
  if (/\s|[\x00-\x1f\x7f]/.test(token) || !/^[a-zA-Z0-9._:-]+$/.test(projectId)) bad();
  return { token, projectId };
}
function checkSecret(secret) {
  if (!Buffer.isBuffer(secret) || secret.length < 32) throw new TypeError('secret must be a Buffer of at least 32 bytes');
}
function signCredential(secret, value) {
  checkSecret(secret);
  const payload = Buffer.from(JSON.stringify(credentials(value))).toString('base64url');
  return payload + '.' + crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}
// Accepts the signed value, without the HTTP "Bearer " prefix. All failures are generic.
function verifyCredential(secret, signed) {
  try {
    checkSecret(secret);
    if (typeof signed !== 'string' || signed.length > 24000) throw new Error();
    const parts = signed.split('.');
    if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) throw new Error();
    const mac = Buffer.from(parts[1], 'base64url');
    const expected = crypto.createHmac('sha256', secret).update(parts[0]).digest();
    if (mac.length !== expected.length || mac.toString('base64url') !== parts[1] || !crypto.timingSafeEqual(mac, expected)) throw new Error();
    const decoded = Buffer.from(parts[0], 'base64url');
    if (decoded.toString('base64url') !== parts[0]) throw new Error();
    return credentials(JSON.parse(decoded.toString('utf8')));
  } catch { throw new GatewayError(401); }
}

let sdkPromise;
function loadDefaultStream() {
  if (!sdkPromise) sdkPromise = (async () => {
    const { createJiti } = require('jiti');
    const sdk = path.join(__dirname, 'node_modules', 'desktop-provider-ai', 'dist');
    const jiti = createJiti(__filename, { fsCache: false, alias: {
      '@earendil-works/pi-ai/compat': path.join(sdk, 'compat.js'),
      '@earendil-works/pi-ai': path.join(sdk, 'index.js'),
    } });
    // Only the stream module: never invoke entry, account discovery, or stored auth helpers.
    const module = await jiti.import(path.join(__dirname, 'vendor', 'antigravity', 'stream', 'stream.ts'));
    if (typeof module.streamAntigravity !== 'function') throw new Error('Unavailable stream');
    return module.streamAntigravity;
  })().catch(error => { sdkPromise = undefined; throw error; });
  return sdkPromise;
}
function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
function content(value, images = false) {
  if (typeof value === 'string') return [{ type: 'text', text: string(value) }];
  if (!Array.isArray(value) || value.length > 256) bad();
  return value.map(part => {
    if (!record(part)) bad();
    if (part.type === 'text') return { type: 'text', text: string(part.text) };
    if (images && part.type === 'image_url' && record(part.image_url)) {
      const url = string(part.image_url.url, MAX_BODY_BYTES);
      const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
      if (!match || match[2].length % 4 !== 0 || Buffer.from(match[2], 'base64').toString('base64') !== match[2]) bad();
      return { type: 'image', mimeType: match[1], data: match[2] };
    }
    bad();
  });
}
function boundedJson(value, depth = 0, budget = { count: 0 }) {
  if (depth > 32 || ++budget.count > 20000) bad();
  if (typeof value === 'string') string(value);
  else if (Array.isArray(value)) { if (value.length > 4096) bad(); value.forEach(v => boundedJson(v, depth + 1, budget)); }
  else if (record(value)) { const keys = Object.keys(value); if (keys.length > 4096) bad(); keys.forEach(k => { string(k, 1024); boundedJson(value[k], depth + 1, budget); }); }
  else if (value !== null && typeof value !== 'boolean' && !(typeof value === 'number' && Number.isFinite(value))) bad();
}
function convertRequest(body, model) {
  if (!record(body) || !Array.isArray(body.messages) || !body.messages.length || body.messages.length > 512) bad();
  if (body.stream !== undefined && typeof body.stream !== 'boolean') bad();
  const context = { messages: [] };
  const systems = [], calls = new Map();
  for (const m of body.messages) {
    if (!record(m)) bad();
    const timestamp = Date.now();
    if (m.role === 'system' || m.role === 'developer') systems.push(content(m.content).map(p => p.text).join('\n'));
    else if (m.role === 'user') context.messages.push({ role: 'user', content: content(m.content, true), timestamp });
    else if (m.role === 'assistant') {
      const parts = m.content == null ? [] : content(m.content);
      if (m.tool_calls !== undefined) {
        if (!Array.isArray(m.tool_calls) || m.tool_calls.length > 128) bad();
        for (const call of m.tool_calls) {
          if (!record(call) || call.type !== 'function' || !record(call.function)) bad();
          const id = string(call.id, 256, true), name = string(call.function.name, 128, true);
          if (calls.has(id)) bad();
          let args;
          try { args = JSON.parse(string(call.function.arguments, 256 * 1024)); } catch { bad(); }
          if (!record(args)) bad();
          boundedJson(args);
          calls.set(id, name);
          parts.push({ type: 'toolCall', id, name, arguments: args });
        }
      }
      context.messages.push({ role: 'assistant', content: parts, api: model.api, provider: model.provider,
        model: model.id, timestamp, usage: emptyUsage(), stopReason: parts.some(p => p.type === 'toolCall') ? 'toolUse' : 'stop' });
    } else if (m.role === 'tool') {
      const id = string(m.tool_call_id, 256, true), name = calls.get(id);
      if (!name) bad();
      context.messages.push({ role: 'toolResult', toolCallId: id, toolName: name,
        content: content(m.content, true), isError: false, timestamp });
    } else bad();
  }
  if (systems.length) context.systemPrompt = systems.join('\n\n');
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.length > 128) bad();
    const names = new Set();
    context.tools = body.tools.map(tool => {
      if (!record(tool) || tool.type !== 'function' || !record(tool.function)) bad();
      const f = tool.function, name = string(f.name, 128, true);
      if (!/^[A-Za-z0-9_-]+$/.test(name) || names.has(name)) bad();
      names.add(name);
      const parameters = f.parameters === undefined ? { type: 'object', properties: {} } : f.parameters;
      if (!record(parameters)) bad();
      boundedJson(parameters);
      return { name, description: f.description === undefined ? '' : string(f.description, 65536), parameters };
    });
  }
  const options = {};
  const max = body.max_completion_tokens ?? body.max_tokens;
  if (max !== undefined) { if (!Number.isInteger(max) || max < 1 || max > 1048576) bad(); options.maxTokens = max; }
  if (body.temperature !== undefined) {
    if (typeof body.temperature !== 'number' || !Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2) bad();
    options.temperature = body.temperature;
  }
  if (body.reasoning_effort !== undefined) {
    if (!['none', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(body.reasoning_effort)) bad();
    options.reasoning = body.reasoning_effort === 'none' ? 'off' : body.reasoning_effort;
  }
  if (body.tool_choice !== undefined) {
    if (!['auto', 'none', 'required'].includes(body.tool_choice)) bad();
    if (body.tool_choice === 'required' && !context.tools?.length) bad();
    options.toolChoice = body.tool_choice;
  }
  return { context, options };
}
function usageOf(u = {}) {
  const n = key => Number.isFinite(u[key]) && u[key] >= 0 ? u[key] : 0;
  const prompt = n('input') + n('cacheRead') + n('cacheWrite'), output = n('output');
  return { prompt_tokens: prompt, completion_tokens: output, total_tokens: prompt + output,
    prompt_tokens_details: { cached_tokens: n('cacheRead'), cache_write_tokens: n('cacheWrite') },
    completion_tokens_details: { reasoning_tokens: n('reasoning') } };
}
const finishOf = m => m.stopReason === 'length' ? 'length' : m.stopReason === 'toolUse' || m.content.some(p => p.type === 'toolCall') ? 'tool_calls' : 'stop';
function messageOf(m) {
  const result = { role: 'assistant', content: m.content.filter(p => p.type === 'text').map(p => p.text).join('') || null };
  const thinking = m.content.filter(p => p.type === 'thinking').map(p => p.thinking).join('');
  if (thinking) result.reasoning_content = thinking;
  const calls = m.content.filter(p => p.type === 'toolCall');
  if (calls.length) result.tool_calls = calls.map(p => ({ id: p.id, type: 'function', function: { name: p.name, arguments: JSON.stringify(p.arguments) } }));
  return result;
}
function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(new GatewayError(502));
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new GatewayError(502)); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(v => { cleanup(); resolve(v); }, e => { cleanup(); reject(e); });
  });
}
async function write(res, data, signal) {
  if (signal.aborted || res.destroyed) throw new GatewayError(502);
  if (!res.write(data)) await new Promise((resolve, reject) => {
    const clean = () => { res.off('drain', drain); res.off('close', close); signal.removeEventListener('abort', close); };
    const drain = () => { clean(); resolve(); };
    const close = () => { clean(); reject(new GatewayError(502)); };
    res.once('drain', drain); res.once('close', close); signal.addEventListener('abort', close, { once: true });
    if (signal.aborted || res.destroyed) close();
  });
}
async function readBody(req, limit) {
  const declared = req.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new GatewayError(413);
  const data = await new Promise((resolve, reject) => {
    const chunks = []; let bytes = 0;
    const cleanup = () => { req.off('data', onData); req.off('end', onEnd); req.off('error', onError); req.off('aborted', onAbort); };
    const onError = () => { cleanup(); reject(new GatewayError(400)); };
    const onAbort = onError;
    const onData = chunk => {
      bytes += chunk.length;
      if (bytes > limit) { cleanup(); req.pause(); reject(new GatewayError(413)); }
      else chunks.push(chunk);
    };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    req.on('data', onData); req.once('end', onEnd); req.once('error', onError); req.once('aborted', onAbort);
  });
  try { return JSON.parse(data.toString('utf8')); } catch { throw new GatewayError(400); }
}
/**
 * A plugin reload unloads the previous gateway and starts the next one a moment
 * later, so the fixed loopback port can still be held when this gateway binds.
 * A busy port is retried briefly instead of failing the whole plugin load; any
 * other error, or a port that never frees, is reported as it is.
 */
async function bindWithRetry(server, port, host, { attempts = 12, delayMs = 250 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await new Promise((resolve, reject) => { const error = e => { server.off('listening', ready); reject(e); }; const ready = () => { server.off('error', error); resolve(); }; server.once('error', error); server.once('listening', ready); server.listen(port, host); });
      return;
    } catch (error) {
      if (error?.code !== 'EADDRINUSE' || attempt >= attempts) throw error;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

function createGateway({ secret, models, stream, signatureStore, maxBodyBytes = MAX_BODY_BYTES } = {}) {
  checkSecret(secret); secret = Buffer.from(secret);
  if (!Array.isArray(models) || !models.length || models.some(m => !record(m) || typeof m.id !== 'string' || !m.id || typeof m.api !== 'string' || typeof m.provider !== 'string')) throw new TypeError('Full model descriptors required');
  const catalog = new Map(models.map(m => [m.id, m]));
  if (catalog.size !== models.length) throw new TypeError('Duplicate model ids');
  if (stream !== undefined && typeof stream !== 'function') throw new TypeError('Invalid stream');
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > MAX_BODY_BYTES) throw new TypeError('Invalid body limit');
  const active = new Set(), sockets = new Set();
  let server, closing;
  async function handler(req, res) {
    const controller = new AbortController(), { signal } = controller;
    active.add(controller);
    const disconnect = () => controller.abort();
    req.once('aborted', disconnect); res.once('close', disconnect);
    try {
      if (req.headers.origin !== undefined) bad();
      if (!(req.method === 'GET' && req.url === '/v1/models') && !(req.method === 'POST' && req.url === '/v1/chat/completions')) bad();
      const auth = req.headers.authorization;
      if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) throw new GatewayError(401);
      const credential = verifyCredential(secret, auth.slice(7));
      if (req.method === 'GET') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ object: 'list', data: models.map(m => ({ id: m.id, object: 'model', created: 0, owned_by: m.provider })) }));
        return;
      }
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')) bad();
      const body = await readBody(req, maxBodyBytes);
      if (!record(body) || typeof body.model !== 'string' || !catalog.has(body.model)) bad();
      const model = catalog.get(body.model), { context, options } = convertRequest(body, model);
      const signatureScope = { projectId: credential.projectId, model: model.id };
      if (signatureStore) await abortable(signatureStore.restore(context, signatureScope), signal);
      const source = stream || await abortable(loadDefaultStream(), signal);
      const events = source(model, context, { ...options, apiKey: JSON.stringify(credential), signal });
      if (!events || typeof events.result !== 'function' || !events[Symbol.asyncIterator]) throw new GatewayError(502);
      const id = 'chatcmpl-' + crypto.randomUUID(), created = Math.floor(Date.now() / 1000);
      const base = { id, object: 'chat.completion.chunk', created, model: model.id };
      const chunk = (delta, finish_reason = null) => ({ ...base, choices: [{ index: 0, delta, finish_reason }] });
      const send = value => write(res, 'data: ' + JSON.stringify(value) + '\n\n', signal);
      const toolStates = new Map();
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
        await send(chunk({ role: 'assistant', content: '' }));
      }
      const iterator = events[Symbol.asyncIterator]();
      try {
        while (true) {
          const next = await abortable(iterator.next(), signal);
          if (next.done) break;
          const e = next.value;
          if (e.type === 'error') throw new GatewayError(502);
          if (body.stream && e.type === 'text_delta') await send(chunk({ content: e.delta }));
          else if (body.stream && e.type === 'thinking_delta') await send(chunk({ reasoning_content: e.delta }));
          else if (e.type.startsWith('toolcall_')) {
            let state = toolStates.get(e.contentIndex);
            const call = e.toolCall || e.partial?.content?.[e.contentIndex];
            if (!state) {
              if (!call || call.type !== 'toolCall') throw new GatewayError(502);
              // A short, unique ID survives Desktop's OpenAI serialization and
              // prevents upstream IDs reused across turns from colliding.
              const id = signatureStore ? 'call_' + crypto.randomUUID().replaceAll('-', '') : call.id;
              state = { index: toolStates.size, id, args: '' }; toolStates.set(e.contentIndex, state);
              if (body.stream) await send(chunk({ tool_calls: [{ index: state.index, id, type: 'function', function: { name: call.name, arguments: '' } }] }));
            }
            let delta = '';
            if (e.type === 'toolcall_delta') delta = e.delta;
            else if (e.type === 'toolcall_end' && !state.args) delta = JSON.stringify(call.arguments);
            if (delta) { state.args += delta; if (body.stream) await send(chunk({ tool_calls: [{ index: state.index, function: { arguments: delta } }] })); }
          }
        }
      } finally {
        if (signal.aborted && iterator.return) Promise.resolve(iterator.return()).catch(() => {});
      }
      const result = await abortable(events.result(), signal);
      if (!result || !Array.isArray(result.content) || !['stop', 'length', 'toolUse'].includes(result.stopReason)) throw new GatewayError(502);
      // Commit signatures before sending the finish marker: the next tool
      // round can start as soon as Desktop receives it. Never cache failed runs.
      const mappedResult = { ...result, content: result.content.map((part, index) => part.type === 'toolCall'
        ? { ...part, id: toolStates.get(index)?.id ?? part.id } : part) };
      if (signatureStore) await abortable(signatureStore.save(signatureScope, mappedResult.content), signal);
      const usage = usageOf(result.usage);
      if (body.stream) {
        await send(chunk({}, finishOf(result)));
        await send({ ...base, choices: [], usage });
        await write(res, 'data: [DONE]\n\n', signal); res.end();
      } else {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message: messageOf(mappedResult), finish_reason: finishOf(result) }], usage }));
      }
    } catch (error) {
      controller.abort();
      const status = error instanceof GatewayError ? error.status : 502;
      const payload = { error: { message: new GatewayError(status).message, type: status === 502 ? 'upstream_error' : 'invalid_request_error' } };
      if (!res.destroyed) {
        if (res.headersSent) res.end('data: ' + JSON.stringify(payload) + '\n\n');
        else { res.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' }); res.end(JSON.stringify(payload)); req.resume(); }
      }
    } finally { active.delete(controller); req.off('aborted', disconnect); res.off('close', disconnect); }
  }
  return {
    signCredential: value => signCredential(secret, value),
    async start(port = 51122, host = '127.0.0.1') {
      if (host !== '127.0.0.1' || !Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('Loopback host and valid port required');
      if (server || closing) throw new Error('Gateway already started');
      const candidate = http.createServer({ maxHeaderSize: 32768 }, handler);
      server = candidate;
      candidate.requestTimeout = 120000; candidate.headersTimeout = 15000;
      candidate.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
      try {
        await bindWithRetry(candidate, port, host);
        return candidate.address();
      } catch (error) {
        if (server === candidate) server = undefined;
        throw new Error(`Gateway could not bind requested loopback port ${port}: ${error?.code ?? error?.message ?? error}; the port may be held by another instance or reserved by Windows`);
      }
    },
    async close() {
      if (closing) return closing;
      const current = server; if (!current) return;
      closing = new Promise(resolve => {
        for (const controller of active) controller.abort();
        current.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      });
      try { await closing; } finally { server = undefined; closing = undefined; }
    },
  };
}
module.exports = { createGateway, signCredential, verifyCredential, convertRequest, loadDefaultStream, MAX_BODY_BYTES };

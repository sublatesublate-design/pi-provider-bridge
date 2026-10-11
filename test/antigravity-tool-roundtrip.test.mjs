import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';

const root = process.env.ANTIGRAVITY_TEST_ROOT || fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(join(root, 'antigravity-native.cjs'));
const { createGateway, convertRequest } = require(join(root, 'antigravity-gateway.cjs'));
const { loadSdk } = require(join(root, 'antigravity-native.cjs'));
const { createToolSignatureStore } = await import(pathToFileURL(join(root, 'tool-signatures.mjs')));
const sdk = await loadSdk();
const compat = await import(pathToFileURL(join(root, 'node_modules/desktop-provider-ai/dist/compat.js')));
const model = require(join(root, 'gemini-models.json')).find(m => m.id === 'gemini-3.8-flash');
const secret = Buffer.alloc(32, 73);
const signature = Buffer.alloc(192, 11).toString('base64');
const scope = { model: model.id, projectId: 'synthetic-project' };
const tool = { name: 'lookup', description: 'Synthetic lookup', parameters: { type: 'object', properties: { x: { type: 'number' } } } };
const call = { type: 'toolCall', id: 'call_synthetic', name: 'lookup', arguments: { x: 1 }, thoughtSignature: signature };
const contextFor = c => ({ messages: [{ role: 'assistant', content: [{ ...c }] }] });
const data = (parts, finishReason) => 'data: ' + JSON.stringify({ response: { candidates: [{ content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}) }] } });
async function parse(wire) {
  const output = { content: [], usage: {}, stopReason: 'pending' }, events = [];
  await sdk.streamResponse(new Response(wire), { push: e => events.push(e) }, output);
  return { output, events };
}
async function cacheDir(t) {
  const dir = await mkdtemp(join(process.env.PI_SCRATCH_DIR, 'signature-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'signatures.enc');
}

test('SSE normal STOP preserves text', async () => {
  const { output } = await parse(data([{ text: 'Synthetic answer' }], 'STOP') + '\r\n\r\n');
  assert.equal(output.stopReason, 'stop');
  assert.equal(output.content[0].text, 'Synthetic answer');
});
test('SSE final tool line without newline is parsed and signed', async () => {
  const { output } = await parse(data([{ text: 'Synthetic preamble' }]) + '\n\n' + data([{ functionCall: { name: 'lookup', args: { x: 1 } }, thoughtSignature: signature }], 'STOP'));
  assert.equal(output.stopReason, 'toolUse');
  assert.equal(output.content[1].thoughtSignature, signature);
  assert.equal(output.content[1].name, 'lookup');
});
test('SSE UTF-8 split across chunks and final line without newline', async () => {
  const bytes = new TextEncoder().encode(data([{ text: '合成响应' }], 'STOP'));
  const output = { content: [], usage: {}, stopReason: 'pending' };
  const body = new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i++) controller.enqueue(bytes.subarray(i, i + 1)); controller.close(); } });
  await sdk.streamResponse(new Response(body), { push() {} }, output);
  assert.equal(output.content[0].text, '合成响应');
});
test('SSE text without finish marker is an error, not normal completion', async () => {
  await assert.rejects(parse(data([{ text: 'Will run a tool' }]) + '\n\n'), /without finishReason/);
});
test('SSE malformed trailing JSON is an error', async () => {
  await assert.rejects(parse(data([{ text: 'Will run a tool' }]) + '\n\ndata: {"response":'), /invalid SSE JSON/);
});
test('MAX_TOKENS with a tool is length, never executable toolUse', async () => {
  const { output } = await parse(data([{ functionCall: { name: 'lookup', args: { x: 1 } }, thoughtSignature: signature }], 'MAX_TOKENS') + '\n\n');
  assert.equal(output.stopReason, 'length');
});
test('required/none/auto tool choice is forwarded; invalid choices are rejected', () => {
  for (const choice of ['required', 'none', 'auto']) {
    const { options } = convertRequest({ messages: [{ role: 'user', content: 'test' }], tools: [{ type: 'function', function: tool }], tool_choice: choice }, model);
    assert.equal(options.toolChoice, choice);
  }
  assert.throws(() => convertRequest({ messages: [{ role: 'user', content: 'test' }], tool_choice: 'required' }, model));
  assert.throws(() => convertRequest({ messages: [{ role: 'user', content: 'test' }], tool_choice: 'invalid' }, model));
});
test('cache persists encrypted signatures across restart without parameters or result text', async t => {
  const file = await cacheDir(t), store = createToolSignatureStore({ secret, file });
  await store.save(scope, [call]);
  const bytes = await readFile(file);
  assert.equal(bytes.includes(Buffer.from(signature)), false);
  assert.equal(bytes.includes(Buffer.from('lookup')), false);
  const replay = contextFor({ ...call, thoughtSignature: undefined });
  await createToolSignatureStore({ secret, file }).restore(replay, scope);
  assert.equal(replay.messages[0].content[0].thoughtSignature, signature);
});
test('cache does not attach signatures to changed model/project/id/name/arguments', async () => {
  const store = createToolSignatureStore({ secret });
  await store.save(scope, [call]);
  for (const [newScope, c] of [
    [{ ...scope, model: 'different' }, call], [{ ...scope, projectId: 'different' }, call],
    [scope, { ...call, id: 'other' }], [scope, { ...call, name: 'other' }], [scope, { ...call, arguments: { x: 2 } }],
  ]) {
    const replay = contextFor({ ...c, thoughtSignature: undefined });
    await store.restore(replay, newScope);
    assert.equal(replay.messages[0].content[0].thoughtSignature, undefined);
  }
});
test('cache canonicalizes argument order', async () => {
  const store = createToolSignatureStore({ secret });
  await store.save(scope, [{ ...call, arguments: { x: 1, z: 2 } }]);
  const replay = contextFor({ ...call, arguments: { z: 2, x: 1 }, thoughtSignature: undefined });
  await store.restore(replay, scope);
  assert.equal(replay.messages[0].content[0].thoughtSignature, signature);
});
test('cache concurrent instances merge and reject tampering/wrong keys', async t => {
  const file = await cacheDir(t);
  await Promise.all([createToolSignatureStore({ secret, file }).save(scope, [call]), createToolSignatureStore({ secret, file }).save(scope, [{ ...call, id: 'call_second' }])]);
  const store = createToolSignatureStore({ secret, file });
  for (const id of ['call_synthetic', 'call_second']) {
    const replay = contextFor({ ...call, id, thoughtSignature: undefined });
    await store.restore(replay, scope);
    assert.equal(replay.messages[0].content[0].thoughtSignature, signature);
  }
  await assert.rejects(createToolSignatureStore({ secret: Buffer.alloc(32, 99), file }).restore(contextFor(call), scope), /cache unavailable/);
  const bytes = await readFile(file); bytes[bytes.length - 1] ^= 1; await writeFile(file, bytes);
  await assert.rejects(store.restore(contextFor(call), scope), /cache unavailable/);
});
test('cache eviction is bounded and preserves newest signatures', async t => {
  const file = await cacheDir(t), store = createToolSignatureStore({ secret, file, maxEntries: 2 });
  for (const id of ['one', 'two', 'three']) await store.save(scope, [{ ...call, id }]);
  const old = contextFor({ ...call, id: 'one', thoughtSignature: undefined });
  await store.restore(old, scope); assert.equal(old.messages[0].content[0].thoughtSignature, undefined);
  const recent = contextFor({ ...call, id: 'three', thoughtSignature: undefined });
  await store.restore(recent, scope); assert.equal(recent.messages[0].content[0].thoughtSignature, signature);
});

for (const streaming of [true, false]) test(`real SDK/OpenAI roundtrip retains native tool history after gateway restart (stream=${streaming})`, async t => {
  const file = await cacheDir(t), upstream = [], previousFetch = globalThis.fetch;
  let requestIndex = 0, gateway;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('http://127.0.0.1:')) return previousFetch(url, init);
    assert.match(String(url), /\/v1internal:streamGenerateContent\?alt=sse$/);
    upstream.push(JSON.parse(init.body));
    requestIndex++;
    const parts = requestIndex === 1 ? [{ text: 'Synthetic preamble' }, { functionCall: { id: 'upstream_reused', name: 'lookup', args: { x: 1 } }, thoughtSignature: signature }, { functionCall: { id: 'upstream_reused', name: 'lookup', args: { x: 2 } } }]
      : [{ text: 'Synthetic completed' }];
    return new Response(data(parts, 'STOP'), { headers: { 'content-type': 'text/event-stream' } });
  };
  t.after(async () => { globalThis.fetch = previousFetch; await gateway?.close(); });
  async function start() {
    gateway = createGateway({ secret, models: [model], stream: sdk.streamAntigravity, signatureStore: createToolSignatureStore({ secret, file }) });
    const address = await gateway.start(0);
    return `http://127.0.0.1:${address.port}/v1`;
  }
  let baseUrl = await start();
  const token = () => gateway.signCredential({ token: 'synthetic-access', projectId: scope.projectId });
  const user = { role: 'user', content: 'Use synthetic lookup', timestamp: Date.now() };
  let first;
  if (streaming) {
    const clientModel = { ...model, provider: 'synthetic-gateway', api: 'openai-completions', baseUrl };
    const stream = compat.openAICompletionsApi().streamSimple(clientModel, { messages: [user], tools: [tool] }, { apiKey: token(), reasoning: 'high', signal: AbortSignal.timeout(15000) });
    for await (const event of stream) {}
    first = await stream.result();
    assert.equal(first.stopReason, 'toolUse');
  } else {
    const res = await previousFetch(baseUrl + '/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + token(), 'content-type': 'application/json' }, body: JSON.stringify({ model: model.id, messages: [{ role: 'user', content: 'test' }], tools: [{ type: 'function', function: tool }] }) });
    assert.equal(res.status, 200);
    const body = await res.json();
    first = { role: 'assistant', content: body.choices[0].message.tool_calls.map(c => ({ type: 'toolCall', id: c.id, name: c.function.name, arguments: JSON.parse(c.function.arguments) })), api: 'openai-completions', provider: 'synthetic-gateway', model: model.id, stopReason: 'toolUse', usage: {}, timestamp: Date.now() };
  }
  const calls = first.content.filter(p => p.type === 'toolCall');
  assert.equal(calls.length, 2);
  assert.equal(new Set(calls.map(c => c.id)).size, 2);
  for (const c of calls) {
    assert.match(c.id, /^call_[a-f0-9]{32}$/);
    assert.equal(c.thoughtSignature, undefined, 'Desktop need not persist a proprietary field');
  }
  await gateway.close(); baseUrl = await start();
  const results = calls.map(c => ({ role: 'toolResult', toolCallId: c.id, toolName: c.name, content: [{ type: 'text', text: 'Synthetic result' }], isError: false, timestamp: Date.now() }));
  const clientModel = { ...model, provider: 'synthetic-gateway', api: 'openai-completions', baseUrl };
  const stream = compat.openAICompletionsApi().streamSimple(clientModel, { messages: [user, first, ...results], tools: [tool] }, { apiKey: token(), reasoning: 'high', signal: AbortSignal.timeout(15000) });
  for await (const event of stream) {}
  const second = await stream.result();
  assert.equal(second.stopReason, 'stop');
  assert.equal(upstream.length, 2);
  const parts = upstream[1].request.contents.flatMap(c => c.parts);
  assert.equal(parts.find(p => p.functionCall)?.thoughtSignature, signature);
  assert.equal(parts.find(p => p.functionResponse)?.functionResponse.name, 'lookup');
  assert.equal(parts.filter(p => p.functionCall).length, 2);
  assert.equal(parts.filter(p => p.functionResponse).length, 2);
  assert.deepEqual(parts.filter(p => p.functionCall).map(p => p.functionCall.args.x), [1, 2]);
  assert.equal(parts.some(p => p.text?.startsWith('[Observation')), false);
  assert.notEqual(upstream[1].request.generationConfig.thinkingConfig?.thinkingBudget, 0);
});

test('legacy unsigned history does not disable thinking for Gemini 3', () => {
  const { context } = convertRequest({ messages: [
    { role: 'user', content: 'Historical synthetic task' },
    { role: 'assistant', content: null, tool_calls: [{ type: 'function', id: 'old', function: { name: 'lookup', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'old', content: 'Historical result' },
    { role: 'user', content: 'New task' },
  ] }, model);
  const body = sdk.buildRequest(model, context, scope.projectId, { reasoning: 'high' }, model.id);
  assert.notEqual(body.request.generationConfig.thinkingConfig?.thinkingBudget, 0);
});

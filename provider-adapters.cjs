'use strict';
// Install this helper in the provider plugin, NOT in the quota panel's process.
// The Host supplies only that provider's own refreshed OAuth credential.
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const pct = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
const reset = value => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
function parseGo(data) {
  const usage = object(object(data).usage);
  return { buckets: [['rolling', '5h'], ['weekly', 'weekly'], ['monthly', 'monthly']].flatMap(([key, id]) => {
    const item = object(usage[key]), used = pct(item.percent), resetsAt = reset(item.resetsAt);
    return used === undefined ? [] : [{ id, label: id, kind: 'window', usedPercent: used, remainingPercent: 100 - used, ...(resetsAt ? { resetsAt } : {}) }];
  }) };
}
/**
 * Levels the account reports per model family, most representative first. The
 * backend answers with one entry per thinking level (`gemini-3.8-flash-medium`,
 * `-high`, `-low`, `-tiered`) and no bare family id, so a declared family id is
 * matched by prefix instead of by exact lookup.
 */
const ANTIGRAVITY_LEVELS = ['medium', 'high', 'low', 'extra-low', 'tiered'];
function parseAntigravity(data, modelIds) {
  const models = object(object(data).models);
  const entries = Object.entries(models).map(([id, value]) => [id, object(value)]);
  const match = id => {
    const candidates = entries.filter(([entryId]) => entryId === id || entryId.startsWith(`${id}-`));
    if (!candidates.length) return undefined;
    const exact = candidates.find(([entryId]) => entryId === id);
    if (exact) return exact;
    for (const level of ANTIGRAVITY_LEVELS) {
      const preferred = candidates.find(([entryId]) => entryId.endsWith(`-${level}`));
      if (preferred) return preferred;
    }
    return candidates[0];
  };
  return { buckets: modelIds.slice(0, 64).flatMap(id => {
    const hit = match(id);
    const quota = object(object(hit?.[1]).quotaInfo);
    const fraction = quota.remainingFraction;
    const remaining = typeof fraction === 'number' && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1 ? fraction * 100 : undefined;
    const resetsAt = reset(quota.resetTime);
    // A family the account did not answer for is left out here: the Host adds it
    // back as a reading without a number, so nothing is invented at this layer.
    if (remaining === undefined) return [];
    // The label is the declared id: the Host replaces any provider-authored label
    // with the bucket id, and a model bucket must be a declared model id.
    return [{ id, label: id, kind: 'model', remainingPercent: remaining, ...(resetsAt ? { resetsAt } : {}) }];
  }) };
}
/**
 * One attempt can be aborted by the Host's own `pi.net.fetch` timeout, which
 * surfaces as a DOMException AbortError. That is a transport failure, not a
 * refusal, so it falls through to the next candidate instead of ending the read.
 * The per-attempt budget keeps one quota call inside the Host's 20 s allowance.
 */
const REQUEST_TIMEOUT_MS = 6_000;
async function hostRequest(input) {
  return pi.net.fetch({ ...input, timeoutMs: REQUEST_TIMEOUT_MS, redirect: 'error', maxResponseBytes: 256 * 1024 });
}
const isTransportFailure = error => error?.name === 'AbortError' || error?.name === 'TimeoutError' || error?.code === 20 || error?.code === 23 || error?.code === '20';
/**
 * The Host audits `error.code`, so a failure names its own class in the plugin
 * log instead of hiding behind a bare sentence. Upstream bodies are never copied.
 */
function quotaFailure(cause, fallback = 'QUOTA_NETWORK') {
  const code = isTransportFailure(cause) ? 'QUOTA_TIMEOUT' : typeof cause?.code === 'string' ? cause.code : fallback;
  const detail = cause === undefined ? 'no candidate answered' : typeof cause?.message === 'string' && cause.message ? cause.message : String(cause);
  return Object.assign(new Error(`Subscription quota unavailable: ${detail}`), { code, cause });
}
async function attemptRequest(input, signal, request) {
  signal.throwIfAborted();
  try { return { response: await requestJson(input, signal, request) }; }
  catch (error) { signal.throwIfAborted(); return { failure: error }; }
}
/** Transport result: `{data}`, `{retryAfterSeconds}`, `{status}` for a refusal, or `{unusable}`. */
async function requestJson(input, signal, request) {
  signal.throwIfAborted();
  const response = await request(input);
  signal.throwIfAborted();
  if (response.status === 429) {
    const raw = Object.entries(response.headers ?? {}).find(([key]) => key.toLowerCase() === 'retry-after')?.[1];
    const seconds = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : 60;
    return { retryAfterSeconds: Math.max(60, Math.min(3600, seconds)) };
  }
  if (response.status < 200 || response.status >= 300) return { status: response.status };
  if (typeof response.bodyText !== 'string' || Buffer.byteLength(response.bodyText) > 256 * 1024) return { status: response.status, unusable: true };
  try { return { status: response.status, data: JSON.parse(response.bodyText) }; }
  catch { return { status: response.status, unusable: true }; }
}
async function queryOpenCodeGo(credential, signal, request = hostRequest) {
  if (typeof credential?.accessToken !== 'string' || !credential.accessToken) throw new Error('Missing provider credential');
  const headers = { Accept: 'application/json', Authorization: `Bearer ${credential.accessToken}` };
  // Copy only the provider's already-owned organization selector, never a URL.
  for (const [key, value] of Object.entries(credential.headers ?? {})) {
    if (['x-opencode-org-id', 'x-org-id'].includes(key.toLowerCase()) && typeof value === 'string') headers[key] = value;
  }
  // Verified against the live account: the public `zen/go/v1` gateway answers 401
  // for a subscription token; the account route is `inference/go/v1`.
  const input = { url: 'https://opencode.ai/inference/go/v1/usage', method: 'GET', headers };
  let last;
  // The single route is tried twice: a stalled attempt is not an answer.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await attemptRequest(input, signal, request);
    if (result.failure) { last = result.failure; continue; }
    const response = result.response;
    if (response.retryAfterSeconds) return { buckets: [], retryAfterSeconds: response.retryAfterSeconds };
    if (response.data) return parseGo(response.data);
    throw quotaFailure(new Error(`Subscription quota refused with HTTP ${response.status}`), 'QUOTA_REFUSED');
  }
  throw quotaFailure(last);
}
/**
 * The vendor CLI's own wire fingerprint. Verified against the live backend: the
 * same request without it is throttled with HTTP 429 on every endpoint.
 */
const ANTIGRAVITY_USER_AGENT = 'antigravity/cli/1.1.23 (aidev_client; os_type=linux; arch=amd64; cl=974125021; auth_method=consumer)';
/** Same endpoint order the vendor's own client uses, so a daily-only account still answers. */
const ANTIGRAVITY_ENDPOINTS = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  'https://cloudcode-pa.googleapis.com',
];
async function queryAntigravity(credential, signal, { unwrap, modelIds, request = hostRequest, endpoints = ANTIGRAVITY_ENDPOINTS }) {
  // unwrap MUST be the declaring provider's existing verified credential decoder.
  // For the migration gateway: verifyCredential(itsSecret, credential.accessToken).
  const { token, projectId } = await unwrap(credential);
  if (typeof token !== 'string' || !token || typeof projectId !== 'string' || !projectId) throw new Error('Missing Google provider credential');
  let last;
  for (const endpoint of endpoints) {
    const result = await attemptRequest({
      url: `${endpoint}/v1internal:fetchAvailableModels`, method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': ANTIGRAVITY_USER_AGENT },
      body: JSON.stringify({ project: projectId }),
    }, signal, request);
    // A stalled candidate moves on to the next host; only an answer ends the walk.
    if (result.failure) { last = result.failure; continue; }
    const response = result.response;
    if (response.retryAfterSeconds) return { buckets: [], retryAfterSeconds: response.retryAfterSeconds };
    if (response.data) return parseAntigravity(response.data, modelIds);
    last = new Error(`Subscription quota refused with HTTP ${response.status}`);
  }
  throw quotaFailure(last, 'QUOTA_REFUSED');
}
module.exports = { parseGo, parseAntigravity, queryOpenCodeGo, queryAntigravity };

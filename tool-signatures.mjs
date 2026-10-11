import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { atomicWrite, withFileLock } from './store.mjs';

const validSignature = s => typeof s === 'string' && s.length > 0 && s.length <= 262144 && s.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(s);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
const binding = (scope, call) => createHash('sha256').update(JSON.stringify(canonical({
  projectId: scope.projectId, model: scope.model, id: call.id, name: call.name, arguments: call.arguments,
}))).digest('hex');

// Desktop preserves tool IDs, not Gemini thought signatures. Only opaque hashes
// and signatures are stored; prompts, arguments, results and OAuth tokens are not.
export function createToolSignatureStore({ secret, file, maxEntries = 2048, maxBytes = 8 * 1024 * 1024 } = {}) {
  if (!Buffer.isBuffer(secret) || secret.length !== 32) throw new TypeError('32-byte signature cache key required');
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1024) throw new TypeError('Invalid signature cache limits');
  const key = Buffer.from(secret);
  let memory = new Map(), tail = Promise.resolve();
  async function read() {
    if (!file) return new Map(memory);
    try {
      if ((await stat(file)).size > maxBytes) throw new Error();
      const bytes = await readFile(file);
      if (bytes.length < 32 || bytes.subarray(0, 4).toString() !== 'AGS1') throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(4, 16));
      decipher.setAuthTag(bytes.subarray(16, 32));
      const data = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(32)), decipher.final()]).toString('utf8'));
      if (data.version !== 1 || !Array.isArray(data.entries) || data.entries.length > maxEntries) throw new Error();
      for (const entry of data.entries) {
        if (!Array.isArray(entry) || entry.length !== 2 || !/^[a-f0-9]{64}$/.test(entry[0]) ||
            !validSignature(entry[1]?.signature) || !Number.isFinite(entry[1]?.at)) throw new Error();
      }
      return new Map(data.entries);
    } catch (error) {
      if (error.code === 'ENOENT') return new Map();
      throw new Error('Tool signature cache unavailable');
    }
  }
  async function save(scope, calls) {
    const signed = calls.filter(call => call.type === 'toolCall' && call.thoughtSignature);
    if (!signed.length) return;
    if (signed.some(call => !validSignature(call.thoughtSignature))) throw new Error('Invalid upstream tool signature');
    const mutate = async () => {
      const entries = await read();
      for (const call of signed) {
        const hash = binding(scope, call);
        entries.delete(hash);
        entries.set(hash, { signature: call.thoughtSignature, at: Date.now() });
      }
      let payload;
      for (;;) {
        payload = Buffer.from(JSON.stringify({ version: 1, entries: [...entries] }));
        if (entries.size <= maxEntries && payload.length + 32 <= maxBytes) break;
        entries.delete(entries.keys().next().value);
      }
      if (signed.some(call => !entries.has(binding(scope, call)))) throw new Error('Tool signature cache capacity exceeded');
      if (file) {
        const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
        const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
        await atomicWrite(file, Buffer.concat([Buffer.from('AGS1'), iv, cipher.getAuthTag(), encrypted]));
      }
      memory = entries;
    };
    const job = tail.then(() => file ? withFileLock(file, mutate) : mutate());
    tail = job.catch(() => {});
    return job;
  }
  return {
    save,
    async restore(context, scope) {
      const entries = await read();
      for (const message of context.messages) {
        if (message.role !== 'assistant') continue;
        for (const call of message.content) {
          if (call.type !== 'toolCall') continue;
          const entry = entries.get(binding(scope, call));
          if (entry) call.thoughtSignature = entry.signature;
        }
      }
    },
  };
}

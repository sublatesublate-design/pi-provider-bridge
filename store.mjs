import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, unlink, open, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

export const dataDir = join(homedir(), '.pi-desktop', 'plugins', 'data', 'local.pi-provider-bridge');
// Only fixed code is in argv. Credential bytes travel through stdin/stdout, never a file.
export function dpapi(input, decrypt = false) {
  if (process.platform !== 'win32') return Promise.reject(new Error('Windows DPAPI is required'));
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($s); $r=[Security.Cryptography.ProtectedData]::${decrypt ? 'Unprotect' : 'Protect'}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
  return new Promise((resolve, reject) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = []; let size = 0;
    p.stdout.on('data', b => { size += b.length; if (size > 16 * 1024 * 1024) p.kill(); else output.push(b); });
    p.stderr.resume(); // Never propagate subprocess diagnostics containing input.
    p.on('error', () => reject(new Error('DPAPI unavailable')));
    p.stdin.on('error', () => {});
    p.on('close', code => code === 0 ? resolve(Buffer.from(Buffer.concat(output).toString().trim(), 'base64')) : reject(new Error('DPAPI operation failed')));
    p.stdin.end(Buffer.from(input).toString('base64'));
  });
}
export async function atomicWrite(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, bytes, { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  } finally { await unlink(temp).catch(() => {}); }
}
// Each Desktop session can own a separate store instance/process. Serialize the
// entire read-modify-write (including OAuth rotation) across those instances.
/**
 * Whether a lock file was left behind by a process that is gone.
 *
 * The lock records its owner, so a crashed plugin, a killed process or an
 * interrupted load must not block every later session: a lock whose pid no
 * longer exists is reclaimed instead of waited on. A lock that cannot be read
 * yet is only reclaimed once it is clearly old, because the owner writes its pid
 * a moment after creating the file.
 */
async function lockIsStale(lockPath) {
  const stats = await stat(lockPath).catch(() => undefined);
  if (!stats) return true;
  const ageMs = Date.now() - stats.mtimeMs;
  let owner;
  try { owner = JSON.parse(await readFile(lockPath, 'utf8')); } catch { owner = undefined; }
  const pid = Number(owner?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return ageMs > 60_000;
  let alive = true;
  try { process.kill(pid, 0); } catch (error) { alive = error?.code === 'EPERM'; }
  return !alive || ageMs > 10 * 60_000;
}

export async function withFileLock(path, fn, timeoutMs = 120_000) {
  await mkdir(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + timeoutMs;
  let handle;
  while (!handle) {
    try { handle = await open(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw new Error('Store lock unavailable');
      // A lock whose owner is gone is reclaimed here rather than waited on: the
      // plugin load has its own deadline, and a dead lock would outlive it.
      if (await lockIsStale(lockPath)) { await unlink(lockPath).catch(() => {}); continue; }
      if (Date.now() >= deadline) throw new Error('Store lock timed out');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    return await fn();
  } finally {
    await handle.close();
    await unlink(lockPath).catch(() => {});
  }
}
export class CredentialStore {
  constructor(path = join(dataDir, 'credentials.dpapi'), crypt = dpapi) {
    this.path = path; this.crypt = crypt; this.tail = Promise.resolve();
  }
  async read() {
    let bytes;
    try { bytes = await readFile(this.path); } catch (e) { if (e.code === 'ENOENT') return { credentials: {}, imported: [] }; throw new Error('Credential store unreadable'); }
    try {
      const value = JSON.parse((await this.crypt(bytes, true)).toString('utf8'));
      if (!value.credentials || !Array.isArray(value.imported)) throw new Error();
      return value;
    } catch { throw new Error('Credential store cannot be decrypted'); }
  }
  mutate(fn) {
    const job = this.tail.then(() => withFileLock(this.path, async () => {
      const value = await this.read();
      const result = await fn(value);
      const encrypted = await this.crypt(Buffer.from(JSON.stringify(value)), false);
      await atomicWrite(this.path, encrypted);
      return result;
    }));
    this.tail = job.catch(() => {});
    return job;
  }
}
export class CatalogStore {
  constructor(path = join(dataDir, 'catalog.json')) { this.path = path; this.tail = Promise.resolve(); }
  async read() {
    try { return JSON.parse(await readFile(this.path, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return {}; throw new Error('Catalog cache unreadable'); }
  }
  set(id, entry) {
    const job = this.tail.then(() => withFileLock(this.path, async () => { const all = await this.read(); all[id] = entry; await atomicWrite(this.path, JSON.stringify(all)); }));
    this.tail = job.catch(() => {}); return job;
  }
}

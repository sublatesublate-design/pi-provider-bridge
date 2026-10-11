export const supportedId = id => /^(antigravity(?:-[2-8])?|opencode-console|opencode-go-console)$/.test(id);
export const isAntigravity = id => id.startsWith('antigravity');
export function restoreModel(models, id) {
  const model = models.find(m => m.id === id);
  if (!model) throw new Error('Cached model unavailable; refresh catalog');
  return structuredClone(model);
}
export function abortCheck(signal) { signal?.throwIfAborted(); }
// Catalogs must contain metadata only. Do not persist upstream authentication headers.
export function publicCatalog(value, credentials) {
  const secrets = Object.values(credentials).flatMap(c => [c.access, c.refresh, c.key]).filter(v => typeof v === 'string' && v.length > 4);
  const walk = (v, key = '') => {
    if (/^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|apiKey|accessToken|refreshToken|access|refresh|token|key)$/i.test(key)) return undefined;
    if (typeof v === 'string' && secrets.some(s => v.includes(s))) throw new Error('Secret found in catalog metadata');
    if (Array.isArray(v)) return v.map(x => walk(x));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]).filter(([, x]) => x !== undefined));
    return v;
  };
  return walk(value);
}
export class ProviderBridge {
  constructor({ pi, store, catalogs, adapters, readImport }) {
    Object.assign(this, { pi, store, catalogs, adapters, readImport });
    this.registered = new Map(); this.flights = new Map(); this.refreshFlight = undefined; this.active = undefined;
  }
  adapter(id) { if (!supportedId(id)) throw new Error('Unsupported provider id'); return this.adapters[isAntigravity(id) ? 'antigravity' : 'opencode']; }
  async offline() {
    const { credentials } = await this.store.read(); const cache = await this.catalogs.read();
    for (const [id, entry] of Object.entries(cache)) {
      if (!supportedId(id) || !credentials[id] || !entry.models?.length) continue;
      await this.adapter(id).hydrate?.(id, entry);
      this.register(id, entry.models);
    }
  }
  register(id, models) {
    if (!models.length) return;
    const snapshot = structuredClone(models);
    const fingerprint = JSON.stringify(snapshot);
    if (this.registered.get(id) === fingerprint) return;
    if (this.registered.has(id)) this.pi.unregisterProvider(id);
    this.pi.registerProvider(id, {
      name: `Desktop ${id}`, models: snapshot,
      streamSimple: (model, context, options) => this.adapter(id).stream(
        restoreModel(snapshot, model.id), context, options,
        force => this.credential(id, !!force, options?.signal),
      ),
    });
    this.registered.set(id, fingerprint);
  }
  credential(id, force = false, signal) {
    this.adapter(id);
    if (this.flights.has(id)) return this.flights.get(id);
    const job = this.store.mutate(async state => {
      abortCheck(signal);
      const old = state.credentials[id];
      if (!old) throw new Error('Provider needs authentication');
      if (old.type === 'api_key') return structuredClone(old);
      if (!force && old.expires > Date.now() + 60_000) return structuredClone(old);
      const rotated = { ...old, ...await this.adapter(id).refresh(old, signal) };
      // Save rotation even if cancellation raced the completed token response.
      state.credentials[id] = rotated;
      // Console and Go can share a rotating refresh token. Preserve each org/env.
      if (!isAntigravity(id)) for (const [otherId, c] of Object.entries(state.credentials)) {
        if (otherId !== id && !isAntigravity(otherId) && c.type === 'oauth' && c.refresh === old.refresh) {
          state.credentials[otherId] = { ...c, access: rotated.access, refresh: rotated.refresh, expires: rotated.expires };
        }
      }
      return structuredClone(rotated);
    }).finally(() => this.flights.delete(id));
    this.flights.set(id, job); return job;
  }
  refresh(signal) {
    if (this.refreshFlight) return this.refreshFlight;
    this.refreshFlight = (async () => {
      const state = await this.store.read();
      const failures = [];
      for (const id of Object.keys(state.credentials).filter(supportedId)) {
        abortCheck(signal);
        try {
          const credential = await this.credential(id, false, signal);
          abortCheck(signal);
          const stored = (await this.catalogs.read())[id];
          const entry = await this.adapter(id).discover(id, credential, stored, signal);
          abortCheck(signal);
          if (!entry?.models?.length) continue; // No synthetic fallback models.
          const safe = publicCatalog(entry, (await this.store.read()).credentials);
          await this.catalogs.set(id, safe);
          this.register(id, safe.models);
        } catch (e) { abortCheck(signal); failures.push(id); }
      }
      return failures;
    })().finally(() => { this.refreshFlight = undefined; });
    return this.refreshFlight;
  }
  async importCredentials(ctx, signal) {
    if (!ctx.hasUI || !await ctx.ui.confirm('Import TUI credentials?', 'Read matching entries from ~/.pi/agent/auth.json once into the independent Windows-encrypted Desktop store? The source will not be changed.')) return 0;
    abortCheck(signal);
    const source = await this.readImport();
    return this.store.mutate(state => {
      abortCheck(signal); let count = 0;
      for (const [id, credential] of Object.entries(source)) {
        if (!supportedId(id) || state.imported.includes(id) || state.credentials[id]) continue;
        if (!(credential?.type === 'oauth' && typeof credential.access === 'string' && typeof credential.refresh === 'string') && !(credential?.type === 'api_key' && typeof credential.key === 'string')) continue;
        state.credentials[id] = structuredClone(credential); state.imported.push(id); count++;
      }
      return count;
    });
  }
  async status() {
    const state = await this.store.read(); const cache = await this.catalogs.read();
    return [...new Set(['antigravity', 'opencode-console', 'opencode-go-console', ...Object.keys(state.credentials).filter(supportedId)])].map(id =>
      `${id}: ${state.credentials[id] ? 'authenticated' : 'pending authentication'}; ${cache[id]?.models?.length ?? 0} cached models${this.registered.has(id) ? '; registered' : ''}`,
    ).join('\n');
  }
  async useModel(id, modelId, ctx, signal) {
    this.adapter(id);
    await this.offline();
    abortCheck(signal);
    const registry = ctx.modelRegistry;
    const models = (registry?.getAvailable?.() ?? []).filter(model => registry.getProviderDisplayName?.(model.provider) === `Desktop ${id}`);
    if (!models.length) { ctx.ui.notify('No session models available. Run refresh in this conversation first.', 'warning'); return; }
    if (!modelId) modelId = await ctx.ui.select(`Select ${id} model`, models.map(model => model.id));
    abortCheck(signal);
    if (!modelId) return;
    const selected = models.find(model => model.id === modelId);
    if (!selected) { ctx.ui.notify('Model is not available for this provider in this conversation.', 'warning'); return; }
    const switched = await this.pi.setModel(selected);
    ctx.ui.notify(switched ? `Selected ${id} / ${selected.id}. Send a message to test it.` : 'Desktop refused model switching. Wait until this conversation is idle and retry.', switched ? 'info' : 'warning');
  }
  async command(args, ctx) {
    const [action = 'status', id, modelId] = args.trim().split(/\s+/);
    if (action === 'cancel') { this.active?.abort(); return; }
    if (this.active) { ctx.ui.notify('Provider operation already running; use /desktop-providers cancel', 'warning'); return; }
    const controller = new AbortController(); this.active = controller;
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
    try {
      if (action === 'status') ctx.ui.notify(await this.status(), 'info');
      else if (action === 'use') await this.useModel(id, modelId, ctx, signal);
      else if (action === 'refresh') {
        const failed = await this.refresh(signal);
        ctx.ui.notify(failed.length ? `Refresh failed for: ${failed.join(', ')}. Cached models retained.` : 'Provider catalogs refreshed (authenticated providers only).', failed.length ? 'warning' : 'info');
      } else if (action === 'import') {
        const count = await this.importCredentials(ctx, signal); await this.offline();
        ctx.ui.notify(`Imported ${count} credentials. Use refresh to discover models.`, 'info');
      } else if (action === 'login') {
        const adapter = this.adapter(id);
        if (!ctx.hasUI) throw new Error('UI required');
        const credential = await adapter.login(id, ctx, signal);
        abortCheck(signal);
        await this.store.mutate(state => { abortCheck(signal); state.credentials[id] = credential; });
        await this.catalogs.set(id, { models: [] }); // A new account must not inherit old entitlements.
        if (this.registered.has(id)) { this.pi.unregisterProvider(id); this.registered.delete(id); }
        ctx.ui.notify('Credential saved. Use refresh to discover models.', 'info');
      } else if (action === 'logout') {
        this.adapter(id);
        await this.store.mutate(state => { abortCheck(signal); delete state.credentials[id]; });
        if (this.registered.has(id)) { this.pi.unregisterProvider(id); this.registered.delete(id); }
        ctx.ui.notify('Desktop credential removed; TUI is unchanged.', 'info');
      } else ctx.ui.notify('Usage: /desktop-providers status|refresh|use <id> [model]|login <id>|logout <id>|import|cancel', 'info');
    } catch { ctx.ui.notify(signal.aborted ? 'Provider operation cancelled.' : 'Provider operation failed. No credentials are shown; check authentication or the isolated cache.', 'warning'); }
    finally { if (this.active === controller) this.active = undefined; }
  }
}

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { ProviderBridge, abortCheck, publicCatalog } from './bridge.mjs';
import { CredentialStore, CatalogStore } from './store.mjs';
import { loginAntigravity, refreshAntigravityToken, getApiKey } from './vendor/antigravity/auth/oauth.ts';
import { streamAntigravity } from './vendor/antigravity/stream/stream.ts';
import { hydrateAntigravityCatalog, refreshSlotCatalog } from './vendor/antigravity/models/discovery.ts';
import { fetchLiveModelsRaw } from './vendor/antigravity/usage/usage.ts';
import { requestDeviceCode, completeDeviceSignIn, refreshSession, sessionFromEntry, envForSession } from './vendor/opencode/auth.ts';
import { loadConsoleConfig, loadPublicModels, buildPiModels, toProviderModelConfigs } from './vendor/opencode/models.ts';
import { streamConsoleWithSession } from './vendor/opencode/stream.ts';

function cancelled(): never { throw new DOMException('Cancelled', 'AbortError'); }
function sessionEntry(session: any, old: any = {}) {
  return { ...old, type: 'oauth', access: session.accessToken, refresh: session.refreshToken, expires: session.expiresAt, env: { ...old.env, ...envForSession(session) } };
}
// No shell commands or environment expansion from imported service-key values.
function serviceKey(entry: any): string {
  if (!entry.key || /^[!$]/.test(entry.key)) throw new Error('Literal service key required');
  return entry.key;
}
function deferredStream(model: any, signal: AbortSignal | undefined, run: () => Promise<any>) {
  const output = createAssistantMessageEventStream();
  void (async () => {
    try {
      abortCheck(signal); const source = await run();
      for await (const event of source) {
        if (event.type === 'error') output.push({ ...event, error: { ...event.error, errorMessage: 'Desktop provider request failed; check authentication' } });
        else output.push(event);
      }
      const result = await source.result();
      output.end(result.errorMessage ? { ...result, errorMessage: 'Desktop provider request failed; check authentication' } : result);
    } catch {
      const message: any = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: signal?.aborted ? 'aborted' : 'error', errorMessage: signal?.aborted ? 'Provider request cancelled' : 'Desktop provider request failed; check authentication', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      output.push({ type: 'error', reason: message.stopReason, error: message }); output.end(message);
    }
  })();
  return output;
}

export function createAdapters(store: any, catalogs: any) {
  return {
    antigravity: {
      hydrate: (id: string, stored: any) => hydrateAntigravityCatalog(id, stored),
      refresh: (entry: any, signal: AbortSignal) => refreshAntigravityToken(entry, signal),
      login: async (_id: string, ctx: any, signal: AbortSignal) => {
        const local = new AbortController(); const combined = AbortSignal.any([signal, local.signal]);
        const result = await loginAntigravity({
          signal: combined,
          onAuth: ({ url, instructions }: any) => ctx.ui.notify(`${instructions}\n${url}`, 'info'),
          onPrompt: async ({ message, placeholder }: any) => {
            try { const text = await ctx.ui.input(message, placeholder); if (!text) { local.abort(); cancelled(); } return text; }
            catch { local.abort(); cancelled(); }
          },
          onProgress: () => {}, // Do not forward arbitrary upstream diagnostics.
        });
        abortCheck(combined); return { ...result, type: 'oauth' };
      },
      discover: async (id: string, credential: any, stored: any, signal: AbortSignal) => {
        let published: any;
        await refreshSlotCatalog(id, {
          stored, credential, allowNetwork: true, force: true, signal,
          publish: async ({ persist, update }: any) => {
            abortCheck(signal);
            const safe = publicCatalog(persist, (await store.read()).credentials);
            await catalogs.set(id, safe); // Commit routing/enums/full models before activating them.
            update(); published = safe; return true;
          },
        }, fetchLiveModelsRaw);
        return published ?? stored; // Never register the vendor's static fallback without discovery.
      },
      stream: (model: any, context: any, options: any, loader: any) => deferredStream(model, options?.signal, async () => {
        const credential = await loader(false); abortCheck(options?.signal);
        return streamAntigravity(model, context, { ...options, apiKey: credential.type === 'api_key' ? serviceKey(credential) : getApiKey(credential) });
      }),
    },
    opencode: {
      refresh: async (entry: any, signal: AbortSignal) => sessionEntry(await refreshSession(sessionFromEntry(entry), fetch, signal), entry),
      login: async (_id: string, ctx: any, signal: AbortSignal) => {
        abortCheck(signal);
        const device = await requestDeviceCode(undefined, (url: any, init: any) => fetch(url, { ...init, signal }));
        abortCheck(signal);
        ctx.ui.notify(`Open ${device.verificationUrl}\nDevice code: ${device.userCode}\nUse /desktop-providers cancel to stop.`, 'info');
        const session = await completeDeviceSignIn(device, { signal });
        abortCheck(signal);
        if (session.orgs.length) {
          const labels = session.orgs.map(org => `${org.name} (${org.id})`);
          const selected = await ctx.ui.select('OpenCode organization', labels);
          if (!selected) cancelled();
          const org = session.orgs[labels.indexOf(selected)]; if (!org) cancelled();
          session.orgId = org.id; session.orgName = org.name;
        }
        return sessionEntry(session);
      },
      discover: async (id: string, entry: any, _stored: any, signal: AbortSignal) => {
        const mode = id === 'opencode-go-console' ? 'go' : 'console';
        let providers;
        if (entry.type === 'api_key' || mode === 'go') {
          providers = await loadPublicModels(mode, entry.type === 'api_key' ? serviceKey(entry) : entry.access, fetch, signal);
        } else {
          const session = sessionFromEntry(entry);
          if (!session.orgId) throw new Error('Organization required');
          providers = await loadConsoleConfig(session.server, session.accessToken, session.orgId, fetch, signal);
        }
        abortCheck(signal);
        return { models: toProviderModelConfigs(buildPiModels(providers, mode)).map(m => ({ ...m, provider: id })), checkedAt: Date.now() };
      },
      stream: (model: any, context: any, options: any, loader: any) => deferredStream(model, options?.signal, async () => streamConsoleWithSession(model, context, async ({ force } = {}) => {
        const entry = await loader(force); abortCheck(options?.signal);
        return { accessToken: entry.type === 'api_key' ? serviceKey(entry) : entry.access, serviceKey: entry.type === 'api_key', orgId: entry.env?.OPENCODE_CONSOLE_ORG_ID, extraHeaders: model.headers };
      }, options)),
    },
  };
}
export default function providerExtension(pi: any) {
  const store = new CredentialStore(); const catalogs = new CatalogStore();
  const bridge = new ProviderBridge({ pi, store, catalogs, adapters: createAdapters(store, catalogs),
    // The sole read of the TUI credential file, invoked only after explicit UI confirmation.
    readImport: async () => JSON.parse(await readFile(join(homedir(), '.pi', 'agent', 'auth.json'), 'utf8')),
  });
  pi.registerCommand('desktop-providers', { description: 'Isolated providers: status, refresh, login <id>, logout <id>, import, cancel', handler: (args: string, ctx: any) => bridge.command(args, ctx) });
  pi.registerCommand('desktop-provider-import', { description: 'Confirm one-time import of TUI provider credentials', handler: (_args: string, ctx: any) => bridge.command('import', ctx) });
  const offline = async (_event: any, ctx: any) => {
    try { await bridge.offline(); } catch { if (ctx.hasUI) ctx.ui.notify('Desktop provider cache/store unavailable. No network requests were made.', 'warning'); }
  };
  pi.on('session_start', offline);
  pi.on('before_agent_start', offline);
  pi.on('session_shutdown', () => bridge.active?.abort());
}

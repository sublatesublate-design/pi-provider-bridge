import type {
  Api,
  Credential,
  Model,
  ModelsStoreEntry,
  RefreshModelsContext,
} from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getApiKey } from "../auth/index.js";
import { DEFAULT_ENDPOINT } from "../client/index.js";
import { ANTIGRAVITY_API, type AvailableModelsRaw } from "../types/types.js";
import { antigravityEnv, isRecord } from "../utils/util.js";
import { agentDir } from "../utils/paths.js";
import { buildAntigravityCatalog, resolvedCatalog, type AntigravityCatalog } from "./grouping.js";
import {
  ANTIGRAVITY_MODELS,
  ANTIGRAVITY_ROUTING,
  applyAntigravityCatalog,
  getCurrentAntigravityCatalog,
  registerDiscoveredModelEnums,
  restoreDynamicModelEnums,
  snapshotDynamicModelEnums,
} from "./models.js";

export const DEFAULT_CATALOG_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** Key for this extension's private state inside the framework's per-provider store entry. */
export const ANTIGRAVITY_PERSIST_KEY = "pi-antigravity";

type PersistedAntigravityCatalog = {
  catalog: AntigravityCatalog;
  checkedAt: number;
  modelEnums: Record<string, string>;
};

/**
 * Fetches the raw `fetchAvailableModels` catalog for an API key. Supplied by the
 * caller so the model layer stays free of transport concerns (project resolution
 * and endpoint merging live with the usage code).
 */
export type CatalogFetcher = (apiKey: string, signal?: AbortSignal) => Promise<AvailableModelsRaw>;

export function getCatalogRefreshIntervalMs(): number {
  const envVal =
    antigravityEnv("CATALOG_REFRESH_INTERVAL_MS") ?? antigravityEnv("REFRESH_INTERVAL_MS");
  if (envVal) {
    const parsed = Number.parseInt(envVal, 10);
    if (!Number.isNaN(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_CATALOG_REFRESH_INTERVAL_MS;
}

function fallbackCatalog(): AntigravityCatalog {
  return { models: ANTIGRAVITY_MODELS, routing: { ...ANTIGRAVITY_ROUTING } };
}

/**
 * Restore the catalog this slot persisted in a previous run, before any offline or
 * network decision. Returns the recorded refresh timestamp (0 when absent).
 */
export function hydrateAntigravityCatalog(providerId: string, stored: unknown): number {
  if (!isRecord(stored)) return 0;
  const persisted = stored[ANTIGRAVITY_PERSIST_KEY];
  if (!isRecord(persisted)) return 0;

  if (isStringMap(persisted.modelEnums)) restoreDynamicModelEnums(persisted.modelEnums);
  if (isCatalog(persisted.catalog)) applyAntigravityCatalog(providerId, persisted.catalog);
  return typeof persisted.checkedAt === "number" && persisted.checkedAt > 0
    ? persisted.checkedAt
    : 0;
}

/**
 * Refresh one account slot's catalog from the backend.
 *
 * Framework contract (pi-ai `Provider.refreshModels`): the offline phase restores
 * the slot's persisted catalog from `context.stored`; the online phase discovers a
 * newer catalog unless the recorded refresh is still inside the TTL. Persistence
 * and the in-memory catalog move together through `context.publish`, so a crashed
 * or aborted refresh cannot leave the two out of sync.
 *
 * A failed discovery keeps the last-known-good catalog and stays silent for
 * background refreshes; a forced refresh (manual sync) rethrows so the command can
 * report it.
 */
export async function refreshSlotCatalog(
  providerId: string,
  context: RefreshModelsContext,
  fetchRaw: CatalogFetcher,
): Promise<ProviderModelConfig[]> {
  // Desktop must never unlink a legacy TUI cache.
  const checkedAt = hydrateAntigravityCatalog(providerId, context.stored);
  const current = getCurrentAntigravityCatalog(providerId);
  if (!context.allowNetwork) return current.models;

  const apiKey = apiKeyFromCredential(context.credential);
  if (!apiKey || context.signal.aborted) return current.models;

  const now = Date.now();
  if (
    !context.force &&
    checkedAt > 0 &&
    now >= checkedAt &&
    now - checkedAt < getCatalogRefreshIntervalMs()
  ) {
    return current.models;
  }

  try {
    const available = await fetchRaw(apiKey, context.signal);
    if (context.signal.aborted) return current.models;
    const rawModels = isRecord(available.models) ? available.models : undefined;
    if (!rawModels) return current.models;

    registerDiscoveredModelEnums(rawModels);
    const discovered = buildAntigravityCatalog(rawModels, fallbackCatalog());
    const next = resolvedCatalog(discovered, current);
    if (next.models.length === 0 || discovered.models.length === 0) return current.models;

    const refreshedAt = Date.now();
    const persisted: PersistedAntigravityCatalog = {
      catalog: next,
      checkedAt: refreshedAt,
      modelEnums: snapshotDynamicModelEnums(),
    };
    const published = await context.publish({
      persist: {
        models: toStoredModels(providerId, next.models),
        [ANTIGRAVITY_PERSIST_KEY]: persisted,
      } as unknown as ModelsStoreEntry,
      update: () => applyAntigravityCatalog(providerId, next),
    });
    if (!published) return getCurrentAntigravityCatalog(providerId).models;
    return next.models;
  } catch (error) {
    // Keep last-known-good; only a manual sync reports the failure.
    if (context.force) throw error;
  }

  return getCurrentAntigravityCatalog(providerId).models;
}


function isCatalog(value: unknown): value is AntigravityCatalog {
  return (
    isRecord(value) &&
    Array.isArray(value.models) &&
    value.models.length > 0 &&
    isRecord(value.routing)
  );
}

function isStringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function apiKeyFromCredential(credential: Credential | undefined): string | undefined {
  if (!credential) return undefined;
  if (credential.type === "api_key") {
    return typeof credential.key === "string" && credential.key ? credential.key : undefined;
  }
  if (credential.type === "oauth" && typeof credential.access === "string") {
    return getApiKey(credential);
  }
  return undefined;
}

function toStoredModels(providerId: string, models: ProviderModelConfig[]): Model<Api>[] {
  return models.map((model) => ({
    ...model,
    api: ANTIGRAVITY_API,
    provider: providerId,
    baseUrl: DEFAULT_ENDPOINT,
  }));
}

import { existsSync, readFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  antigravityHeaders,
  DISCOVERY_TIMEOUT_MS,
  endpointCandidates,
  extractProjectId,
  parseApiKey,
  resolveProjectId,
} from "../client/client.js";
import {
  setLastEndpoint,
  setLastError,
  setLastProjectId,
  setLastStatus,
} from "../diagnostics/diagnostics.js";
import { PROVIDER_ID, registerDiscoveredModelEnums } from "../models/models.js";
import { antigravityEnv, isRecord } from "../utils/util.js";
import { projectSettingsJsonPath, settingsJsonPath } from "../utils/paths.js";
import { safeError } from "../utils/security.js";
import { antigravityFetch } from "../utils/http.js";
import type {
  AccountUsage,
  ApiErrorBody,
  AvailableModelsRaw,
  LoadCodeAssistRaw,
  ModelQuotaRow,
  QuotaBucket,
  QuotaGroup,
  QuotaSummaryRaw,
  TierInfo,
  TierRaw,
} from "../types/types.js";

function clampFraction(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function usedPercent(remaining?: number): number | undefined {
  if (remaining === undefined) return undefined;
  const used = Math.max(0, Math.min(1, 1 - remaining));
  return Math.round(used * 1000) / 10;
}

function progressBar(remaining?: number, width = 20): string {
  if (remaining === undefined) return `[${"?".repeat(width)}]`;
  const used = Math.max(0, Math.min(1, 1 - remaining));
  const filled = Math.max(0, Math.min(width, Math.round(used * width)));
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

export function formatReset(resetTime?: string): string {
  if (!resetTime) return "n/a";
  const ts = Date.parse(resetTime);
  if (!Number.isFinite(ts)) return resetTime;
  const delta = ts - Date.now();
  if (delta <= 0) return "now";
  const totalMin = Math.round(delta / 60000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function jsonHeaders(token: string): Record<string, string> {
  return {
    ...antigravityHeaders(token),
    Accept: "application/json",
  };
}

async function postJson(
  path: string,
  token: string,
  body: Record<string, unknown>,
): Promise<{ endpoint: string; status: number; data: unknown }> {
  let lastErrorText = "";
  for (const endpoint of endpointCandidates()) {
    try {
      const res = await antigravityFetch(`${endpoint}${path}`, {
        method: "POST",
        headers: jsonHeaders(token),
        body: JSON.stringify(body),
      });
      setLastEndpoint(endpoint);
      setLastStatus(res.status);
      const text = await res.text();
      let data: unknown;
      try {
        data = JSON.parse(text) as unknown;
      } catch {
        data = { raw: text } satisfies ApiErrorBody;
      }
      if (!res.ok) {
        const errorBody = isRecord(data) ? (data as ApiErrorBody) : undefined;
        lastErrorText =
          typeof errorBody?.error?.message === "string" ? errorBody.error.message : text;
        if (![403, 404, 429, 500, 502, 503, 504].includes(res.status)) {
          throw new Error(`${path} failed (${String(res.status)}): ${lastErrorText.slice(0, 300)}`);
        }
        continue;
      }
      return { endpoint, status: res.status, data };
    } catch (error) {
      lastErrorText = safeError(error);
      setLastError(lastErrorText);
    }
  }
  throw new Error(`${path} failed: ${lastErrorText || "no endpoint available"}`);
}

async function fetchAvailableModelsFromEndpoint(
  endpoint: string,
  token: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<{ endpoint: string; status: number; data: unknown } | undefined> {
  // `{}` and `{ project: projectId }` return byte-identical catalogs on this endpoint
  // (verified against the live backend) — one body is the full search space per host.
  const timeout = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
  try {
    const res = await antigravityFetch(`${endpoint}/v1internal:fetchAvailableModels`, {
      method: "POST",
      headers: jsonHeaders(token),
      body: JSON.stringify({ project: projectId }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      data = { raw: text } satisfies ApiErrorBody;
    }
    if (!res.ok) {
      const errorBody = isRecord(data) ? (data as ApiErrorBody) : undefined;
      const lastErrorText =
        typeof errorBody?.error?.message === "string" ? errorBody.error.message : text;
      setLastError(lastErrorText);
      return undefined;
    }
    return { endpoint, status: res.status, data };
  } catch (error) {
    setLastError(safeError(error));
    return undefined;
  }
}

/**
 * Merge fetchAvailableModels across endpoint candidates so daily/sandbox-only
 * models (e.g. Gemini 3.6 Flash) appear alongside production catalog entries.
 */
/** Merge catalog payloads from one or more fetchAvailableModels responses. */
export function mergeAvailableModelsResults(
  results: Array<{ endpoint: string; status: number; data: unknown } | undefined>,
): { endpoint: string; status: number; data: AvailableModelsRaw } {
  const mergedModels: Record<string, unknown> = {};
  let defaultAgentModelId: string | undefined;
  let lastEndpoint = "";
  let lastStatus = 0;

  for (const result of results) {
    if (!result) continue;
    setLastEndpoint(result.endpoint);
    setLastStatus(result.status);
    lastEndpoint = result.endpoint;
    lastStatus = result.status;
    const data = result.data;
    if (isRecord(data) && isRecord(data.models)) {
      Object.assign(mergedModels, data.models);
      registerDiscoveredModelEnums(data.models as Record<string, { model?: unknown }>);
    }
    if (isRecord(data) && typeof data.defaultAgentModelId === "string") {
      defaultAgentModelId = data.defaultAgentModelId;
    }
  }

  if (!lastEndpoint) {
    throw new Error(`/v1internal:fetchAvailableModels failed: no endpoint available`);
  }

  return {
    endpoint: lastEndpoint,
    status: lastStatus,
    data: {
      models: mergedModels as AvailableModelsRaw["models"],
      defaultAgentModelId,
    },
  };
}

async function fetchMergedAvailableModels(
  token: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<{ endpoint: string; status: number; data: AvailableModelsRaw }> {
  // Both endpoints are always queried to merge their catalogs — fetch them concurrently
  // instead of blocking on production before starting the daily/sandbox request.
  const results = await Promise.all(
    endpointCandidates().map((endpoint) =>
      fetchAvailableModelsFromEndpoint(endpoint, token, projectId, signal),
    ),
  );
  return mergeAvailableModelsResults(results);
}

function parseQuotaSummary(data: unknown): { groups: QuotaGroup[]; description?: string } {
  const summary = (isRecord(data) ? data : {}) as QuotaSummaryRaw;
  const groups: QuotaGroup[] = [];
  for (const group of summary.groups || []) {
    const buckets: QuotaBucket[] = [];
    for (const bucket of group.buckets || []) {
      const remaining = clampFraction(bucket.remainingFraction);
      if (remaining === undefined && !bucket.bucketId) continue;
      buckets.push({
        bucketId: String(bucket.bucketId || bucket.displayName || "unknown"),
        displayName: String(bucket.displayName || bucket.bucketId || "Limit"),
        window: bucket.window ? String(bucket.window) : undefined,
        resetTime: bucket.resetTime ? String(bucket.resetTime) : undefined,
        description: bucket.description ? String(bucket.description) : undefined,
        remainingFraction: remaining ?? 0,
      });
    }
    if (!buckets.length && !group.displayName) continue;
    groups.push({
      displayName: String(group.displayName || "Quota group"),
      description: group.description ? String(group.description) : undefined,
      buckets,
    });
  }
  return {
    groups,
    description: summary.description ? String(summary.description) : undefined,
  };
}

function parseModels(data: unknown): {
  models: ModelQuotaRow[];
  defaultAgentModelId?: string;
} {
  const raw = (isRecord(data) ? data : {}) as AvailableModelsRaw;
  const modelsObj = raw.models && isRecord(raw.models) ? raw.models : {};
  const models: ModelQuotaRow[] = [];
  for (const [modelId, info] of Object.entries(modelsObj)) {
    if (!info || !isRecord(info)) continue;
    if (info.isInternal || String(modelId).startsWith("chat_")) continue;
    const qi = isRecord(info.quotaInfo) ? info.quotaInfo : {};
    models.push({
      modelId,
      displayName:
        typeof info.displayName === "string"
          ? info.displayName
          : typeof info.label === "string"
            ? info.label
            : typeof info.modelName === "string"
              ? info.modelName
              : undefined,
      remainingFraction: clampFraction(qi.remainingFraction),
      resetTime: qi.resetTime ? String(qi.resetTime) : undefined,
      modelProvider:
        typeof info.modelProvider === "string"
          ? info.modelProvider
          : typeof info.apiProvider === "string"
            ? info.apiProvider
            : undefined,
      supportsThinking: !!info.supportsThinking,
      supportsImages: !!info.supportsImages,
      modelEnum: typeof info.model === "string" && info.model ? info.model : undefined,
      recommended: !!info.recommended,
    });
  }
  models.sort((a, b) => a.modelId.localeCompare(b.modelId));
  return {
    models,
    defaultAgentModelId:
      raw.defaultAgentModelId || raw.defaultAgentModel
        ? String(raw.defaultAgentModelId || raw.defaultAgentModel)
        : undefined,
  };
}

function parseTier(value: unknown): TierInfo | undefined {
  if (!isRecord(value)) return undefined;
  const tier = value as TierRaw;
  if (!tier.id && !tier.name) return undefined;
  return {
    id: tier.id ? String(tier.id) : undefined,
    name: tier.name ? String(tier.name) : undefined,
    description: tier.description ? String(tier.description) : undefined,
  };
}

async function loadCodeAssistSafe(token: string) {
  try {
    return await postJson("/v1internal:loadCodeAssist", token, {
      metadata: {
        ideType: "ANTIGRAVITY",
        platform: "PLATFORM_UNSPECIFIED",
        pluginType: "GEMINI",
      },
    });
  } catch {
    return null;
  }
}

/**
 * The user-quota-summary RPC is gated behind a paid subscription: free-tier
 * accounts get 403 SUBSCRIPTION_REQUIRED (#3501). It is best-effort diagnostics
 * only — never let it block the rest of the account data (models, tier, project).
 */
async function fetchQuotaSummarySafe(token: string): Promise<
  | { ok: true; result: { endpoint: string; status: number; data: unknown } }
  | {
      ok: false;
      error: string;
    }
> {
  try {
    return { ok: true, result: await postJson("/v1internal:retrieveUserQuotaSummary", token, {}) };
  } catch (error) {
    const msg = safeError(error);
    setLastError(msg);
    return { ok: false, error: msg };
  }
}

/**
 * Live runtime catalog rows for model sync (`refreshModels`). Throws on failure —
 * callers fall back to the static catalog.
 */
/** Raw backend catalog for the model-discovery layer (one merged payload). */
export async function fetchLiveModelsRaw(
  apiKeyRaw: string,
  signal?: AbortSignal,
): Promise<AvailableModelsRaw> {
  const creds = parseApiKey(apiKeyRaw);
  const projectId = resolveProjectId({ token: creds.token, credentialProjectId: creds.projectId });
  const available = await fetchMergedAvailableModels(creds.token, projectId, signal);
  return available.data;
}

export async function fetchAccountUsage(apiKeyRaw?: string): Promise<AccountUsage> {
  const creds = parseApiKey(apiKeyRaw);
  const initialProjectId =
    creds.projectId ||
    resolveProjectId({
      token: creds.token,
      credentialProjectId: creds.projectId,
    });

  // Fetch loadCodeAssist, quota summary, and available models all in parallel
  // to minimize command execution latency.
  const [assistResult, summaryRes, available] = await Promise.all([
    loadCodeAssistSafe(creds.token),
    fetchQuotaSummarySafe(creds.token),
    fetchMergedAvailableModels(creds.token, initialProjectId),
  ]);

  // Derive project ID from the loadCodeAssist response or stored project ID.
  const discoveredProject = assistResult ? extractProjectId(assistResult.data) : undefined;
  const projectId = resolveProjectId({
    token: creds.token,
    warmedProject: discoveredProject ?? null,
    credentialProjectId: creds.projectId,
  });
  setLastProjectId(projectId);

  const summary = summaryRes.ok ? summaryRes.result : null;
  const quotaSummaryError = summaryRes.ok ? undefined : summaryRes.error;
  const { groups, description } = summary
    ? parseQuotaSummary(summary.data)
    : { groups: [], description: undefined };
  const { models, defaultAgentModelId } = parseModels(available.data);

  const assistData = (isRecord(assistResult?.data) ? assistResult.data : {}) as LoadCodeAssistRaw;
  const productTier = parseTier(assistData.currentTier);
  const paidTier = parseTier(assistData.paidTier);

  // Google returns currentTier=free-tier even for Google AI Pro accounts.
  // The real subscription lives in paidTier (e.g. g1-pro-tier / Google AI Pro).
  const planLabel = paidTier?.name
    ? `${paidTier.name}${paidTier.id ? ` (${paidTier.id})` : ""}`
    : productTier?.name
      ? `${productTier.name}${productTier.id ? ` (${productTier.id})` : ""}`
      : undefined;

  return {
    projectId,
    endpoint: summary?.endpoint ?? available.endpoint ?? assistResult?.endpoint,
    productTier,
    paidTier,
    planLabel,
    groups,
    groupDescription: description,
    quotaSummaryError,
    models,
    defaultAgentModelId,
    fetchedAt: Date.now(),
  };
}

function quotaErrorNote(msg: string): string {
  if (/SUBSCRIPTION_REQUIRED|#3501|(?:lack|missing).*license/i.test(msg)) {
    return "Aggregate quota summary needs a paid subscription (free-tier can't use that endpoint). Per-model usage is still available via /antigravity.models.";
  }
  return `Aggregate quota summary unavailable: ${msg.slice(0, 160)}`;
}

export function formatUsageSummary(usage: AccountUsage): string {
  const lines: string[] = [];

  if (usage.planLabel) lines.push(usage.planLabel);

  if (!usage.groups.length) {
    if (usage.quotaSummaryError) {
      lines.push(quotaErrorNote(usage.quotaSummaryError));
    } else {
      lines.push("No quota groups returned.");
    }
    return lines.join("\n");
  }

  for (const group of usage.groups) {
    if (lines.length) lines.push("");
    lines.push(group.displayName);
    for (const bucket of group.buckets) {
      const used = usedPercent(bucket.remainingFraction);
      lines.push(
        `  ${progressBar(bucket.remainingFraction)} ${bucket.displayName}: ${used ?? "?"}% used · resets ${formatReset(bucket.resetTime)}`,
      );
    }
  }

  return lines.join("\n").trimEnd();
}

export function getGroupShortLabel(groupName: string, bucketId?: string): string {
  const lowerGroup = groupName.toLowerCase();
  const lowerBucket = (bucketId || "").toLowerCase();

  if (lowerGroup.includes("gemini") || lowerBucket.startsWith("gemini")) {
    return "Gemini";
  }
  if (
    lowerGroup.includes("claude") ||
    lowerGroup.includes("gpt") ||
    lowerGroup.includes("opus") ||
    lowerGroup.includes("3p") ||
    lowerBucket.startsWith("3p")
  ) {
    return "Opus";
  }
  return groupName.split(/\s+/)[0] || "Quota";
}

export interface FooterStatusOptions {
  showOpus?: boolean;
  showReset?: boolean;
  showResetTime?: boolean;
}

export function parseBooleanConfigValue(val: unknown): boolean | undefined {
  if (typeof val === "boolean") return val;
  if (typeof val === "string") {
    const trimmed = val.trim().toLowerCase();
    if (trimmed === "0" || trimmed === "false" || trimmed === "off" || trimmed === "no") {
      return false;
    }
    if (trimmed === "1" || trimmed === "true" || trimmed === "on" || trimmed === "yes") {
      return true;
    }
  }
  if (typeof val === "number") {
    if (val === 0) return false;
    if (val === 1) return true;
  }
  return undefined;
}

export const parseOpusConfigValue = parseBooleanConfigValue;

const OPUS_CONFIG_KEYS = ["statusShowOpus", "showOpusUsage", "statusBarShowOpus", "showOpus"];

const OPUS_ENV_KEYS = ["STATUS_SHOW_OPUS", "SHOW_OPUS_USAGE", "STATUS_BAR_SHOW_OPUS", "SHOW_OPUS"];

const RESET_CONFIG_KEYS = [
  "statusShowReset",
  "statusShowResetTime",
  "showResetTime",
  "showReset",
  "statusBarShowReset",
  "statusBarShowResetTime",
];

const RESET_ENV_KEYS = [
  "STATUS_SHOW_RESET",
  "STATUS_SHOW_RESET_TIME",
  "SHOW_RESET_TIME",
  "SHOW_RESET",
  "STATUS_BAR_SHOW_RESET",
  "STATUS_BAR_SHOW_RESET_TIME",
];

export function parseSettingFromFile(path: string, keys: string[]): boolean | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!isRecord(raw)) return undefined;

    const ag = raw.antigravity;
    if (isRecord(ag)) {
      for (const key of keys) {
        const val = parseBooleanConfigValue(ag[key]);
        if (val !== undefined) return val;
      }
    }

    for (const key of keys) {
      const val = parseBooleanConfigValue(raw[`antigravity.${key}`]);
      if (val !== undefined) return val;
    }
  } catch {
    // ignore read/parse errors
  }
  return undefined;
}

export function parseOpusSettingFromFile(path: string): boolean | undefined {
  return parseSettingFromFile(path, OPUS_CONFIG_KEYS);
}

export function parseResetSettingFromFile(path: string): boolean | undefined {
  return parseSettingFromFile(path, RESET_CONFIG_KEYS);
}

export function isStatusOpusEnabled(): boolean {
  for (const envKey of OPUS_ENV_KEYS) {
    const envVal = antigravityEnv(envKey);
    const parsedEnv = parseBooleanConfigValue(envVal);
    if (parsedEnv !== undefined) return parsedEnv;
  }

  const projectSetting = parseOpusSettingFromFile(projectSettingsJsonPath());
  if (projectSetting !== undefined) return projectSetting;

  const globalSetting = parseOpusSettingFromFile(settingsJsonPath());
  if (globalSetting !== undefined) return globalSetting;

  return false;
}

export function isStatusResetEnabled(): boolean {
  for (const envKey of RESET_ENV_KEYS) {
    const envVal = antigravityEnv(envKey);
    const parsedEnv = parseBooleanConfigValue(envVal);
    if (parsedEnv !== undefined) return parsedEnv;
  }

  const projectSetting = parseResetSettingFromFile(projectSettingsJsonPath());
  if (projectSetting !== undefined) return projectSetting;

  const globalSetting = parseResetSettingFromFile(settingsJsonPath());
  if (globalSetting !== undefined) return globalSetting;

  return false;
}

/** Compact single-line status for footer bar display. */
export function formatFooterStatus(usage: AccountUsage, opts?: FooterStatusOptions): string {
  if (!usage.groups.length) return "Quota: n/a";
  const showOpus = opts?.showOpus ?? isStatusOpusEnabled();
  const showReset = opts?.showReset ?? opts?.showResetTime ?? isStatusResetEnabled();
  const parts: string[] = [];
  for (const group of usage.groups) {
    const groupLabel = getGroupShortLabel(group.displayName, group.buckets[0]?.bucketId);
    if (!showOpus && groupLabel === "Opus") continue;
    if (!group.buckets.length) continue;
    const fiveHour = group.buckets.find(
      (b) => b.window === "5h" || b.bucketId.toLowerCase().includes("5h"),
    );
    const weekly = group.buckets.find(
      (b) => b.window === "weekly" || b.bucketId.toLowerCase().includes("weekly"),
    );
    const formatBucket = (prefix: string, bucket: QuotaBucket): string => {
      const pct = `${prefix}:${usedPercent(bucket.remainingFraction) ?? "?"}%`;
      if (!showReset) return pct;
      const reset = formatReset(bucket.resetTime);
      return reset && reset !== "n/a" ? `${pct}(${reset})` : pct;
    };
    const shown: string[] = [];
    if (fiveHour) shown.push(formatBucket("5h", fiveHour));
    if (weekly) shown.push(formatBucket("w", weekly));
    if (!shown.length) {
      const fallback = group.buckets[0];
      shown.push(formatBucket(fallback.window ?? fallback.displayName, fallback));
    }
    parts.push(`${groupLabel} ${shown.join(" ")}`);
  }
  return parts.join(" · ") || "Quota: n/a";
}

export function formatModelsList(usage: AccountUsage, opts?: { all?: boolean }): string {
  const lines: string[] = [];
  lines.push("Antigravity available models");
  lines.push(`project=${usage.projectId}`);
  if (usage.defaultAgentModelId) lines.push(`defaultAgentModel=${usage.defaultAgentModelId}`);
  lines.push("");

  const rows = opts?.all
    ? usage.models
    : usage.models.filter((m) => !/tab_|chat_/i.test(m.modelId));

  if (!rows.length) {
    lines.push("No models returned.");
    return lines.join("\n");
  }

  const maxId = Math.max(...rows.map((m) => m.modelId.length), 8);
  for (const m of rows) {
    const used = usedPercent(m.remainingFraction);
    const flags = [
      m.recommended ? "recommended" : "",
      m.supportsThinking ? "thinking" : "",
      m.supportsImages ? "images" : "",
    ]
      .filter(Boolean)
      .join(",");
    const name = m.displayName && m.displayName !== m.modelId ? `  ${m.displayName}` : "";
    lines.push(
      `${m.modelId.padEnd(maxId)}  used ${used === undefined ? "  ?" : String(used).padStart(5)}%  reset ${formatReset(m.resetTime).padEnd(8)}${flags ? `  [${flags}]` : ""}${name}`,
    );
  }
  lines.push("");
  lines.push("Note: used % is pool-shared (not a private per-model budget).");
  return lines.join("\n");
}

export async function resolveApiKeyFromContext(
  ctx: ExtensionContext,
  providerId: string = PROVIDER_ID,
): Promise<string | undefined> {
  try {
    return await ctx.modelRegistry.getApiKeyForProvider(providerId);
  } catch {
    return undefined;
  }
}

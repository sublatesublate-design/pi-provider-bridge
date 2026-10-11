import { readFileSync } from "node:fs";
import { PROVIDER_ID, PROVIDER_NAME } from "../models/models.js";
import { authJsonPath } from "../utils/paths.js";
import { antigravityEnv, asString, isRecord } from "../utils/util.js";

/** Hard ceiling on registered slots so a typo cannot flood the model list. */
export const MAX_ACCOUNT_SLOTS = 8;
export const DEFAULT_ACCOUNT_SLOTS = 3;

/** Non-secret view of one account slot. */
export type AccountSlot = {
  /** 1-based slot number. Slot 1 is the primary `antigravity` provider. */
  slot: number;
  providerId: string;
  signedIn: boolean;
  /** Google account email, when the stored credential carries one. */
  email?: string;
};

/**
 * How many account slots to register. `ANTIGRAVITY_ACCOUNTS=1..8` (default 3).
 * Slots beyond the first stay model-less until their account signs in, so
 * raising this does not clutter `/model` for people using one account.
 */
export function accountSlotCount(): number {
  const raw = antigravityEnv("ACCOUNTS");
  const parsed = raw ? Number.parseInt(raw.trim(), 10) : Number.NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_ACCOUNT_SLOTS;
  return Math.min(MAX_ACCOUNT_SLOTS, Math.max(1, parsed));
}

/** Slot 1 keeps the bare `antigravity` id so existing logins and sessions keep working. */
export function slotProviderId(slot: number): string {
  return slot <= 1 ? PROVIDER_ID : `${PROVIDER_ID}-${slot}`;
}

/** Slot number for a provider id, or undefined when it is not an Antigravity slot. */
export function slotNumber(providerId: string | undefined): number | undefined {
  if (!providerId) return undefined;
  if (providerId === PROVIDER_ID) return 1;
  const match = new RegExp(`^${PROVIDER_ID}-(\\d+)$`).exec(providerId);
  if (!match) return undefined;
  const slot = Number.parseInt(match[1], 10);
  if (!Number.isFinite(slot) || slot < 2 || slot > MAX_ACCOUNT_SLOTS) return undefined;
  return slot;
}

export function isAntigravityProviderId(providerId: string | undefined): boolean {
  return slotNumber(providerId) !== undefined;
}

/** Registered provider ids, primary first. */
export function providerSlots(): string[] {
  return Array.from({ length: accountSlotCount() }, (_, index) => slotProviderId(index + 1));
}

/**
 * Read the non-secret parts of Pi's auth.json: which slots hold a credential
 * and which email each belongs to. Tokens are never returned, logged, or
 * retained — request auth always comes from Pi's own resolution path.
 */
function readStoredEmails(): Map<string, string | undefined> {
  const emails = new Map<string, string | undefined>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(authJsonPath(), "utf8"));
  } catch {
    // missing, unreadable, or corrupt auth.json: nothing is signed in as far as we know
    return emails;
  }
  if (!isRecord(parsed)) return emails;
  for (const [providerId, credential] of Object.entries(parsed)) {
    if (!isAntigravityProviderId(providerId) || !isRecord(credential)) continue;
    emails.set(providerId, asString(credential.email));
  }
  return emails;
}

/** All registered slots with their sign-in state, primary first. */
export function listAccountSlots(): AccountSlot[] {
  const emails = readStoredEmails();
  return providerSlots().map((providerId, index) => ({
    slot: index + 1,
    providerId,
    signedIn: emails.has(providerId),
    email: emails.get(providerId),
  }));
}

/** Slot for a provider id, including slots outside the registered range. */
export function accountSlotFor(providerId: string): AccountSlot | undefined {
  const slot = slotNumber(providerId);
  if (slot === undefined) return undefined;
  const emails = readStoredEmails();
  return { slot, providerId, signedIn: emails.has(providerId), email: emails.get(providerId) };
}

/**
 * Resolve a user-supplied account reference: a slot number ("2"), a provider id
 * ("antigravity-2"), or a case-insensitive email substring ("work@").
 */
export function resolveAccountRef(ref: string): AccountSlot | undefined {
  const text = ref.trim();
  if (!text) return undefined;
  const slots = listAccountSlots();
  if (/^\d+$/.test(text)) return slots.find((entry) => entry.slot === Number.parseInt(text, 10));
  const byProvider = slots.find((entry) => entry.providerId === text.toLowerCase());
  if (byProvider) return byProvider;
  const needle = text.toLowerCase();
  return slots.find((entry) => entry.email?.toLowerCase().includes(needle));
}

/** Provider display name shown in the model selector and login list. */
export function providerDisplayName(providerId: string, email?: string): string {
  const slot = slotNumber(providerId) ?? 1;
  const base = slot === 1 ? PROVIDER_NAME : `${PROVIDER_NAME} #${slot}`;
  return email ? `${base} (${email})` : base;
}

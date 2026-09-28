import { eq } from "drizzle-orm";

import { assistantSettings, businesses, withBusinessTransaction, type DatabaseTransaction } from "@lobbystack/db";
import { isServiceTier, tierAllows, type AssistantFeature, type ServiceTier } from "@lobbystack/shared";

import type { DomainContext } from "../context";
import { requireBusinessAdmin, requireBusinessMembership, requirePlatformAdmin } from "../../authz";
import { queueCallRoutingInTransaction } from "./routing";

export class TierRequiredError extends Error {
  readonly status = 403;
  readonly code = "tier_required";

  constructor(feature: AssistantFeature) {
    super(feature === "back_office" ? "This needs the Back Office add-on." : "This needs a higher service tier.");
    this.name = "TierRequiredError";
  }
}

export class AssistantInputError extends Error {
  readonly status = 400;
  readonly code = "invalid_request";

  constructor(message: string) {
    super(message);
    this.name = "AssistantInputError";
  }
}

export type AssistantSettings = {
  businessId: string;
  serviceTier: ServiceTier;
  backOfficeEnabled: boolean;
  missedCallTextEnabled: boolean;
  missedCallGreeting: string | null;
  textBackMessage: string | null;
  textBackMessageEs: string | null;
  smsAiEnabled: boolean;
  photoRequestsEnabled: boolean;
  voiceCallbackEnabled: boolean;
  callbackMode: "ask_first" | "automatic";
  callbackDelaySeconds: number;
  afterHoursMode: "send_now" | "hold";
  contactWindowStartMinutes: number;
  contactWindowEndMinutes: number;
  emergencyPhone: string | null;
  reviewUrl: string | null;
};

export function defaultAssistantSettings(businessId: string): AssistantSettings {
  return {
    businessId,
    serviceTier: "missed_call",
    backOfficeEnabled: false,
    missedCallTextEnabled: true,
    missedCallGreeting: null,
    textBackMessage: null,
    textBackMessageEs: null,
    smsAiEnabled: true,
    photoRequestsEnabled: true,
    voiceCallbackEnabled: false,
    callbackMode: "ask_first",
    callbackDelaySeconds: 60,
    afterHoursMode: "send_now",
    contactWindowStartMinutes: 480,
    contactWindowEndMinutes: 1200,
    emergencyPhone: null,
    reviewUrl: null,
  };
}

function fromRow(row: typeof assistantSettings.$inferSelect): AssistantSettings {
  return {
    businessId: row.businessId,
    serviceTier: isServiceTier(row.serviceTier) ? row.serviceTier : "missed_call",
    backOfficeEnabled: row.backOfficeEnabled,
    missedCallTextEnabled: row.missedCallTextEnabled,
    missedCallGreeting: row.missedCallGreeting,
    textBackMessage: row.textBackMessage,
    textBackMessageEs: row.textBackMessageEs,
    smsAiEnabled: row.smsAiEnabled,
    photoRequestsEnabled: row.photoRequestsEnabled,
    voiceCallbackEnabled: row.voiceCallbackEnabled,
    callbackMode: row.callbackMode === "automatic" ? "automatic" : "ask_first",
    callbackDelaySeconds: row.callbackDelaySeconds,
    afterHoursMode: row.afterHoursMode === "hold" ? "hold" : "send_now",
    contactWindowStartMinutes: row.contactWindowStartMinutes,
    contactWindowEndMinutes: row.contactWindowEndMinutes,
    emergencyPhone: row.emergencyPhone,
    reviewUrl: row.reviewUrl,
  };
}

/** Runs inside the caller's business transaction, so RLS scopes the read. */
export async function loadAssistantSettings(tx: DatabaseTransaction, businessId: string): Promise<AssistantSettings> {
  const row = (await tx.select().from(assistantSettings).where(eq(assistantSettings.businessId, businessId)).limit(1))[0];
  return row ? fromRow(row) : defaultAssistantSettings(businessId);
}

export async function requireAssistantFeature(tx: DatabaseTransaction, businessId: string, feature: AssistantFeature): Promise<AssistantSettings> {
  const settings = await loadAssistantSettings(tx, businessId);
  if (!tierAllows(settings, feature)) throw new TierRequiredError(feature);
  return settings;
}

export async function loadBusinessBasics(tx: DatabaseTransaction, businessId: string): Promise<{ name: string; timezone: string; defaultLocale: string }> {
  const row = (await tx.select({ name: businesses.name, timezone: businesses.timezone, defaultLocale: businesses.defaultLocale }).from(businesses).where(eq(businesses.id, businessId)).limit(1))[0];
  if (!row) throw new Error("Business not found.");
  return row;
}

export async function getAssistantSettings(context: DomainContext, input: { userId: string; businessId: string }): Promise<AssistantSettings> {
  return await withBusinessTransaction(context.db, { userId: input.userId, businessId: input.businessId, actorType: "operator" }, async (tx) => {
    await requireBusinessMembership(tx, input);
    return await loadAssistantSettings(tx, input.businessId);
  });
}

export type AssistantSettingsPatch = Partial<Omit<AssistantSettings, "businessId">>;

const E164 = /^\+[1-9]\d{7,14}$/;

function optionalText(value: unknown, field: string, max: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new AssistantInputError(`${field} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new AssistantInputError(`${field} must be ${max} characters or fewer.`);
  return trimmed || null;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new AssistantInputError(`${field} must be true or false.`);
  return value;
}

function optionalInteger(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new AssistantInputError(`${field} must be a whole number from ${min} to ${max}.`);
  return value;
}

/** Validates untrusted input field by field. Unknown fields are rejected, not ignored. */
export function parseAssistantSettingsPatch(input: unknown): AssistantSettingsPatch {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AssistantInputError("Settings must be an object.");
  const raw = input as Record<string, unknown>;
  const allowed = new Set<string>(Object.keys(defaultAssistantSettings("x")).filter((key) => key !== "businessId"));
  const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
  if (unknown.length) throw new AssistantInputError(`Unknown settings: ${unknown.join(", ")}.`);
  const patch: AssistantSettingsPatch = {};
  if (raw.serviceTier !== undefined) {
    if (!isServiceTier(raw.serviceTier)) throw new AssistantInputError("serviceTier must be missed_call, receptionist or assistant.");
    patch.serviceTier = raw.serviceTier;
  }
  if (raw.callbackMode !== undefined) {
    if (raw.callbackMode !== "ask_first" && raw.callbackMode !== "automatic") throw new AssistantInputError("callbackMode must be ask_first or automatic.");
    patch.callbackMode = raw.callbackMode;
  }
  if (raw.afterHoursMode !== undefined) {
    if (raw.afterHoursMode !== "send_now" && raw.afterHoursMode !== "hold") throw new AssistantInputError("afterHoursMode must be send_now or hold.");
    patch.afterHoursMode = raw.afterHoursMode;
  }
  for (const key of ["backOfficeEnabled", "missedCallTextEnabled", "smsAiEnabled", "photoRequestsEnabled", "voiceCallbackEnabled"] as const) {
    const value = optionalBoolean(raw[key], key);
    if (value !== undefined) patch[key] = value;
  }
  const greeting = optionalText(raw.missedCallGreeting, "missedCallGreeting", 400);
  if (greeting !== undefined) patch.missedCallGreeting = greeting;
  const textBack = optionalText(raw.textBackMessage, "textBackMessage", 300);
  if (textBack !== undefined) patch.textBackMessage = textBack;
  const textBackEs = optionalText(raw.textBackMessageEs, "textBackMessageEs", 300);
  if (textBackEs !== undefined) patch.textBackMessageEs = textBackEs;
  const delay = optionalInteger(raw.callbackDelaySeconds, "callbackDelaySeconds", 0, 900);
  if (delay !== undefined) patch.callbackDelaySeconds = delay;
  const start = optionalInteger(raw.contactWindowStartMinutes, "contactWindowStartMinutes", 0, 1439);
  if (start !== undefined) patch.contactWindowStartMinutes = start;
  const end = optionalInteger(raw.contactWindowEndMinutes, "contactWindowEndMinutes", 1, 1440);
  if (end !== undefined) patch.contactWindowEndMinutes = end;
  const emergencyPhone = optionalText(raw.emergencyPhone, "emergencyPhone", 32);
  if (emergencyPhone !== undefined) {
    if (emergencyPhone !== null && !E164.test(emergencyPhone)) throw new AssistantInputError("emergencyPhone must be in E.164 format, for example +17135550123.");
    patch.emergencyPhone = emergencyPhone;
  }
  const reviewUrl = optionalText(raw.reviewUrl, "reviewUrl", 500);
  if (reviewUrl !== undefined) {
    if (reviewUrl !== null && !/^https:\/\/[^\s]+$/.test(reviewUrl)) throw new AssistantInputError("reviewUrl must start with https://.");
    patch.reviewUrl = reviewUrl;
  }
  return patch;
}

// What a business pays for is set by the platform (billing or Key 20 staff), never by the business itself.
const PLATFORM_ONLY_FIELDS = ["serviceTier", "backOfficeEnabled"] as const;

export async function updateAssistantSettings(context: DomainContext, input: { userId: string; businessId: string; patch: unknown }): Promise<AssistantSettings> {
  const patch = parseAssistantSettingsPatch(input.patch);
  return await withBusinessTransaction(context.db, { userId: input.userId, businessId: input.businessId, actorType: "operator" }, async (tx) => {
    await requireBusinessAdmin(tx, input);
    if (PLATFORM_ONLY_FIELDS.some((field) => patch[field] !== undefined)) await requirePlatformAdmin(tx, input.userId);
    const current = await loadAssistantSettings(tx, input.businessId);
    const next = { ...current, ...patch };
    if (next.contactWindowStartMinutes >= next.contactWindowEndMinutes) throw new AssistantInputError("The contact window must start before it ends.");
    const { businessId: _ignored, ...values } = next;
    await tx.insert(assistantSettings).values({ businessId: input.businessId, ...values }).onConflictDoUpdate({ target: assistantSettings.businessId, set: { ...values, updatedAt: new Date() } });
    // Moving across the Tier 1 / Tier 2 line changes who answers the phone.
    if (tierAllows(current, "live_receptionist") !== tierAllows(next, "live_receptionist")) await queueCallRoutingInTransaction(tx, input.businessId, `tier:${next.serviceTier}`);
    return next;
  });
}

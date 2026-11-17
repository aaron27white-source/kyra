import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export type LmcActionClaims = { tenantId: string; leadId: string; purpose: "unsubscribe" | "appointment_change"; expiresAt?: number };

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function canonicalBase64(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  return bytes.toString("base64url") === value ? bytes : null;
}

/** UUID routing prefix plus 128 random secret bits: 43 URL/email-safe characters. */
export function createReplyToken(tenantId: string): { value: string; hash: string } {
  if (!uuid.test(tenantId)) throw new Error("INVALID_TENANT_ID");
  const value = Buffer.concat([Buffer.from(tenantId.replaceAll("-", ""), "hex"), randomBytes(16)]).toString("base64url");
  return { value, hash: digest(value) };
}

/** Routing only. This does NOT authorize a request; the stored hash must match. */
export function routeReplyToken(value: string): string | null {
  if (typeof value !== "string" || value.length !== 43) return null;
  const bytes = canonicalBase64(value);
  if (!bytes || bytes.length !== 32) return null;
  const id = bytes.subarray(0,16).toString("hex");
  return `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`;
}

export function verifyReplyToken(value: string, expectedTenantId: string, storedHash: string): boolean {
  const tenantId = routeReplyToken(value);
  if (!tenantId || tenantId !== expectedTenantId.toLowerCase() || !/^[a-f0-9]{64}$/.test(storedHash)) return false;
  return timingSafeEqual(Buffer.from(digest(value), "hex"), Buffer.from(storedHash, "hex"));
}

function signingKey(secret: string): Buffer {
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) throw new Error("LMC_SIGNING_SECRET_REQUIRED");
  return Buffer.from(secret, "utf8");
}

function parseClaims(value: unknown): LmcActionClaims | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const claims = value as Record<string, unknown>;
  if (Object.keys(claims).some(key => !["tenantId", "leadId", "purpose", "expiresAt"].includes(key))
    || typeof claims.tenantId !== "string" || !uuid.test(claims.tenantId)
    || typeof claims.leadId !== "string" || !uuid.test(claims.leadId)
    || (claims.purpose !== "unsubscribe" && claims.purpose !== "appointment_change")
    || (claims.expiresAt !== undefined && (typeof claims.expiresAt !== "number" || !Number.isSafeInteger(claims.expiresAt) || claims.expiresAt <= 0))
    || (claims.purpose === "appointment_change" && claims.expiresAt === undefined)) return null;
  return { tenantId: claims.tenantId.toLowerCase(), leadId: claims.leadId.toLowerCase(), purpose: claims.purpose,
    ...(typeof claims.expiresAt === "number" ? { expiresAt: claims.expiresAt } : {}) };
}

export function signActionToken(claims: LmcActionClaims, secret: string): string {
  const parsed = parseClaims(claims);
  if (!parsed) throw new Error("INVALID_ACTION_CLAIMS");
  const payload = Buffer.from(JSON.stringify(parsed)).toString("base64url");
  const signature = createHmac("sha256", signingKey(secret)).update(`lmc-action-v1.${payload}`).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyActionToken(value: string, purpose: LmcActionClaims["purpose"], secret: string, now = Date.now()): LmcActionClaims | null {
  if (typeof value !== "string" || value.length > 2_048 || !Number.isFinite(now)) return null;
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const payload = parts[0]!, signature = canonicalBase64(parts[1]!);
  const data = canonicalBase64(payload);
  if (!data || data.length > 1_024 || !signature || signature.length !== 32) return null;
  let expected: Buffer;
  try { expected = createHmac("sha256", signingKey(secret)).update(`lmc-action-v1.${payload}`).digest(); }
  catch { return null; }
  if (!timingSafeEqual(expected, signature)) return null;
  let decoded: unknown;
  try { decoded = JSON.parse(data.toString("utf8")); } catch { return null; }
  const claims = parseClaims(decoded);
  if (!claims || claims.purpose !== purpose || (claims.expiresAt !== undefined && claims.expiresAt <= now)) return null;
  return claims;
}

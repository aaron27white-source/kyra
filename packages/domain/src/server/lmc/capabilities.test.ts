import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createReplyToken, routeReplyToken, verifyReplyToken, signActionToken, verifyActionToken } from "./capabilities";

describe("email capability isolation", () => {
  it("creates distinct unpredictable conversation tokens that fit an email local-part", () => {
    const tenant = randomUUID(), a = createReplyToken(tenant), b = createReplyToken(tenant);
    expect(a.value).not.toBe(b.value);
    expect(a.hash).not.toContain(a.value);
    expect(`reply+${a.value}`.length).toBeLessThanOrEqual(64);
    expect(routeReplyToken(a.value)).toBe(tenant);
    expect(verifyReplyToken(a.value, tenant, a.hash)).toBe(true);
  });
  it("does not authorize a token merely because its routing prefix names a tenant", () => {
    const tenantA = randomUUID(), tenantB = randomUUID();
    const token = createReplyToken(tenantA);
    const bytes = Buffer.from(token.value, "base64url");
    Buffer.from(tenantB.replaceAll("-", ""), "hex").copy(bytes, 0);
    const tampered = bytes.toString("base64url");
    expect(routeReplyToken(tampered)).toBe(tenantB);
    expect(verifyReplyToken(tampered, tenantB, token.hash)).toBe(false);
    expect(verifyReplyToken(token.value, tenantB, token.hash)).toBe(false);
  });
  it.each(["", "short", "x".repeat(10_000), "A".repeat(44), "../secret", "\r\nBcc: other@example.invalid"])("rejects malformed reply token %s", (value) => {
    expect(routeReplyToken(value)).toBeNull();
    expect(verifyReplyToken(value, randomUUID(), "0".repeat(64))).toBe(false);
  });
  it("binds signed actions to purpose and rejects tampering, expiry and a different key", () => {
    const secret = randomBytes(32).toString("hex"), now = Date.now();
    const claims = { tenantId: randomUUID(), leadId: randomUUID(), purpose: "appointment_change" as const, expiresAt: now + 60_000 };
    const token = signActionToken(claims, secret);
    expect(verifyActionToken(token, "appointment_change", secret, now)).toEqual(claims);
    expect(verifyActionToken(token, "unsubscribe", secret, now)).toBeNull();
    expect(verifyActionToken(token, "appointment_change", secret, now + 60_001)).toBeNull();
    expect(verifyActionToken(token, "appointment_change", randomBytes(32).toString("hex"), now)).toBeNull();
    expect(verifyActionToken(`${token.slice(0,-4)}xxxx`, "appointment_change", secret, now)).toBeNull();
  });
  it("keeps unsubscribe links usable without turning them into appointment credentials", () => {
    const secret = randomBytes(32).toString("hex");
    const claims = { tenantId: randomUUID(), leadId: randomUUID(), purpose: "unsubscribe" as const };
    const token = signActionToken(claims, secret);
    expect(verifyActionToken(token, "unsubscribe", secret, Date.now() + 365 * 86_400_000)).toEqual(claims);
    expect(verifyActionToken(token, "appointment_change", secret)).toBeNull();
    expect(() => signActionToken({ ...claims, purpose: "appointment_change" }, secret)).toThrow();
  });
  it("rejects weak signing configuration and malformed signed payloads", () => {
    const claims = { tenantId: randomUUID(), leadId: randomUUID(), purpose: "unsubscribe" as const };
    expect(() => signActionToken(claims, "placeholder")).toThrow();
    expect(verifyActionToken("not.a.signed.token", "unsubscribe", randomBytes(32).toString("hex"))).toBeNull();
  });
});

import { createHmac, timingSafeEqual } from "node:crypto";

export type ResendWebhookHeaders = { id: string; timestamp: string; signature: string };

export function verifyResendWebhookSignature(body: string, headers: ResendWebhookHeaders, secret: string, now = Date.now()): boolean {
  const timestamp = Number(headers.timestamp);
  if (!/^[A-Za-z0-9_-]{1,255}$/.test(headers.id) || !/^\d{1,12}$/.test(headers.timestamp) || headers.signature.length>4096 || !Number.isFinite(now) || !Number.isSafeInteger(timestamp) || Math.abs(now - timestamp * 1_000) > 5 * 60_000) return false;
  const rawSecret = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(rawSecret)) return false;
  let key: Buffer;
  try { key = Buffer.from(rawSecret, "base64"); } catch { return false; }
  if (key.length === 0) return false;
  const expected = createHmac("sha256", key).update(`${headers.id}.${headers.timestamp}.${body}`).digest("base64");
  return headers.signature.split(" ").some((candidate) => {
    if (!/^v1,[A-Za-z0-9+/]{43}=$/.test(candidate)) return false;
    const value = candidate.slice(3);
    const actual = Buffer.from(value);
    const expectedBuffer = Buffer.from(expected);
    return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
  });
}

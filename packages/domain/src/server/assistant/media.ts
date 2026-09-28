import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { enqueueOutbox, messages, storageObjects, withBusinessTransaction } from "@lobbystack/db";

import type { DomainContext } from "../context";
import type { BinaryStorageProvider } from "../storage";

export const MAX_SMS_MEDIA_BYTES = 10 * 1024 * 1024;

const ALLOWED_MEDIA: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/3gpp": "3gp",
};

export function smsMediaExtension(contentType: string): string | null {
  return ALLOWED_MEDIA[contentType.split(";")[0]!.trim().toLowerCase()] ?? null;
}

/** Sniffs the real file type. The declared type is the sender's claim, not a fact. */
export function sniffMediaType(bytes: Uint8Array): string | null {
  const at = (offset: number, ...values: number[]) => values.every((value, index) => bytes[offset + index] === value);
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  if (at(4, 0x66, 0x74, 0x79, 0x70)) {
    const brand = String.fromCharCode(...bytes.slice(8, 12));
    if (["heic", "heix", "hevc", "mif1", "msf1"].includes(brand)) return "image/heic";
    if (brand === "qt  ") return "video/quicktime";
    if (brand.startsWith("3g")) return "video/3gpp";
    return "video/mp4";
  }
  return null;
}

/**
 * Removes JPEG metadata segments (EXIF/GPS in APP1, IPTC in APP13, and the
 * other APPn blocks except APP0/JFIF and APP2/ICC colour). Customers text
 * photos of their homes; the file shouldn't carry where the home is.
 */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;
  const kept: Uint8Array[] = [bytes.slice(0, 2)];
  let offset = 2;
  while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1]!;
    // Start of scan: the rest is image data.
    if (marker === 0xda) break;
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2 || offset + 2 + length > bytes.length) return bytes;
    const isApp = marker >= 0xe0 && marker <= 0xef;
    const keep = !isApp || marker === 0xe0 || marker === 0xe2;
    if (keep) kept.push(bytes.slice(offset, offset + 2 + length));
    offset += 2 + length;
  }
  kept.push(bytes.slice(offset));
  const total = kept.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of kept) {
    out.set(part, cursor);
    cursor += part.byteLength;
  }
  return out;
}

type MediaEntry = { providerUrl?: string; contentType?: string; status?: string; objectId?: string; error?: string };

export async function loadPendingSmsMedia(context: DomainContext, input: { businessId: string; messageId: string }): Promise<Array<{ index: number; providerUrl: string; contentType: string }>> {
  return await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const row = (await tx.select({ media: messages.media }).from(messages).where(and(eq(messages.id, input.messageId), eq(messages.businessId, input.businessId))).limit(1))[0];
    const entries = (row?.media ?? []) as MediaEntry[];
    return entries.flatMap((entry, index) => entry.status === "pending" && entry.providerUrl ? [{ index, providerUrl: entry.providerUrl, contentType: entry.contentType ?? "" }] : []);
  });
}

async function updateMediaEntry(context: DomainContext, input: { businessId: string; messageId: string; index: number; entry: MediaEntry }): Promise<void> {
  await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    const row = (await tx.select({ media: messages.media }).from(messages).where(and(eq(messages.id, input.messageId), eq(messages.businessId, input.businessId))).for("update").limit(1))[0];
    const entries = [...((row?.media ?? []) as MediaEntry[])];
    if (!entries[input.index]) return;
    entries[input.index] = input.entry;
    await tx.update(messages).set({ media: entries as Array<Record<string, unknown>>, updatedAt: new Date() }).where(and(eq(messages.id, input.messageId), eq(messages.businessId, input.businessId)));
    await enqueueOutbox(tx, { topic: "realtime.publish", businessId: input.businessId, aggregateType: "message", aggregateId: input.messageId, dedupeKey: `message:${input.messageId}:media:${input.index}:${input.entry.status}`, payload: { type: "message.upserted", entityId: input.messageId } });
  });
}

/** Checks the bytes, strips metadata, stores the file privately and swaps the Twilio URL for our object id. */
export async function persistSmsMedia(
  context: DomainContext,
  input: { businessId: string; messageId: string; index: number; body: Uint8Array },
  storage: BinaryStorageProvider,
): Promise<{ stored: true; objectId: string } | { stored: false; reason: string }> {
  if (input.body.byteLength === 0 || input.body.byteLength > MAX_SMS_MEDIA_BYTES) {
    await updateMediaEntry(context, { ...input, entry: { status: "rejected", error: "size" } });
    return { stored: false, reason: "size" };
  }
  const contentType = sniffMediaType(input.body);
  const extension = contentType ? smsMediaExtension(contentType) : null;
  if (!contentType || !extension) {
    await updateMediaEntry(context, { ...input, entry: { status: "rejected", error: "type" } });
    return { stored: false, reason: "type" };
  }
  const body = contentType === "image/jpeg" ? stripJpegMetadata(input.body) : input.body;
  const objectId = randomUUID();
  const key = `${input.businessId}/sms-media/${input.messageId}/${objectId}.${extension}`;
  await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    await tx.insert(storageObjects).values({ id: objectId, businessId: input.businessId, objectKey: key, purpose: "sms_media", fileName: `photo-${input.index + 1}.${extension}`, contentType, contentLength: body.byteLength, status: "pending" });
  });
  await storage.putObject({ key, body, contentType });
  await withBusinessTransaction(context.db, { businessId: input.businessId, actorType: "worker" }, async (tx) => {
    await tx.update(storageObjects).set({ status: "ready", updatedAt: new Date() }).where(and(eq(storageObjects.id, objectId), eq(storageObjects.businessId, input.businessId)));
  });
  await updateMediaEntry(context, { ...input, entry: { status: "ready", objectId, contentType } });
  return { stored: true, objectId };
}

export async function markSmsMediaFailed(context: DomainContext, input: { businessId: string; messageId: string; index: number; reason: string }): Promise<void> {
  await updateMediaEntry(context, { ...input, entry: { status: "failed", error: input.reason.slice(0, 120) } });
}

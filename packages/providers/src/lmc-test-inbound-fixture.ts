import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { lmcProviderEventSchema, type LmcProviderEvent } from "@lobbystack/contracts";

/** Private local registry for cross-process HTTP integration tests; never HTTP input. */
export function loadLmcTestInboundFixture(path: string, env: Record<string, string | undefined>) {
  if (env.NODE_ENV !== "test" || process.env.NODE_ENV === "production") throw new Error("LMC_FAKE_FIXTURE_TEST_ONLY");
  if (!isAbsolute(path)) throw new Error("LMC_FAKE_FIXTURE_PRIVATE_FILE_REQUIRED");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let content: unknown;
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 262144 || (process.getuid && info.uid !== process.getuid())) throw new Error("LMC_FAKE_FIXTURE_PRIVATE_FILE_REQUIRED");
    try { content = JSON.parse(readFileSync(fd, "utf8")); } catch { throw new Error("LMC_FAKE_FIXTURE_INVALID"); }
  } finally { closeSync(fd); }
  if (!content || typeof content !== "object") throw new Error("LMC_FAKE_FIXTURE_INVALID");
  const value = content as { secret?: unknown; events?: unknown };
  if (typeof value.secret !== "string" || !/^[a-f0-9]{64}$/.test(value.secret) || !Array.isArray(value.events) || value.events.length > 32) throw new Error("LMC_FAKE_FIXTURE_INVALID");
  const events = new Map<string, LmcProviderEvent>();
  for (const entry of value.events) {
    if (!entry || typeof entry !== "object" || typeof entry.reference !== "string" || !/^[a-f0-9-]{36}$/.test(entry.reference) || events.has(entry.reference)) throw new Error("LMC_FAKE_FIXTURE_INVALID");
    const event = lmcProviderEventSchema.safeParse(entry.event);
    if (!event.success) throw new Error("LMC_FAKE_FIXTURE_INVALID");
    events.set(entry.reference, event.data);
  }
  return { secret: Buffer.from(value.secret, "hex"), events };
}

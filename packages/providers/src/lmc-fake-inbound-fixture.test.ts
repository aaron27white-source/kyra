import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";
import { FakeLmcInboundProvider } from "./lmc-fake-inbound";

it("loads only server-owned test fixtures and never trusts a signed client-supplied event", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lmc-inbound-fixture-")), file = join(directory, "fixture.json");
  const secret = randomBytes(32).toString("hex"), reference = randomUUID();
  const event = { kind: "message", id: randomUUID(), email: { from: "lead@example.invalid", to: "lead+fixture@inbound.example.invalid", subject: "Roof", text: "Roof repair", headers: {}, authentication: { spf: "pass", dkim: "pass", dmarc: "pass", aligned: true }, attachments: [] } };
  const save = (events: unknown[]) => writeFileSync(file, JSON.stringify({ secret, events }), { mode: 0o600 });
  const signed = (body: unknown) => {
    const rawBody = JSON.stringify(body), id = "fake-test", timestamp = String(Math.floor(Date.now()/1000));
    return { rawBody, headers: new Headers({ "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${createHmac("sha256", Buffer.from(secret,"hex")).update(`${id}.${timestamp}.${rawBody}`).digest("base64")}` }) };
  };
  try {
    save([]);
    const env = { NODE_ENV: "test", LMC_PROVIDER_MODE: "fake", LMC_FAKE_INBOUND_FIXTURE_FILE: file };
    const provider = new FakeLmcInboundProvider({ env });
    const prepared = provider.prepare(event);
    expect(await provider.verifyAndLoad({ rawBody: prepared.rawBody, headers: new Headers(prepared.headers) })).toEqual(event);
    save([{ reference, event }]); // Registered on the server after the fixture tenants exist.
    expect(await provider.verifyAndLoad(signed({ reference }))).toEqual(event);
    expect(await provider.verifyAndLoad(signed({ reference: randomUUID(), event }))).toBeNull();
    const forged = signed({ reference }); forged.headers.set("svix-signature", "v1,invalid");
    await expect(provider.verifyAndLoad(forged)).rejects.toThrow("INVALID_WEBHOOK_SIGNATURE");
    expect(() => new FakeLmcInboundProvider({ env: { ...env, NODE_ENV: "development" } })).toThrow("LMC_FAKE_FIXTURE_TEST_ONLY");
    expect(() => new FakeLmcInboundProvider({ env: { ...env, NODE_ENV: "production" } })).toThrow("PRODUCTION_REQUIRES_EXPLICIT_REAL_PROVIDERS");
    chmodSync(file, 0o644);
    await expect(provider.verifyAndLoad(signed({ reference }))).rejects.toThrow("LMC_FAKE_FIXTURE_PRIVATE_FILE_REQUIRED");
  } finally {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith("lmc-inbound-fixture-")) throw new Error("UNSAFE_FIXTURE_CLEANUP");
    rmSync(directory, { recursive: true, force: true });
  }
});

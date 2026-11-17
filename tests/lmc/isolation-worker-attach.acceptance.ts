import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { eq, inArray } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { businesses, calls, conversations } from "@lobbystack/db";
import { refreshBusinessSnapshot } from "@lobbystack/domain";
import { openLmcTestDatabase } from "./support/database";
import { startHealthServer } from "../../apps/worker/src/health";
import { createLiveCallHandler } from "../../apps/worker/src/liveCalls";
import { createVerifiedLiveAttachHandler } from "../../apps/worker/src/verifiedLiveAttach";

const external = vi.hoisted(() => ({
  sockets: [] as Array<EventEmitter & { sent: unknown[] }>,
  hangup: vi.fn(async () => undefined),
}));
// Only external OpenAI and Redis transports are fake. Controller, agent, snapshots,
// HTTP admission, role-specific transactions and durable call completion are real.
vi.mock("openai", () => ({
  default: class {
    live = { sessions: { hangup: external.hangup } };
  },
}));
vi.mock("openai/resources/live/sideband/ws", () => ({
  SidebandWS: class extends EventEmitter {
    sent: unknown[] = [];
    constructor() {
      super();
      external.sockets.push(this);
    }
    send(event: unknown) {
      this.sent.push(event);
      if ((event as { event_id?: string }).event_id === "kyra_initial_greeting") {
        this.emit("session.commentary.appended", { client_event_id: "kyra_initial_greeting" });
        this.emit("session.output_audio.delta", { delta: "fixture-audio" });
      }
    }
    async *stream() {
      yield { type: "open" };
    }
    close() {}
  },
}));
vi.mock("ioredis", () => ({
  default: class {
    async eval() {
      return 1;
    }
    async quit() {}
    disconnect() {}
  },
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  external.sockets.length = 0;
  external.hangup.mockClear();
});

it("binds real worker attaches to the canonical tenant, call, session, conversation and channel before deduplication", async () => {
  // Exercise the narrowly allowed pilot exception through the real verified
  // wrapper and real tenant-bound database admission.
  vi.stubEnv("LMC_PILOT_MODE", "true");
  vi.stubEnv("LIVE_PROTOTYPE_ENABLED", "true");
  vi.stubEnv("INTERNAL_SERVICE_TOKEN", "lmc-worker-acceptance-only-token");
  vi.stubEnv("OPENAI_API_KEY", "lmc-acceptance-synthetic-not-a-real-key");
  vi.stubEnv("AI_CHAT_API_KEY", "lmc-acceptance-synthetic-not-a-real-key");
  const originalFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      if (url.hostname !== "127.0.0.1")
        throw new Error("EXTERNAL_HTTP_FORBIDDEN");
      return originalFetch(input, init);
    },
  );
  const db = openLmcTestDatabase(),
    ids = [randomUUID(), randomUUID()];
  const context = { db: db.worker.db };
  const fixtures = ids.map((businessId, index) => ({
    businessId,
    callId: randomUUID(),
    conversationId: randomUUID(),
    sessionId: `lmc-session-${randomUUID()}`,
    channel: index ? ("voice" as const) : ("web_voice" as const),
  }));
  const live = createLiveCallHandler({ domain: context });
  const handler = createVerifiedLiveAttachHandler({
    domain: context,
    handle: live.handle,
  });
  const server = startHealthServer(
    0,
    { ready: true, redis: true, database: true, storage: true, activeJobs: 0 },
    handler,
  );
  try {
    for (const f of fixtures) {
      await db.admin.db.insert(businesses).values({
        id: f.businessId,
        slug: `worker-audit-${f.businessId}`,
        name: `Own Business ${f.businessId}`,
        timezone: "America/New_York",
        businessType: "service_company",
      });
      await db.admin.db.insert(conversations).values({
        id: f.conversationId,
        businessId: f.businessId,
        channel: f.channel,
      });
      await db.admin.db.insert(calls).values({
        id: f.callId,
        businessId: f.businessId,
        conversationId: f.conversationId,
        provider: "openai_live",
        providerCallId: f.sessionId,
        gatewaySessionId: f.sessionId,
        transport: f.channel,
        startedAt: new Date(),
        billingExcluded: true,
      });
      await refreshBusinessSnapshot(context, { businessId: f.businessId });
    }
    if (!server.listening) await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("MISSING_TEST_ADDRESS");
    const url = `http://127.0.0.1:${address.port}/internal/live/attach`;
    const request = async (
      body: unknown,
      token: string | undefined = "lmc-worker-acceptance-only-token",
      method = "POST",
    ) => {
      const response = await fetch(url, {
        method,
        headers: {
          "content-type": "application/json",
          ...(token ? { "x-internal-service-token": token } : {}),
        },
        ...(["GET", "HEAD"].includes(method)
          ? {}
          : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(5000),
      });
      await response.text();
      return response.status;
    };
    for (const f of fixtures) {
      expect(await request(f, "bad-token")).toBe(401);
      expect(await request(f, "")).toBe(401);
    }
    expect(external.sockets).toHaveLength(0);
    for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"])
      expect(await request(fixtures[0], undefined, method)).toBe(404);
    const [first, second] = fixtures as [
      (typeof fixtures)[number],
      (typeof fixtures)[number],
    ];
    for (const body of [
      { ...first, businessId: second.businessId },
      { ...first, callId: second.callId },
      { ...first, sessionId: second.sessionId },
      { ...first, conversationId: second.conversationId },
      { ...first, channel: "voice" },
      { ...second, businessId: first.businessId },
      { ...second, sessionId: first.sessionId },
      { ...second, conversationId: first.conversationId },
    ])
      expect(await request(body)).toBe(404);
    expect(external.sockets).toHaveLength(0);
    for (const raw of ["{", "null", "{}", "[]"]) {
      const bad = await fetch(url, {
        method: "POST",
        headers: {
          "x-internal-service-token": "lmc-worker-acceptance-only-token",
        },
        body: raw,
      });
      expect(bad.status).toBe(400);
      await bad.text();
    }
    const huge = await fetch(url, {
      method: "POST",
      headers: {
        "x-internal-service-token": "lmc-worker-acceptance-only-token",
      },
      body: "x".repeat(17000),
    });
    expect(huge.status).toBe(413);
    await huge.text();
    for (const f of fixtures) {
      expect(await request(f)).toBe(202);
      const socket = external.sockets.at(-1)!;
      socket.emit("session.started", {});
      expect(JSON.stringify(socket.sent)).toContain(f.businessId);
      expect(JSON.stringify(socket.sent)).not.toContain(
        fixtures.find((other) => other !== f)!.businessId,
      );
    }
    expect(external.sockets).toHaveLength(2);
    const [a, b] = fixtures as [
      (typeof fixtures)[number],
      (typeof fixtures)[number],
    ];
    const before = await db.admin.db
      .select()
      .from(calls)
      .where(inArray(calls.businessId, ids));
    const mismatches = [
      { ...a, businessId: b.businessId },
      { ...a, callId: b.callId },
      { ...a, sessionId: b.sessionId },
      { ...a, conversationId: b.conversationId },
      { ...a, channel: "voice" },
      { ...b, businessId: a.businessId },
      { ...b, callId: a.callId },
      { ...b, sessionId: a.sessionId },
      { ...b, conversationId: a.conversationId },
      { ...b, channel: "web_voice" },
      { ...a, callId: randomUUID() },
      { ...a, businessId: randomUUID() },
      { ...a, callId: "not-a-uuid" },
    ];
    for (const body of mismatches)
      expect(await request(body), JSON.stringify(body)).toBe(404);
    expect(external.sockets).toHaveLength(2);
    // Await the actual onStarted persistence before comparing subsequent rejected attempts.
    await vi.waitFor(async () =>
      expect(
        (
          await db.admin.db
            .select()
            .from(calls)
            .where(inArray(calls.businessId, ids))
        ).every((row) => row.mediaStartedAt !== null),
      ).toBe(true),
    );
    const settled = await db.admin.db
      .select()
      .from(calls)
      .where(inArray(calls.businessId, ids));
    for (const body of mismatches) expect(await request(body)).toBe(404);
    expect(
      await db.admin.db
        .select()
        .from(calls)
        .where(inArray(calls.businessId, ids)),
    ).toEqual(settled);
    expect(before.map((row) => row.id).sort()).toEqual(
      settled.map((row) => row.id).sort(),
    );
    for (const f of fixtures) expect(await request(f)).toBe(202);
    expect(external.sockets).toHaveLength(2);
    const originalA = settled.find((row) => row.id === a.callId)!;
    for (const change of [
      { status: "blocked" },
      { provider: "twilio" },
      { providerCallId: `wrong-${randomUUID()}` },
      { gatewaySessionId: `wrong-${randomUUID()}` },
      { endedAt: new Date() },
    ]) {
      await db.admin.db.update(calls).set(change).where(eq(calls.id, a.callId));
      expect(await request(a)).toBe(404);
      await db.admin.db
        .update(calls)
        .set({
          status: originalA.status,
          provider: originalA.provider,
          providerCallId: originalA.providerCallId,
          gatewaySessionId: originalA.gatewaySessionId,
          endedAt: originalA.endedAt,
        })
        .where(eq(calls.id, a.callId));
    }
    // A stored FK to another business is invalid even when the request repeats that FK.
    await db.admin.db
      .update(calls)
      .set({ conversationId: b.conversationId })
      .where(eq(calls.id, a.callId));
    expect(await request({ ...a, conversationId: b.conversationId })).toBe(404);
    await db.admin.db
      .update(calls)
      .set({ conversationId: a.conversationId })
      .where(eq(calls.id, a.callId));
    expect(await request({ ...a, conversationId: undefined })).toBe(202);
    await live.closeAll();
    expect(live.activeCalls()).toBe(0);
    expect(
      (
        await db.admin.db
          .select()
          .from(calls)
          .where(inArray(calls.businessId, ids))
      ).every((row) => row.endedAt !== null && row.status === "completed"),
    ).toBe(true);
    for (const f of fixtures) expect(await request(f)).toBe(404);
    expect(external.sockets).toHaveLength(2);
    vi.stubEnv("LIVE_PROTOTYPE_ENABLED", "false");
    for (const method of [
      "GET",
      "HEAD",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS",
    ])
      expect(await request(a, undefined, method)).toBe(404);
  } finally {
    await live.closeAll();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
    await db.admin.db.transaction(async (tx) => {
      // Parent locks serialize any late outbox writer before queue/parent removal.
      const { sql } = await import("drizzle-orm");
      for (const id of ids)
        await tx.execute(
          sql`select id from businesses where id=${id}::uuid for update`,
        );
      for (const id of ids)
        await tx.execute(
          sql`delete from outbox_messages where business_id=${id}::uuid`,
        );
      await tx.delete(businesses).where(inArray(businesses.id, ids));
    });
    await db.close();
  }
}, 30_000);

import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeLmcProviders, lmcProviderMode } from "./lmc-fakes";

afterEach(() => vi.unstubAllGlobals());
const outgoing = (tenantId = "tenant-a") => ({ tenantId, leadId: "lead-a", idempotencyKey: "event-a:reply", kind: "reply" as const, from: "roof@example.invalid", to: "lead@example.invalid", replyTo: "reply+opaque@example.invalid", subject: "Roof repair", text: "What is your ZIP?", headers: { "Message-ID": "<event-a@example.invalid>" } });

describe("fake provider defaults", () => {
  it("defaults development and tests to fake, and fails closed on incomplete production configuration", () => {
    expect(lmcProviderMode({ NODE_ENV: "development" })).toBe("fake");
    expect(lmcProviderMode({ NODE_ENV: "test", RESEND_API_KEY: "an-unused-test-key" })).toBe("fake");
    expect(() => lmcProviderMode({ NODE_ENV: "production" })).toThrow();
    expect(() => lmcProviderMode({ NODE_ENV: "production", LMC_PROVIDER_MODE: "fake" })).toThrow();
    expect(() => lmcProviderMode({ LMC_PROVIDER_MODE: "typo" })).toThrow();
    expect(lmcProviderMode({ NODE_ENV: "production", LMC_PROVIDER_MODE: "real" })).toBe("real");
  });
  it("deduplicates concurrent email delivery within a tenant without suppressing another tenant", async () => {
    const { email } = createFakeLmcProviders();
    const [a,b] = await Promise.all([email.send(outgoing()), email.send(outgoing())]);
    expect(a).toEqual(b); expect(email.records).toHaveLength(1);
    await email.send(outgoing("tenant-b")); expect(email.records).toHaveLength(2);
    await expect(email.send({ ...outgoing(), text: "Different request with same key" })).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  });
  it("rejects outbound header injection before recording or delivering anything", async () => {
    const { email } = createFakeLmcProviders();
    await expect(email.send({ ...outgoing(), subject: "Hi\r\nBcc: other@example.invalid" })).rejects.toThrow();
    await expect(email.send({ ...outgoing(), headers: { ...outgoing().headers, "In-Reply-To": "<id@example.invalid>\r\nX-Injected: yes" } })).rejects.toThrow();
    expect(email.records).toHaveLength(0);
  });
  it("runs every fake transport without making a network request", async () => {
    const fetch = vi.fn(() => { throw new Error("No network is permitted"); }); vi.stubGlobal("fetch", fetch);
    const providers = createFakeLmcProviders();
    await providers.email.send(outgoing());
    await providers.sms.sendMessage({ businessId: "tenant-a", to: "+13055550100", from: "+13055550101", body: "Test" });
    await providers.voice.startCall({ tenantId: "tenant-a", to: "+13055550100", idempotencyKey: "call-a" });
    providers.calendar.authorizeCalendar("calendar-a");
    await providers.calendar.getBusyBlocks({ accessToken: "fake", calendarId: "calendar-a", startsAt: "2030-01-01T00:00:00Z", endsAt: "2030-01-02T00:00:00Z" });
    await providers.model.analyze({ tenantId: "tenant-a", trustedInstructions: "Extract facts only", business: { services: [{ name: "roof repair", aliases: [] }], tone: "professional" }, untrusted: { message: { id: "one", subject: "Roof", text: "Residential roof repair in ZIP 33101" }, history: [] } });
    expect(fetch).not.toHaveBeenCalled();
    expect(providers.sms.records).toHaveLength(1); expect(providers.voice.records).toHaveLength(1); expect(providers.model.calls).toHaveLength(1);
  });
  it("keeps calendar retries idempotent and rejects an unconfigured calendar", async () => {
    const { calendar } = createFakeLmcProviders(); calendar.authorizeCalendar("calendar-a");
    const event = { accessToken: "fake", calendarId: "calendar-a", clientEventId: "appointment-a", title: "Visit", startsAt: "2030-01-01T14:00:00Z", endsAt: "2030-01-01T15:00:00Z" };
    expect(await calendar.upsertEvent(event)).toEqual(await calendar.upsertEvent(event));
    expect(calendar.events).toHaveLength(1);
    await expect(calendar.getBusyBlocks({ ...event, calendarId: "calendar-b" })).rejects.toThrow();
    expect(calendar.unauthorizedCalls).toHaveLength(1);
  });
});

import { demoSnapshot, type BookingMode, type BusinessContextSnapshot } from "@lobbystack/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const domainMocks = vi.hoisted(() => ({ bookForCaller: vi.fn(), findOpenings: vi.fn(), lookupCallerAppointments: vi.fn() }));
vi.mock("@lobbystack/domain", () => ({ bookForCaller: domainMocks.bookForCaller, findOpenings: domainMocks.findOpenings, lookupCallerAppointments: domainMocks.lookupCallerAppointments }));

import { createReceptionistTools, type AgentToolContext } from "./tools";

function toolNames(overrides: Partial<AgentToolContext> & { bookingMode?: BookingMode; snapshot?: Partial<BusinessContextSnapshot> } = {}): string[] {
  const { bookingMode, snapshot, ...context } = overrides;
  return Object.keys(createReceptionistTools({
    domain: { db: {} as never },
    channel: "web_chat",
    ...context,
    snapshot: { ...demoSnapshot, ...snapshot, ...(bookingMode ? { bookingMode } : {}) },
  })).sort();
}

const callControl = { transfer: vi.fn(async () => true), hangup: vi.fn(async () => undefined) };

const offeredStartsAt = "2030-01-01T15:00:00.000Z";
beforeEach(() => {
  vi.clearAllMocks();
  domainMocks.findOpenings.mockResolvedValue({ ok: true, serviceName: "HVAC maintenance", date: "2030-01-01", timezone: "America/Toronto", openings: [{ startsAt: offeredStartsAt, displayTime: "Tuesday Jan 1, 10:00 AM" }] });
});

async function offerSlot(tools: ReturnType<typeof createReceptionistTools>) {
  const execute = tools.findAvailability!.execute! as (input: object, options: object) => Promise<unknown>;
  await execute({ serviceName: "HVAC maintenance", date: "2030-01-01" }, { toolCallId: "offer", messages: [] });
}

describe("createReceptionistTools", () => {
  it("uses trusted Caller ID by default and keeps SMS consent independent", async () => {
    domainMocks.bookForCaller.mockResolvedValue({ ok: true, appointmentId: "apt_1", serviceName: "HVAC maintenance", startsAt: "2030-01-01T15:00:00.000Z" });
    const tools = createReceptionistTools({ domain: { db: {} as never }, channel: "voice", callerPhone: "+14165550100", snapshot: demoSnapshot });
    await offerSlot(tools);
    const execute = tools.bookAppointment!.execute! as (input: object, options: object) => Promise<unknown>;
    await expect(execute({ serviceName: "HVAC maintenance", startsAt: "2030-01-01T15:00:00.000Z", smsConsentGranted: false }, { toolCallId: "1", messages: [] })).resolves.toMatchObject({ ok: true });
    expect(domainMocks.bookForCaller).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ contactPhone: "+14165550100", smsConsentGranted: false }));
  });

  it("retains address fields across corrected attempts and suppresses an unchanged failed booking", async () => {
    domainMocks.bookForCaller.mockResolvedValueOnce({ ok: false, reasonCode: "invalid_service_address", validationIssues: [{ field: "postalCode", code: "invalid_postal_code" }] }).mockResolvedValueOnce({ ok: true, appointmentId: "apt_fixed" });
    const tools = createReceptionistTools({ domain: { db: {} as never }, channel: "voice", callerPhone: "+14165550100", snapshot: demoSnapshot });
    await offerSlot(tools);
    const execute = tools.bookAppointment!.execute! as (input: object, options: object) => Promise<unknown>;
    const booking = { serviceName: "HVAC maintenance", startsAt: offeredStartsAt, smsConsentGranted: false };
    const address = { line1: "123 Main Street", city: "Miami", country: "United States", postalCode: "bad" };
    await expect(execute({ ...booking, serviceLocation: address }, { toolCallId: "first", messages: [] })).resolves.toMatchObject({ ok: false });
    await execute({ ...booking, serviceLocation: address }, { toolCallId: "retry", messages: [] });
    expect(domainMocks.bookForCaller).toHaveBeenCalledTimes(1);
    await expect(execute({ ...booking, serviceLocation: { postalCode: "33101" } }, { toolCallId: "corrected", messages: [] })).resolves.toMatchObject({ ok: true });
    expect(domainMocks.bookForCaller).toHaveBeenCalledTimes(2);
    expect(domainMocks.bookForCaller).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ intake: { serviceLocation: { ...address, postalCode: "33101" } } }));
  });

  it("normalizes an explicitly selected alternate phone but rejects the business DID", async () => {
    domainMocks.bookForCaller.mockResolvedValue({ ok: true, appointmentId: "apt_2", serviceName: "HVAC maintenance", startsAt: offeredStartsAt });
    const tools = createReceptionistTools({ domain: { db: {} as never }, channel: "voice", callerPhone: "+14165550100", snapshot: { ...demoSnapshot, contactChannels: { ...demoSnapshot.contactChannels, phoneNumber: "+17542191002" } } });
    await offerSlot(tools);
    const execute = tools.bookAppointment!.execute! as (input: object, options: object) => Promise<unknown>;
    const input = { serviceName: "HVAC maintenance", startsAt: offeredStartsAt, smsConsentGranted: false };
    await expect(execute({ ...input, contactPhone: "754 219 1003" }, { toolCallId: "2", messages: [] })).resolves.toMatchObject({ ok: true });
    expect(domainMocks.bookForCaller).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ contactPhone: "+17542191003" }));
    await expect(execute({ ...input, contactPhone: "7542191002" }, { toolCallId: "3", messages: [] })).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("business line") });
    expect(domainMocks.bookForCaller).toHaveBeenCalledTimes(1);
  });

  it("asks for a number only when both valid Caller ID and an approved alternate are absent", async () => {
    const tools = createReceptionistTools({ domain: { db: {} as never }, channel: "voice", snapshot: demoSnapshot });
    await offerSlot(tools);
    const execute = tools.bookAppointment!.execute! as (input: object, options: object) => Promise<unknown>;
    await expect(execute({ serviceName: "HVAC maintenance", startsAt: "2030-01-01T15:00:00.000Z", smsConsentGranted: false }, { toolCallId: "4", messages: [] })).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("callback number") });
    expect(domainMocks.bookForCaller).not.toHaveBeenCalled();
  });

  it("does not repeat an unchanged availability lookup within the same call", async () => {
    domainMocks.findOpenings.mockResolvedValue({ ok: true, serviceName: "HVAC maintenance", openings: [{ startsAt: "2030-01-01T15:00:00.000Z" }] });
    const tools = createReceptionistTools({ domain: { db: {} as never }, channel: "voice", snapshot: demoSnapshot });
    const execute = tools.findAvailability!.execute! as (input: object, options: object) => Promise<unknown>;
    const input = { serviceName: "HVAC maintenance", date: "2030-01-01" };
    await execute(input, { toolCallId: "5", messages: [] });
    await execute(input, { toolCallId: "6", messages: [] });
    expect(domainMocks.findOpenings).toHaveBeenCalledTimes(1);
  });

  it("accepts the canonical service name returned for an offered service alias", async () => {
    domainMocks.bookForCaller.mockResolvedValue({ ok: true, appointmentId: "apt_alias" });
    const tools = createReceptionistTools({ domain: { db: {} as never }, channel: "voice", callerPhone: "+14165550100", snapshot: demoSnapshot });
    const find = tools.findAvailability!.execute! as (input: object, options: object) => Promise<unknown>;
    await find({ serviceName: "hvac-maintenance", date: "2030-01-01" }, { toolCallId: "alias", messages: [] });
    const book = tools.bookAppointment!.execute! as (input: object, options: object) => Promise<unknown>;
    await expect(book({ serviceName: "HVAC maintenance", startsAt: offeredStartsAt, smsConsentGranted: false }, { toolCallId: "book-alias", messages: [] })).resolves.toMatchObject({ ok: true });
    expect(domainMocks.bookForCaller).toHaveBeenCalledTimes(1);
  });

  it("checks the revised preferred time instead of reusing a mismatched availability result", async () => {
    domainMocks.findOpenings.mockResolvedValue({ ok: true, serviceName: "HVAC maintenance", openings: [
      { startsAt: "2030-01-01T14:00:00.000Z", displayTime: "9 AM" },
      { startsAt: "2030-01-01T17:00:00.000Z", displayTime: "12 PM" },
      { startsAt: "2030-01-01T20:00:00.000Z", displayTime: "3 PM" },
    ] });
    const tools = createReceptionistTools({ domain: { db: {} as never }, channel: "voice", snapshot: demoSnapshot });
    const execute = tools.findAvailability!.execute! as (input: object, options: object) => Promise<{ openings: Array<{ startsAt: string }> }>;
    await execute({ serviceName: "HVAC maintenance", date: "2030-01-01", preferredTime: "09:00" }, { toolCallId: "7", messages: [] });
    const revised = await execute({ serviceName: "HVAC maintenance", date: "2030-01-01", preferredTime: "15:00" }, { toolCallId: "8", messages: [] });
    expect(domainMocks.findOpenings).toHaveBeenCalledTimes(2);
    expect(domainMocks.findOpenings).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({ preferredHour24: 15 }));
    expect(revised.openings[0]?.startsAt).toBe("2030-01-01T14:00:00.000Z");
  });

  it("books directly by default", () => {
    expect(toolNames()).toEqual(["bookAppointment", "findAvailability", "getBusinessHours", "getBusinessServices", "searchKnowledge", "takeMessage"]);
  });

  it("takes requests instead of booking in request mode", () => {
    const names = toolNames({ bookingMode: "request" });
    expect(names).toContain("requestAppointment");
    expect(names).not.toContain("bookAppointment");
    expect(names).not.toContain("findAvailability");
  });

  it("offers no booking actions when booking is off", () => {
    const names = toolNames({ bookingMode: "off", channel: "voice", callerPhone: "+14165550100" });
    expect(names).toEqual(["getBusinessHours", "searchKnowledge", "takeMessage"]);
  });

  it("exposes only read-only business intelligence to email reasoning", () => {
    expect(toolNames({ channel: "email", toolPolicy: "information" })).toEqual([
      "getBusinessHours",
      "getBusinessServices",
      "searchKnowledge",
    ]);
  });

  it("offers appointment changes only when the call carries the caller's number", () => {
    expect(toolNames({ channel: "web_voice" })).not.toContain("cancelAppointment");
    expect(toolNames({ channel: "voice", callerPhone: "+14165550100" })).toEqual(expect.arrayContaining(["lookupAppointmentForChange", "verifyAppointmentForChange", "cancelAppointment", "rescheduleAppointment"]));
  });

  it("suppresses an unchanged failed appointment lookup and retries when a fact changes", async () => {
    domainMocks.lookupCallerAppointments.mockResolvedValue({ ok: true, reason: "no_match", matchingAppointmentCount: 0, matchingStrategy: "appointment_facts" });
    const tools = createReceptionistTools({ domain: { db: {} as never }, channel: "voice", callerPhone: "+14165550100", snapshot: demoSnapshot });
    const execute = tools.lookupAppointmentForChange!.execute! as (input: object, options: object) => Promise<Record<string, unknown>>;
    const base = { callerName: "João", appointmentStartsAt: "November 18, 2026", serviceName: "AC Repair" };
    await execute(base, { toolCallId: "lookup-1", messages: [] });
    await expect(execute(base, { toolCallId: "lookup-2", messages: [] })).resolves.toMatchObject({ repeatSuppressed: true, reasonCode: "unchanged_query" });
    expect(domainMocks.lookupCallerAppointments).toHaveBeenCalledTimes(1);
    await execute({ ...base, serviceName: "HVAC Repair" }, { toolCallId: "lookup-3", messages: [] });
    expect(domainMocks.lookupCallerAppointments).toHaveBeenCalledTimes(2);
  });

  it("reports lookup system errors separately from a no-match result", async () => {
    domainMocks.lookupCallerAppointments.mockRejectedValue(new Error("database unavailable"));
    const tools = createReceptionistTools({ domain: { db: {} as never }, channel: "voice", callerPhone: "+14165550100", snapshot: demoSnapshot });
    const execute = tools.lookupAppointmentForChange!.execute! as (input: object, options: object) => Promise<Record<string, unknown>>;
    await expect(execute({ callerName: "João", serviceName: "AC Repair" }, { toolCallId: "lookup-error", messages: [] })).resolves.toMatchObject({ ok: false, reasonCode: "system_error" });
  });

  it("offers transfer and hang-up only on calls it can control", () => {
    expect(toolNames({ channel: "web_voice" })).not.toContain("transferCall");
    expect(toolNames({ channel: "voice", callControl })).toEqual(expect.arrayContaining(["transferCall", "endCall"]));
  });

  it("limits prospect demos to answering questions and taking messages", () => {
    expect(toolNames({ channel: "web_voice", intakeOnly: true, callControl })).toEqual(["endCall", "getBusinessHours", "searchKnowledge", "takeMessage"]);
  });

  it("uses the voice snapshot rather than a repeated service-discovery delegation", () => {
    expect(toolNames({ channel: "voice" })).not.toContain("getBusinessServices");
    expect(toolNames({ channel: "web_chat" })).toContain("getBusinessServices");
  });

  it("offers hang-up but not transfer on browser calls", () => {
    const names = toolNames({ channel: "web_voice", callControl: { hangup: vi.fn() } });
    expect(names).toContain("endCall");
    expect(names).not.toContain("transferCall");
  });

  it("logs the reason and identifiers when the agent invokes endCall", async () => {
    const hangup = vi.fn(async () => undefined);
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const tools = createReceptionistTools({ domain: { db: {} as never }, channel: "voice", callId: "call_1", sessionId: "live_1", callControl: { hangup }, snapshot: demoSnapshot });
    const execute = tools.endCall!.execute! as (input: object, options: object) => Promise<unknown>;

    await expect(execute({ reason: "caller_finished" }, { toolCallId: "end_1", messages: [] })).resolves.toEqual({ ok: true });

    expect(hangup).toHaveBeenCalledWith("caller_finished");
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"event":"live.end_call_tool.invoked","operation":"end_call"'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"reason":"caller_finished","callId":"call_1","sessionId":"live_1"'));
    log.mockRestore();
  });

  it("refuses a transfer the rules don't allow", async () => {
    const tools = createReceptionistTools({
      domain: { db: {} as never },
      channel: "voice",
      callControl,
      snapshot: { ...demoSnapshot, transferPolicy: { mode: "on_request", transferNumber: "+14165550199" } },
    });
    const execute = tools.transferCall!.execute! as (input: object, options: object) => Promise<unknown>;
    await expect(execute({ callerRequested: false, urgent: false }, { toolCallId: "1", messages: [] })).resolves.toMatchObject({ ok: false });
    expect(callControl.transfer).not.toHaveBeenCalled();
    await expect(execute({ callerRequested: true, urgent: false }, { toolCallId: "2", messages: [] })).resolves.toMatchObject({ ok: true });
    expect(callControl.transfer).toHaveBeenCalledWith("+14165550199");
  });
});

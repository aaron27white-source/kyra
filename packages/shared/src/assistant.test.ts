import { describe, expect, it } from "vitest";

import { EMERGENCY_REPLY, detectEmergency, guessLanguage, isAffirmativeReply, isWithinContactWindow, localMinutes, missedCallGreeting, renderTextBack, tierAllows } from "./assistant";

describe("tierAllows", () => {
  it("gives each tier its own features and everything below it", () => {
    const t1 = { serviceTier: "missed_call" }, t2 = { serviceTier: "receptionist" }, t3 = { serviceTier: "assistant" };
    expect(tierAllows(t1, "voice_callback")).toBe(true);
    expect(tierAllows(t1, "live_receptionist")).toBe(false);
    expect(tierAllows(t1, "outbound_automations")).toBe(false);
    expect(tierAllows(t2, "live_receptionist")).toBe(true);
    expect(tierAllows(t2, "outbound_automations")).toBe(false);
    expect(tierAllows(t3, "outbound_automations")).toBe(true);
    expect(tierAllows(t3, "missed_call_text")).toBe(true);
  });

  it("treats Back Office as an add-on on any tier, never implied by a tier", () => {
    expect(tierAllows({ serviceTier: "assistant" }, "back_office")).toBe(false);
    expect(tierAllows({ serviceTier: "missed_call", backOfficeEnabled: true }, "back_office")).toBe(true);
  });

  it("falls back to the lowest tier for an unknown value", () => {
    expect(tierAllows({ serviceTier: "platinum" }, "live_receptionist")).toBe(false);
    expect(tierAllows({ serviceTier: "platinum" }, "missed_call_text")).toBe(true);
  });
});

describe("detectEmergency", () => {
  it.each([
    ["I smell gas in the kitchen", "gas"],
    ["there's a GAS LEAK by the water heater", "gas"],
    ["huele a gas en la cocina", "gas"],
    ["the outlet is sparking", "electrical"],
    ["water in the breaker panel", "electrical"],
    ["hay chispas en el enchufe", "electrical"],
    ["smoke coming from the furnace", "fire"],
    ["sewage backing up into the tub", "sewage"],
    ["our CO alarm is going off", "carbon_monoxide"],
  ])("flags %j as %s", (text, kind) => {
    expect(detectEmergency(text)).toBe(kind);
  });

  it.each(["my sink is clogged", "water heater is leaking a little", "can you come tomorrow morning?", "the AC is blowing warm air"])("leaves %j alone", (text) => {
    expect(detectEmergency(text)).toBeNull();
  });

  it("has fixed wording in both languages that always says to call 911", () => {
    expect(EMERGENCY_REPLY.en).toContain("911");
    expect(EMERGENCY_REPLY.es).toContain("911");
  });
});

describe("isAffirmativeReply", () => {
  it.each(["YES", "yes!", "Sí", "si", "ok", "Call me"])("accepts %j", (text) => expect(isAffirmativeReply(text)).toBe(true));
  it.each(["yes but not now", "no", "maybe", "who is this", "STOP"])("rejects %j", (text) => expect(isAffirmativeReply(text)).toBe(false));
});

describe("guessLanguage", () => {
  it("spots Spanish and defaults to English", () => {
    expect(guessLanguage("Hola, tengo una fuga en el baño")).toBe("es");
    expect(guessLanguage("Hi, my toilet is running")).toBe("en");
  });
});

describe("contact window", () => {
  it("uses the business's local time, not UTC", () => {
    // 2026-07-01 13:30 UTC is 08:30 in Houston (CDT, UTC-5).
    const now = new Date("2026-07-01T13:30:00Z");
    expect(localMinutes(now, "America/Chicago")).toBe(8 * 60 + 30);
    expect(isWithinContactWindow(now, "America/Chicago", { startMinutes: 480, endMinutes: 1200 })).toBe(true);
    expect(isWithinContactWindow(new Date("2026-07-01T12:30:00Z"), "America/Chicago", { startMinutes: 480, endMinutes: 1200 })).toBe(false);
    expect(isWithinContactWindow(new Date("2026-07-02T01:00:00Z"), "America/Chicago", { startMinutes: 480, endMinutes: 1200 })).toBe(false);
  });
});

describe("renderTextBack", () => {
  const base = { businessName: "Bayou Test Plumbing", voiceCallbackEnabled: false, callbackMode: "ask_first" as const, photoRequestsEnabled: true };

  it("always keeps the opt-out line, even with custom wording", () => {
    expect(renderTextBack({ ...base, customMessage: "Hey from {business}!" }, "en")).toBe("Hey from Bayou Test Plumbing! You can text photos of the problem to this number. Reply STOP to opt out.");
    expect(renderTextBack(base, "es")).toContain("Responda STOP");
  });

  it("offers the AI call only in ask-first mode with voice on", () => {
    expect(renderTextBack({ ...base, voiceCallbackEnabled: true }, "en")).toContain("Reply YES");
    expect(renderTextBack({ ...base, voiceCallbackEnabled: true, callbackMode: "automatic" }, "en")).not.toContain("Reply YES");
    expect(renderTextBack(base, "en")).not.toContain("Reply YES");
  });
});

describe("missedCallGreeting", () => {
  it("announces the callback only in automatic mode", () => {
    expect(missedCallGreeting({ businessName: "X", voiceCallbackEnabled: true, callbackMode: "automatic" })).toContain("call you back");
    expect(missedCallGreeting({ businessName: "X", voiceCallbackEnabled: true, callbackMode: "ask_first" })).not.toContain("call you back");
  });
});

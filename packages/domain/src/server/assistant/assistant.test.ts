import { describe, expect, it } from "vitest";

import { formatCents, renderTemplate } from "./automations";
import { parseLineItems } from "./backOffice";
import { openingState } from "./hours";
import { sniffMediaType, stripJpegMetadata } from "./media";
import { isTextableCaller } from "./missedCalls";
import { parseAssistantSettingsPatch } from "./settings";

const HOUSTON = "America/Chicago";
// Monday to Friday, 8:00–17:00. dayOfWeek 0 = Sunday.
const WEEKDAYS = [1, 2, 3, 4, 5].map((dayOfWeek) => ({ dayOfWeek, openMinutes: 8 * 60, closeMinutes: 17 * 60 }));

describe("openingState", () => {
  it("is open inside hours, in the business's time zone", () => {
    // Wednesday 2026-07-01 15:00 UTC = 10:00 in Houston.
    expect(openingState(new Date("2026-07-01T15:00:00Z"), HOUSTON, WEEKDAYS, [])).toEqual({ open: true, nextOpenAt: null });
  });

  it("points at the next morning after closing time", () => {
    // Wednesday 19:00 Houston (00:00 UTC Thursday).
    const state = openingState(new Date("2026-07-02T00:00:00Z"), HOUSTON, WEEKDAYS, []);
    expect(state.open).toBe(false);
    expect(state.nextOpenAt?.toISOString()).toBe("2026-07-02T13:00:00.000Z");
  });

  it("skips the weekend", () => {
    // Saturday 2026-07-04 noon Houston.
    const state = openingState(new Date("2026-07-04T17:00:00Z"), HOUSTON, WEEKDAYS, []);
    expect(state.nextOpenAt?.toISOString()).toBe("2026-07-06T13:00:00.000Z");
  });

  it("lets a closure win over weekly hours", () => {
    const closure = { startsAt: new Date("2026-07-01T05:00:00Z"), endsAt: new Date("2026-07-02T05:00:00Z") };
    const state = openingState(new Date("2026-07-01T15:00:00Z"), HOUSTON, WEEKDAYS, [closure]);
    expect(state.open).toBe(false);
    expect(state.nextOpenAt?.toISOString()).toBe("2026-07-02T13:00:00.000Z");
  });

  it("has no next opening when no hours are set", () => {
    expect(openingState(new Date(), HOUSTON, [], [])).toEqual({ open: false, nextOpenAt: null });
  });
});

describe("isTextableCaller", () => {
  it("rejects withheld and malformed caller IDs", () => {
    expect(isTextableCaller("+17135550123")).toBe(true);
    expect(isTextableCaller("+266696687")).toBe(false);
    expect(isTextableCaller("anonymous")).toBe(false);
    expect(isTextableCaller("7135550123")).toBe(false);
  });
});

describe("media checks", () => {
  it("identifies files by their bytes, not their claimed type", () => {
    expect(sniffMediaType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffMediaType(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe("image/png");
    expect(sniffMediaType(new TextEncoder().encode("<html><script>"))).toBeNull();
  });

  it("strips EXIF/GPS (APP1) from a JPEG and keeps the image data", () => {
    const app0 = [0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46];
    const exif = [0xff, 0xe1, 0x00, 0x08, ...new TextEncoder().encode("GPS!AB")];
    const scan = [0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9];
    const jpeg = new Uint8Array([0xff, 0xd8, ...app0, ...exif, ...scan]);
    const out = stripJpegMetadata(jpeg);
    expect(Array.from(out)).toEqual([0xff, 0xd8, ...app0, ...scan]);
    expect(new TextDecoder().decode(out)).not.toContain("GPS");
  });

  it("leaves a malformed JPEG untouched rather than corrupting it", () => {
    const broken = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]);
    expect(stripJpegMetadata(broken)).toBe(broken);
  });
});

describe("settings validation", () => {
  it("rejects unknown fields and bad values", () => {
    expect(() => parseAssistantSettingsPatch({ isAdmin: true })).toThrow(/Unknown settings/);
    expect(() => parseAssistantSettingsPatch({ callbackMode: "always" })).toThrow();
    expect(() => parseAssistantSettingsPatch({ emergencyPhone: "713-555-0123" })).toThrow(/E.164/);
    expect(() => parseAssistantSettingsPatch({ reviewUrl: "http://example.com" })).toThrow(/https/);
    expect(() => parseAssistantSettingsPatch({ callbackDelaySeconds: 5000 })).toThrow();
  });

  it("accepts a valid patch", () => {
    expect(parseAssistantSettingsPatch({ voiceCallbackEnabled: true, callbackMode: "automatic", emergencyPhone: "+17135550123" })).toEqual({ voiceCallbackEnabled: true, callbackMode: "automatic", emergencyPhone: "+17135550123" });
  });
});

describe("automation text", () => {
  it("fills placeholders and always ends with the opt-out line", () => {
    expect(renderTemplate("Hi {name}, it's {business}.", { name: "Ana", business: "Bayou Test Plumbing" })).toBe("Hi Ana, it's Bayou Test Plumbing. Reply STOP to opt out.");
    expect(renderTemplate("Hi {name}, thanks. Reply STOP to opt out.", { name: "" })).toBe("Hi, thanks. Reply STOP to opt out.");
    expect(formatCents(12_550)).toBe("$125.50");
  });
});

describe("line items", () => {
  it("totals in whole cents and rejects nonsense", () => {
    expect(parseLineItems([{ description: "Drain snake", quantity: 1, unitCents: 18_900 }, { description: "Trip fee", quantity: 2, unitCents: 2_500 }]).totalCents).toBe(23_900);
    expect(() => parseLineItems([])).toThrow();
    expect(() => parseLineItems([{ description: "x", quantity: -1, unitCents: 100 }])).toThrow();
    expect(() => parseLineItems([{ description: "x", quantity: 1, unitCents: 1.5 }])).toThrow();
  });
});

import { describe, expect, it } from "vitest";

import { hoursDraftFromWindows, hoursWindowsFromDraft } from "./live-business-settings-surface";

describe("business hours editor", () => {
  it("round-trips canonical weekday windows and keeps closed days absent", () => {
    const canonical = [
      { dayOfWeek: 1, openMinutes: 8 * 60 + 30, closeMinutes: 17 * 60 },
      { dayOfWeek: 5, openMinutes: 9 * 60, closeMinutes: 15 * 60 + 30 },
    ];
    const draft = hoursDraftFromWindows(canonical);
    expect(draft[0]?.enabled).toBe(false);
    expect(draft[1]).toEqual({ enabled: true, opens: "08:30", closes: "17:00" });
    expect(hoursWindowsFromDraft(draft)).toEqual(canonical);
  });
});

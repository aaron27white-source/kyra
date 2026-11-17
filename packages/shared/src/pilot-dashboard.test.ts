import { describe, expect, it } from "vitest";

import {
  hasPilotDashboardCapability,
  pilotDashboardCapabilityForPath,
  pilotDashboardCapabilityIds,
} from "./pilot-dashboard";

describe("pilot dashboard capabilities", () => {
  it.each([
    ["/leads", "leads"],
    ["/settings/email", "email_settings"],
    ["/settings/business", "business_profile"],
    ["/integrations", "integrations"],
    ["/agent/services", "services"],
    ["/agent/knowledge", "knowledge"],
    ["/agent", "voice"],
    ["/agent/rules", "voice"],
    ["/calls", "voice"],
    ["/appointments", "voice"],
    ["/calls/00000000-0000-4000-8000-000000000001", "voice"],
    ["/contacts", "contacts"],
    ["/contacts/713b15f6-85ec-47b2-b8dd-e06be2c7690b", "contacts"],
  ] as const)("maps %s to %s", (path, capability) => {
    expect(pilotDashboardCapabilityForPath(path)).toBe(capability);
  });

  it("does not grant an unreviewed route or capability", () => {
    expect(pilotDashboardCapabilityForPath("/settings/api-keys")).toBeUndefined();
    expect(pilotDashboardCapabilityForPath("/contacts/not-a-uuid")).toBeUndefined();
    expect(hasPilotDashboardCapability(["leads"], "knowledge")).toBe(false);
    expect(new Set(pilotDashboardCapabilityIds).size).toBe(pilotDashboardCapabilityIds.length);
  });
});

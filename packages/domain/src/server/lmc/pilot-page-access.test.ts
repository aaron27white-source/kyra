import { describe, expect, it } from "vitest";
import { resolveLmcPilotDashboardCapabilities } from "./pilot-page-access";

describe("LMC pilot voice capability", () => {
  it("makes reviewed integration settings available in configured workspaces", () => {
    expect(resolveLmcPilotDashboardCapabilities({ businessStatus: "draft" })).toContain("integrations");
    expect(resolveLmcPilotDashboardCapabilities({ businessStatus: "active" })).toContain("integrations");
  });

  it("keeps voice pages hidden unless an administrator has enabled inbound voice for the tenant", () => {
    expect(resolveLmcPilotDashboardCapabilities({ businessStatus: "active" })).not.toContain("voice");
    expect(resolveLmcPilotDashboardCapabilities({ businessStatus: "active", voiceEnabled: false })).not.toContain("voice");
    expect(resolveLmcPilotDashboardCapabilities({ businessStatus: "active", voiceEnabled: true })).toContain("voice");
  });

  it("does not expose customer/contact surfaces early just because voice is enabled", () => {
    const capabilities = resolveLmcPilotDashboardCapabilities({ businessStatus: "draft", voiceEnabled: true });
    expect(capabilities).toContain("voice");
    expect(capabilities).not.toContain("contacts");
  });
});

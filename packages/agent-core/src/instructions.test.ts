import { demoSnapshot } from "@lobbystack/shared";
import { describe, expect, it } from "vitest";
import { buildAgentInstructions, buildLiveInstructions } from "./instructions";

describe("voice intake instructions", () => {
  it("uses snapshot service policies without requiring a repeated service lookup", () => {
    const snapshot = { ...demoSnapshot, services: [
      { id: "hvac", name: "HVAC maintenance", durationMinutes: 60, intakePolicy: { serviceType: "onsite" as const, fields: { serviceAddress: "required" as const, issueDescription: "optional" as const } } },
      { id: "consult", name: "Remote consultation", durationMinutes: 30, intakePolicy: { serviceType: "remote" as const, fields: { serviceAddress: "disabled" as const } } },
    ] };
    const agent = buildAgentInstructions(snapshot, "voice", { hasTrustedCallerId: true });
    expect(agent).toContain("HVAC maintenance (60 min; intake onsite; required: serviceAddress)");
    expect(agent).toContain("Do not call a service lookup for services already listed here");
    expect(agent).toContain("never infer it from Caller ID");
    expect(agent).toContain("Never claim confirmed until the booking tool succeeds");
    expect(agent).toContain("pending follow-up, never a confirmed appointment");
  });

  it("uses one configured opening and maintains intent across small talk", () => {
    const live = buildLiveInstructions(demoSnapshot);
    expect(live).toContain("Do not introduce yourself or repeat the greeting");
    expect(live).toContain("small talk is not a new call");
    expect(live).toContain("last question across delegations");
    expect(live).toContain("A successful booking tool result is the only authority");
    expect(live).toContain("Never speak as the customer");
    expect(live).toContain("Never role-play a caller, simulate a sample conversation, or continue speaking to yourself");
    expect(live).toContain("wait silently for new caller input");
    expect(live).toContain("never create fictional dialogue to fill silence");
    expect(live).toContain("retain and combine every caller fact across turns");
    expect(live).toContain("Cancel only after verification succeeds and the caller explicitly confirms");
    expect(live).toContain("After a successful cancellation or saved follow-up");
    expect(live).toContain("the application independently detects that request");
  });
});

import { describe, expect, it } from "vitest";
import { summarizeLmcActions } from "./observability";

describe("summarizeLmcActions", () => {
  it("keeps decision metadata structured and free of message content", () => {
    expect(summarizeLmcActions([
      { type: "qualify", fields: { serviceType: "HVAC repair" }, confidence: 0.72 },
      { type: "intent", intent: "availability" },
    ])).toEqual({
      actionTypes: ["qualify", "intent"],
      confidence: 0.72,
      intent: "availability",
    });
  });

  it("records handoff reasons without copying customer content", () => {
    expect(summarizeLmcActions([{ type: "handoff", reason: "configured_escalation" }])).toEqual({
      actionTypes: ["handoff"],
      handoffReason: "configured_escalation",
    });
  });

  it("retains bounded decision metadata when policy reduces the action to clarification", () => {
    expect(summarizeLmcActions(
      [{ type: "clarify", reason: "ambiguous_request" }],
      { intent: "unknown", confidence: 0.2 },
    )).toEqual({ actionTypes: ["clarify"], intent: "unknown", confidence: 0.2 });
  });
});

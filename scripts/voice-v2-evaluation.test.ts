import { describe, expect, it } from "vitest";

import { compareVoiceEval, summarizeVoiceEval, voiceEvalCaseSchema, type VoiceEvalCase } from "./voice-v2-evaluation";

function fixture(id: string, overrides: Partial<VoiceEvalCase> = {}): VoiceEvalCase {
  return {
    id, greetingCount: 1, repeatedOpeningQuestionCount: 0, questionCount: 3, unnecessaryQuestionCount: 0,
    serviceLookupCount: 0, availabilityLookupCount: 2, toolCallCount: 4, delegationLatencyMs: [100, 200, 300],
    firstUsefulResponseMs: 700, bookingAttempted: true, bookingSucceeded: true, bookingDurationMs: 30_000,
    intakeRequired: true, intakeComplete: true, addressRequired: true, addressCaptured: true, addressCorrect: true,
    serviceAreaExpectedEligible: true, serviceAreaAccepted: true, confirmationWithoutCommit: false,
    callerClearlyEnded: true, hangupRequested: true, callDurationMs: 60_000, billedSeconds: 60, estimatedCostUsd: 0.12,
    ...overrides,
  };
}

describe("Kyra Voice V2 local evaluation", () => {
  it("summarizes reliability, conversational, intake, latency, cost, and hangup metrics", () => {
    const report = summarizeVoiceEval([
      fixture("hvac-maintenance", { serviceLookupCount: 1 }),
      fixture("remote-consult", { bookingAttempted: false, bookingSucceeded: false, bookingDurationMs: null, intakeRequired: false, intakeComplete: null, addressRequired: false, addressCaptured: null, addressCorrect: null, serviceAreaExpectedEligible: null, serviceAreaAccepted: null, callerClearlyEnded: false, hangupRequested: false, serviceLookupCount: 1, availabilityLookupCount: 0, toolCallCount: 1, delegationLatencyMs: [500], firstUsefulResponseMs: 1_300, callDurationMs: 45_000, billedSeconds: 45, estimatedCostUsd: null }),
    ]);

    expect(report.callCount).toBe(2);
    expect(report.greetingRepetitionRate).toBe(0);
    expect(report.serviceLookupsPerCompletedBooking).toBe(1);
    expect(report.availabilityLookupsPerCompletedBooking).toBe(2);
    expect(report.toolCallsPerCompletedBooking).toBe(4);
    expect(report.delegationLatencyMs).toEqual({ mean: 275, p95: 500, sampleCount: 4 });
    expect(report.timeToFirstUsefulResponseMs).toEqual({ mean: 1_000, p95: 1_300, sampleCount: 2 });
    expect(report.bookingSuccessRate).toBe(1);
    expect(report.requiredIntakeCompletionRate).toBe(1);
    expect(report.addressAccuracyRate).toBe(1);
    expect(report.automaticHangupRate).toBe(1);
    expect(report.estimatedCostUsd).toBe(0.12);
    expect(report.estimatedCostSampleCount).toBe(1);
  });

  it("keeps an absent production baseline explicit instead of fabricating a before/after result", () => {
    const report = compareVoiceEval(null, [fixture("synthetic-regression-case")]);
    expect(report.baseline).toBeNull();
    expect(report.comparison).toBe("baseline_not_supplied");
    expect(report.note).toContain("does not infer");
  });

  it("rejects mismatched or incomplete annotations", () => {
    expect(voiceEvalCaseSchema.safeParse(fixture("missing-address", { addressCaptured: null })).success).toBe(false);
    expect(voiceEvalCaseSchema.safeParse(fixture("bad-service-area", { serviceAreaExpectedEligible: false, serviceAreaAccepted: null })).success).toBe(false);
    expect(voiceEvalCaseSchema.safeParse(fixture("bad-question-count", { unnecessaryQuestionCount: 4 })).success).toBe(false);
  });
});

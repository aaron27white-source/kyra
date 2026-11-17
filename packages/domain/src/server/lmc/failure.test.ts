import { describe, expect, it } from "vitest";
import { classifyLmcProcessingError } from "./failure";

describe("classifyLmcProcessingError", () => {
  it("marks model-provider failures as retryable model failures", () => {
    expect(classifyLmcProcessingError(new Error("LMC_MODEL_UNAVAILABLE"))).toBe("MODEL_UNAVAILABLE");
  });

  it("does not misclassify unrelated failures as model outages", () => {
    expect(classifyLmcProcessingError(new Error("INVALID_JOB_PAYLOAD"))).toBeUndefined();
    expect(classifyLmcProcessingError("LMC_MODEL_UNAVAILABLE")).toBeUndefined();
  });
});

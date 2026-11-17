import { describe, expect, it } from "vitest";
import { classifyLmcJobFailure } from "./queue";

describe("classifyLmcJobFailure", () => {
  it("redacts database and RLS failures into bounded categories", () => {
    expect(classifyLmcJobFailure(new Error("permission denied for relation lmc_jobs"))).toEqual({
      code: "LMC_DATABASE_PERMISSION",
      category: "database",
    });
    expect(classifyLmcJobFailure("new row violates row-level security policy")).toEqual({
      code: "LMC_DATABASE_RLS",
      category: "rls",
    });
  });

  it("preserves safe processing, sending, and idempotency categories", () => {
    expect(classifyLmcJobFailure("EMAIL_PROVIDER_UNAVAILABLE")).toEqual({
      code: "EMAIL_PROVIDER_UNAVAILABLE",
      category: "sending",
    });
    expect(classifyLmcJobFailure("duplicate key value violates unique constraint")).toEqual({
      code: "IDEMPOTENCY_CONFLICT",
      category: "idempotency",
    });
    expect(classifyLmcJobFailure("MODEL_UNAVAILABLE")).toEqual({
      code: "MODEL_UNAVAILABLE",
      category: "processing",
    });
  });

  it("never publishes arbitrary exception text", () => {
    expect(classifyLmcJobFailure("private SQL, credentials and customer content")).toEqual({
      code: "LMC_JOB_FAILED",
      category: "unknown",
    });
  });
});

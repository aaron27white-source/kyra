import { describe, expect, it } from "vitest";

import { summarizeVitestFailures } from "./pilot-ci-report";

describe("pilot CI failure summaries", () => {
  it("returns bounded test identifiers without failure message content", () => {
    const result = summarizeVitestFailures({
      testResults: [
        {
          name: "/home/runner/work/kyra/tests/lmc/workflow.acceptance.ts",
          status: "failed",
          assertionResults: [
            { fullName: "sends one reply", status: "failed", failureMessages: ["FORM_REPLY_NOT_SENT private customer content"], location: { line: 42, column: 7 } },
            { fullName: "sends no duplicate", status: "passed", failureMessages: [] },
          ],
        },
      ],
    }, { root: "/home/runner/work/kyra" });

    expect(result).toEqual([
      {
        path: "tests/lmc/workflow.acceptance.ts",
        tests: [{ assertionIndex: 0, title: "sends one reply", status: "failed", failureCode: "FORM_REPLY_NOT_SENT", location: { line: 42, column: 7 } }],
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("private customer content");
  });

  it("limits the number of reported suites and assertions", () => {
    const report = {
      testResults: Array.from({ length: 30 }, (_, suite) => ({
        name: `/repo/test-${suite}.test.ts`,
        status: "failed",
        assertionResults: Array.from({ length: 5 }, (_, test) => ({ fullName: `test ${test}`, status: "failed" })),
      })),
    };

    const result = summarizeVitestFailures(report, { root: "/repo" });

    expect(result).toHaveLength(20);
    expect(result.reduce((count: number, suite: { tests: unknown[] }) => count + suite.tests.length, 0)).toBe(100);
  });

  it("extracts bounded codes from suite-level failure fields", () => {
    const result = summarizeVitestFailures({
      testResults: [{
        name: "/repo/tests/lmc/workflow.acceptance.ts",
        message: "LMC_DATABASE_PERMISSION private details",
        assertionResults: [{ fullName: "setup", status: "failed", failureMessages: [] }],
      }],
    }, { root: "/repo" });

    expect(result[0]?.tests[0]).toMatchObject({ failureCode: "LMC_DATABASE_PERMISSION" });
    expect(JSON.stringify(result)).not.toContain("private details");
  });

  it("classifies timeout failures without publishing the timeout text", () => {
    const result = summarizeVitestFailures({
      testResults: [{
        name: "/repo/tests/lmc/email.acceptance.ts",
        message: "Hook timed out in 15000ms while handling private fixture data",
        assertionResults: [{ fullName: "captures a lead", status: "failed", failureMessages: [] }],
      }],
    }, { root: "/repo" });

    expect(result[0]?.tests[0]).toMatchObject({ failureCode: "LMC_ACCEPTANCE_HOOK_TIMEOUT" });
    expect(JSON.stringify(result)).not.toContain("private fixture data");
  });
});

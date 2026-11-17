import { afterEach, expect, it, vi } from "vitest";
import { runLmcDemo } from "../../scripts/lmc/demo";

afterEach(() => vi.unstubAllGlobals());

it("runs the complete offline email-to-booking and consenting follow-up/STOP demo using real HTTP and PostgreSQL", async () => {
  const fetcher = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
        throw new Error("DEMO_EXTERNAL_NETWORK_FORBIDDEN");
      return fetcher(input, init);
    },
  );
  const report = await runLmcDemo();
  expect(report.mode).toBe("fake");
  expect(report.persistence).toBe("postgresql");
  expect(report.steps.map((step) => step.name)).toEqual([
    "initial_email",
    "first_reply",
    "qualification",
    "booking",
    "owner_summary",
    "consenting_lead",
    "followup",
    "opt_out",
  ]);
  expect(report.booking).toMatchObject({
    count: 1,
    calendarSynced: true,
    verifiedRequester: true,
  });
  expect(report.followups).toMatchObject({
    touches: 1,
    optedOut: true,
    futureSends: 0,
    bookedLeadTouches: 0,
  });
  expect(report.firstReplyMs).toBeLessThan(5000);
  expect(report.cleanup).toEqual({
    businessRemoved: true,
    outboxRemoved: true,
  });
  const serialized = JSON.stringify(report);
  expect(serialized).not.toMatch(
    /postgres(?:ql)?:\/\/|(?:reply|lead|forward)\+[A-Za-z0-9_-]{43}@|\/api\/lmc\/unsubscribe\//,
  );
  expect(serialized).toContain("ZIP");
  expect(serialized).toContain("roof repair");
}, 30_000);

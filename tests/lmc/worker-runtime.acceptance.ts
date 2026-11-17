import { afterEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { lmcJobs } from "@lobbystack/db";
import { createLmcHarness } from "./support/harness";
let harness: Awaited<ReturnType<typeof createLmcHarness>> | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});
it("leases only the job it is executing so slow model calls do not expire waiting jobs", async () => {
  const h = (harness = await createLmcHarness({ now: "2030-01-09T03:40:00Z" }));
  const runningCounts: number[] = [];
  const analyze = h.model.analyze.bind(h.model);
  h.model.analyze = async (prompt) => {
    const running = await h.scoped((tx) =>
      tx.select().from(lmcJobs).where(eq(lmcJobs.status, "running")),
    );
    runningCounts.push(running.length);
    return analyze(prompt);
  };
  await h.capture({
    email: "one@example.invalid",
    message: "Roof repair please.",
  });
  await h.capture({
    email: "two@example.invalid",
    message: "Roof repair please.",
  });
  await h.work();
  expect(runningCounts).toEqual([1, 1]);
  expect(h.mail.records.filter((mail) => mail.kind === "reply")).toHaveLength(
    2,
  );
});

it("keeps the active job leased while email reasoning exceeds the original lease window", async () => {
  const h = (harness = await createLmcHarness({ now: "2030-01-09T03:40:00Z" }));
  const analyze = h.model.analyze.bind(h.model);
  h.model.analyze = async (prompt) => {
    h.advanceMilliseconds(61_000);
    return analyze(prompt);
  };
  await h.capture({
    email: "slow-reasoning@example.invalid",
    message: "Roof repair please.",
  });
  await h.work();
  expect(h.jobFailures).toEqual([]);
  expect(h.mail.to("slow-reasoning@example.invalid")).toHaveLength(1);
});

it("runs the production email consumer with real PostgreSQL and default fake providers", async () => {
  const { createLmcEmailRuntime } =
    await import("../../apps/worker/src/lmcEmail");
  const h = (harness = await createLmcHarness({
    now: new Date().toISOString(),
  }));
  const lead = await h.capture({
    email: "runtime@example.invalid",
    message: "Please help with roof repair.",
  });
  const runtime = createLmcEmailRuntime({
    database: h.workerDatabase,
    dispatcher: h.dispatcherDatabase,
    environment: { NODE_ENV: "test" },
  });
  const abort = new AbortController();
  const running = runtime.run(abort.signal);
  try {
    await vi.waitFor(
      async () => {
        const sent = (await h.history(lead.id)).filter(
          (message) =>
            message.direction === "assistant" && message.status === "sent",
        );
        expect(sent).toHaveLength(1);
        expect(sent[0]!.providerId).toMatch(/^fake-email-/);
      },
      { timeout: 10_000 },
    );
    expect((await h.lead(lead.id)).status).toBe("qualifying");
  } finally {
    abort.abort();
    await running;
  }
});

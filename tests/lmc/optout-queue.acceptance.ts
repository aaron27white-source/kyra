import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { lmcJobs } from "@lobbystack/db";
import { createLmcHarness } from "./support/harness";
import { suppressLmcEmail } from "../../packages/domain/src/server/lmc/suppression";

it("cancels queued lead-facing work at opt-out while preserving owner alerts and other contacts", async () => {
  const h = await createLmcHarness({ now: "2030-01-09T03:40:00Z" });
  try {
    const lead = await h.capture({ email: "stop@example.invalid", message: "Roof repair" });
    const other = await h.capture({ email: "continue@example.invalid", message: "Roof repair" });
    await h.scoped(tx => tx.insert(lmcJobs).values([
      { tenantId: h.tenantId, leadId: lead.id, kind: "send", dedupeKey: randomUUID(), payload: { kind: "reply" }, availableAt: h.now() },
      { tenantId: h.tenantId, leadId: lead.id, kind: "send", dedupeKey: randomUUID(), payload: { kind: "owner_alert" }, availableAt: h.now() },
      { tenantId: h.tenantId, leadId: lead.id, kind: "followup", dedupeKey: randomUUID(), payload: {}, availableAt: h.now() },
    ]));
    await h.scoped(tx => suppressLmcEmail(tx, h.tenantId, "stop@example.invalid", "opt_out", h.now()));
    const jobs = await h.scoped(tx => tx.select().from(lmcJobs));
    expect(jobs.filter(job => job.leadId === lead.id && !(job.kind === "send" && job.payload.kind === "owner_alert"))).toHaveLength(3);
    expect(jobs.filter(job => job.leadId === lead.id && !(job.kind === "send" && job.payload.kind === "owner_alert")).every(job => job.status === "cancelled")).toBe(true);
    expect(jobs.filter(job => job.leadId === lead.id && job.payload.kind === "owner_alert").map(job => job.status)).toEqual(["pending"]);
    expect(jobs.filter(job => job.leadId === other.id).map(job => job.status)).toEqual(["pending"]);
  } finally {
    await h.close();
  }
});

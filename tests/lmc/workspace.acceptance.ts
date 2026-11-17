import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LmcWorkspace } from "../../packages/domain/src/server/lmc/workspace";
import { createLmcHarness } from "./support/harness";

describe("email CRM and business settings authorization", () => {
  let a: Awaited<ReturnType<typeof createLmcHarness>>,
    b: typeof a,
    workspace: LmcWorkspace;
  beforeEach(async () => {
    a = await createLmcHarness({ now: "2030-01-09T03:40:00Z" });
    b = await createLmcHarness({ now: "2030-01-09T03:40:00Z" });
    workspace = new LmcWorkspace({
      database: a.appDatabase,
      now: a.now,
      senderEmail: "team@example.invalid",
    });
  });
  afterEach(async () => {
    await b?.close();
    await a?.close();
  });
  const actor = () => ({ tenantId: a.tenantId, userId: a.ownerId });
  it("lists only the selected tenant and does not reveal raw conversation or action capabilities", async () => {
    const one = await a.capture({
        email: "one@example.invalid",
        subject: `Reply to reply+${"A".repeat(43)}@inbound.example.invalid`,
        message: "Roof help",
      }),
      other = await b.capture({
        email: "two@example.invalid",
        message: "Private B roofing request",
      });
    await a.work();
    await a.reply(one.id, "ZIP 33101, roof repair at my home");
    await a.work();
    const list = await workspace.list(actor(), { limit: 25, offset: 0 });
    expect(list.items.map((item) => item.id)).toEqual([one.id]);
    const detail = await workspace.detail(actor(), one.id);
    expect(detail.messages.length).toBeGreaterThan(1);
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain("replyTokenHash");
    expect(serialized).not.toMatch(/reply\+[A-Za-z0-9_-]{43}@/);
    expect(serialized).not.toContain("/api/lmc/unsubscribe/");
    await expect(workspace.detail(actor(), other.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      workspace.list(
        { tenantId: b.tenantId, userId: a.ownerId },
        { limit: 25, offset: 0 },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("allows viewers to read but denies settings changes and automation commands", async () => {
    const viewer = await a.addViewer(),
      lead = await a.capture({
        email: "view@example.invalid",
        message: "Roof help",
      });
    await a.work();
    const readActor = { tenantId: a.tenantId, userId: viewer },
      settings = await workspace.settings(readActor);
    expect(
      (await workspace.list(readActor, { limit: 25, offset: 0 })).items,
    ).toHaveLength(1);
    await expect(
      workspace.saveSettings(readActor, {
        config: settings.config,
        enabled: true,
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      workspace.pause(readActor, lead.id, true),
    ).rejects.toMatchObject({ status: 403 });
    await expect(workspace.rotateCaptureToken(readActor)).rejects.toMatchObject(
      { status: 403 },
    );
    await expect(
      a.humanReplyAs(viewer, lead.id, "Unauthorized response"),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("rejects another tenant's service and a sender outside the platform sending identity", async () => {
    const settings = await workspace.settings(actor()),
      other = await new LmcWorkspace({
        database: b.appDatabase,
        now: b.now,
        senderEmail: "team@example.invalid",
      }).settings({ tenantId: b.tenantId, userId: b.ownerId });
    await expect(
      workspace.saveSettings(actor(), {
        config: { ...settings.config, services: other.config.services },
        enabled: true,
      }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      workspace.saveSettings(actor(), {
        config: { ...settings.config, fromEmail: "team@tenant-b.invalid" },
        enabled: true,
      }),
    ).rejects.toMatchObject({ status: 422 });
  });
  it("pauses automation and resumes only on future replies", async () => {
    const lead = await a.capture({
      email: "pause@example.invalid",
      message: "Roof help",
      consentToFollowUp: true,
    });
    await a.work();
    await workspace.pause(actor(), lead.id, true);
    a.advanceDays(2);
    await a.work();
    expect(
      a.mail
        .to("pause@example.invalid")
        .filter((mail) => mail.kind === "followup"),
    ).toHaveLength(0);
    await workspace.pause(actor(), lead.id, false);
    await a.reply(lead.id, "ZIP 33101, roof repair at my home");
    await a.work();
    expect(a.mail.to("pause@example.invalid")).toHaveLength(2);
  });
});

import { and, asc, desc, eq, ilike, inArray, lt, or, sql } from "drizzle-orm";
import {
  lmcBusinessSettingsSchema,
  lmcEmailAddressSchema,
  lmcSettingsWriteSchema,
  type AuthzRole,
} from "@lobbystack/contracts";
import {
  lmcEvents,
  lmcJobs,
  lmcLeads,
  lmcMessages,
  lmcSettings,
  services,
  withBusinessTransaction,
  type Database,
  type DatabaseTransaction,
} from "@lobbystack/db";
import { requireBusinessMembership } from "../../authz";
import { createReplyToken } from "./capabilities";
import { redactLmcCapabilities, redactLmcReadValue } from "./redaction";

type Actor = { tenantId: string; userId: string };
const leadFields = {
  id: lmcLeads.id,
  tenantId: lmcLeads.tenantId,
  email: lmcLeads.email,
  name: lmcLeads.name,
  subject: lmcLeads.subject,
  status: lmcLeads.status,
  reason: lmcLeads.reason,
  qualification: lmcLeads.qualification,
  offeredSlots: lmcLeads.offeredSlots,
  consentFollowups: lmcLeads.consentFollowups,
  followupCount: lmcLeads.followupCount,
  aiPaused: lmcLeads.aiPaused,
  appointmentId: lmcLeads.appointmentId,
  lastInboundAt: lmcLeads.lastInboundAt,
  verifiedAt: lmcLeads.verifiedAt,
  createdAt: lmcLeads.createdAt,
  updatedAt: lmcLeads.updatedAt,
};
const statuses = new Set([
  "new",
  "qualifying",
  "qualified",
  "declined",
  "human_handoff",
  "booked",
  "opted_out",
  "suppressed",
]);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export class LmcWorkspaceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export class LmcWorkspace {
  private readonly senderEmail: string;
  constructor(
    private readonly input: {
      database: Database;
      now: () => Date;
      senderEmail: string;
    },
  ) {
    this.senderEmail = lmcEmailAddressSchema
      .parse(input.senderEmail)
      .toLowerCase();
  }
  private actor<T>(
    actor: Actor,
    minimumRole: AuthzRole,
    fn: (tx: DatabaseTransaction, role: AuthzRole) => Promise<T>,
  ) {
    if (!uuid.test(actor.tenantId) || !uuid.test(actor.userId))
      throw new LmcWorkspaceError(400, "INVALID_WORKSPACE");
    return withBusinessTransaction(
      this.input.database,
      {
        businessId: actor.tenantId,
        userId: actor.userId,
        actorType: "operator",
      },
      async (tx) => {
        const membership = await requireBusinessMembership(tx, {
          businessId: actor.tenantId,
          userId: actor.userId,
          minimumRole,
        });
        return fn(tx, membership.role);
      },
    );
  }

  list(
    actor: Actor,
    input: { limit: number; offset: number; status?: string; search?: string },
  ) {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100 ||
      !Number.isSafeInteger(input.offset) ||
      input.offset < 0 ||
      input.offset > 100_000 ||
      (input.search && input.search.length > 200) ||
      (input.status && !statuses.has(input.status))
    )
      throw new LmcWorkspaceError(400, "INVALID_LEAD_FILTER");
    return this.actor(actor, "viewer", async (tx, role) => {
      const search = input.search?.trim().replace(/[\\%_]/g, "\\$&");
      const items = await tx
        .select(leadFields)
        .from(lmcLeads)
        .where(
          and(
            eq(lmcLeads.tenantId, actor.tenantId),
            input.status ? eq(lmcLeads.status, input.status) : undefined,
            search
              ? or(
                  ilike(lmcLeads.email, `%${search}%`),
                  ilike(lmcLeads.name, `%${search}%`),
                  ilike(lmcLeads.subject, `%${search}%`),
                )
              : undefined,
          ),
        )
        .orderBy(desc(lmcLeads.updatedAt), desc(lmcLeads.id))
        .limit(input.limit + 1)
        .offset(input.offset);
      const grouped = await tx
        .select({ status: lmcLeads.status, count: sql<string>`count(*)` })
        .from(lmcLeads)
        .where(eq(lmcLeads.tenantId, actor.tenantId))
        .groupBy(lmcLeads.status);
      return {
        items: redactLmcReadValue(items.slice(0, input.limit)),
        hasNext: items.length > input.limit,
        summary: Object.fromEntries(
          grouped.map((row) => [row.status, Number(row.count)]),
        ),
        role,
      };
    });
  }

  detail(
    actor: Actor,
    id: string,
    input: { before?: string; limit?: number } = {},
  ) {
    const limit = input.limit ?? 50;
    if (
      !uuid.test(id) ||
      (input.before && !uuid.test(input.before)) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new LmcWorkspaceError(400, "INVALID_LEAD_QUERY");
    return this.actor(actor, "viewer", async (tx, role) => {
      const [lead] = await tx
        .select(leadFields)
        .from(lmcLeads)
        .where(and(eq(lmcLeads.tenantId, actor.tenantId), eq(lmcLeads.id, id)))
        .limit(1);
      if (!lead) throw new LmcWorkspaceError(404, "LEAD_NOT_FOUND");
      const [cursor] = input.before
        ? await tx
            .select({ createdAt: lmcMessages.createdAt, id: lmcMessages.id })
            .from(lmcMessages)
            .where(
              and(
                eq(lmcMessages.tenantId, actor.tenantId),
                eq(lmcMessages.leadId, id),
                eq(lmcMessages.id, input.before),
              ),
            )
            .limit(1)
        : [];
      if (input.before && !cursor)
        throw new LmcWorkspaceError(400, "INVALID_HISTORY_CURSOR");
      const rows = await tx
        .select()
        .from(lmcMessages)
        .where(
          and(
            eq(lmcMessages.tenantId, actor.tenantId),
            eq(lmcMessages.leadId, id),
            cursor
              ? or(
                  lt(lmcMessages.createdAt, cursor.createdAt),
                  and(
                    eq(lmcMessages.createdAt, cursor.createdAt),
                    lt(lmcMessages.id, cursor.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(lmcMessages.createdAt), desc(lmcMessages.id))
        .limit(limit + 1);
      const messages = rows
        .slice(0, limit)
        .reverse()
        .map((message) => ({
          ...message,
          toEmail: redactLmcCapabilities(message.toEmail),
          body: redactLmcCapabilities(message.body),
          subject: redactLmcCapabilities(message.subject),
          messageId: redactLmcCapabilities(message.messageId),
          headers: Object.fromEntries(
            Object.entries(message.headers)
              .filter(([key]) =>
                [
                  "message-id",
                  "in-reply-to",
                  "references",
                  "auto-submitted",
                ].includes(key.toLowerCase()),
              )
              .map(([key, value]) => [key, redactLmcCapabilities(value)]),
          ),
        }));
      const events = await tx
        .select({
          id: lmcEvents.id,
          type: lmcEvents.type,
          metadata: lmcEvents.metadata,
          createdAt: lmcEvents.createdAt,
        })
        .from(lmcEvents)
        .where(
          and(eq(lmcEvents.tenantId, actor.tenantId), eq(lmcEvents.leadId, id)),
        )
        .orderBy(desc(lmcEvents.createdAt))
        .limit(100);
      return {
        lead: redactLmcReadValue(lead),
        messages,
        events: redactLmcReadValue(events),
        nextBefore: rows.length > limit ? (messages[0]?.id ?? null) : null,
        role,
      };
    });
  }

  settings(actor: Actor) {
    return this.actor(actor, "viewer", async (tx, role) => {
      const [settings] = await tx
        .select({ config: lmcSettings.config, enabled: lmcSettings.enabled })
        .from(lmcSettings)
        .where(eq(lmcSettings.tenantId, actor.tenantId))
        .limit(1);
      const catalog = await tx
        .select({ id: services.id, name: services.name })
        .from(services)
        .where(
          and(
            eq(services.businessId, actor.tenantId),
            eq(services.active, true),
          ),
        )
        .orderBy(asc(services.name));
      return {
        config: settings
          ? lmcBusinessSettingsSchema.parse(settings.config)
          : null,
        enabled: settings?.enabled ?? false,
        catalog,
        senderEmail: this.senderEmail,
        role,
      };
    });
  }

  saveSettings(actor: Actor, body: unknown) {
    return this.actor(actor, "business_admin", async (tx) => {
      const { config, enabled } = lmcSettingsWriteSchema.parse(body);
      if (config.fromEmail.toLowerCase() !== this.senderEmail)
        throw new LmcWorkspaceError(422, "SENDING_IDENTITY_NOT_ALLOWED");
      const ids = config.services.map((service) => service.id);
      const catalog = await tx
        .select({ id: services.id, name: services.name })
        .from(services)
        .where(
          and(
            eq(services.businessId, actor.tenantId),
            eq(services.active, true),
            inArray(services.id, ids),
          ),
        );
      if (
        new Set(ids).size !== ids.length ||
        catalog.length !== ids.length ||
        config.services.some(
          (item) =>
            !catalog.some(
              (row) => row.id === item.id && row.name === item.name,
            ),
        )
      )
        throw new LmcWorkspaceError(422, "SERVICE_NOT_AVAILABLE");
      const words = config.services
        .flatMap((item) => [item.name, ...item.aliases])
        .map((word) => word.trim().toLowerCase());
      if (new Set(words).size !== words.length)
        throw new LmcWorkspaceError(422, "AMBIGUOUS_SERVICE_ALIAS");
      if (
        config.followups.enabled &&
        (config.followups.delaysHours.length < config.followups.maxTouches ||
          config.followups.delaysHours.some(
            (delay, index) =>
              index > 0 && delay <= config.followups.delaysHours[index - 1]!,
          ))
      )
        throw new LmcWorkspaceError(422, "INVALID_FOLLOWUP_SCHEDULE");
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${actor.tenantId}:lmc-settings`},0))`,
      );
      const [current] = await tx
        .select({ tenantId: lmcSettings.tenantId })
        .from(lmcSettings)
        .where(eq(lmcSettings.tenantId, actor.tenantId))
        .for("update");
      const token = current ? null : createReplyToken(actor.tenantId);
      const saved = { ...config, fromEmail: this.senderEmail };
      if (current)
        await tx
          .update(lmcSettings)
          .set({ config: saved, enabled, updatedAt: this.input.now() })
          .where(eq(lmcSettings.tenantId, actor.tenantId));
      else
        await tx
          .insert(lmcSettings)
          .values({
            tenantId: actor.tenantId,
            config: saved,
            enabled,
            captureTokenHash: token!.hash,
            createdAt: this.input.now(),
            updatedAt: this.input.now(),
          });
      await tx
        .insert(lmcEvents)
        .values({
          tenantId: actor.tenantId,
          type: "email_settings_saved",
          metadata: { userId: actor.userId, enabled },
          createdAt: this.input.now(),
        });
      return {
        config: saved,
        enabled,
        ...(token ? { captureToken: token.value } : {}),
      };
    });
  }

  rotateCaptureToken(actor: Actor) {
    return this.actor(actor, "business_admin", async (tx) => {
      const token = createReplyToken(actor.tenantId);
      const rows = await tx
        .update(lmcSettings)
        .set({ captureTokenHash: token.hash, updatedAt: this.input.now() })
        .where(eq(lmcSettings.tenantId, actor.tenantId))
        .returning({ id: lmcSettings.tenantId });
      if (!rows.length)
        throw new LmcWorkspaceError(404, "EMAIL_SETTINGS_NOT_FOUND");
      await tx
        .insert(lmcEvents)
        .values({
          tenantId: actor.tenantId,
          type: "capture_token_rotated",
          metadata: { userId: actor.userId },
          createdAt: this.input.now(),
        });
      return { captureToken: token.value };
    });
  }

  pause(actor: Actor, id: string, paused: boolean) {
    if (!uuid.test(id) || typeof paused !== "boolean")
      throw new LmcWorkspaceError(400, "INVALID_PAUSE_REQUEST");
    return this.actor(actor, "scheduler", async (tx) => {
      const [lead] = await tx
        .select()
        .from(lmcLeads)
        .where(and(eq(lmcLeads.tenantId, actor.tenantId), eq(lmcLeads.id, id)))
        .for("update");
      if (!lead) throw new LmcWorkspaceError(404, "LEAD_NOT_FOUND");
      if (["opted_out", "suppressed"].includes(lead.status))
        throw new LmcWorkspaceError(422, "EMAIL_SUPPRESSED");
      await tx
        .update(lmcLeads)
        .set({
          aiPaused: paused,
          status: paused
            ? "human_handoff"
            : lead.appointmentId
              ? "booked"
              : "qualifying",
          reason: paused ? "manual_pause" : null,
          followupGeneration: lead.followupGeneration + 1,
          updatedAt: this.input.now(),
        })
        .where(and(eq(lmcLeads.tenantId, actor.tenantId), eq(lmcLeads.id, id)));
      await tx
        .update(lmcJobs)
        .set({ status: "cancelled", updatedAt: this.input.now() })
        .where(
          and(
            eq(lmcJobs.tenantId, actor.tenantId),
            eq(lmcJobs.leadId, id),
            eq(lmcJobs.kind, "followup"),
            eq(lmcJobs.status, "pending"),
          ),
        );
      await tx
        .insert(lmcEvents)
        .values({
          tenantId: actor.tenantId,
          leadId: id,
          type: paused ? "automation_paused" : "automation_resumed",
          metadata: { userId: actor.userId },
          createdAt: this.input.now(),
        });
      return { paused };
    });
  }
}

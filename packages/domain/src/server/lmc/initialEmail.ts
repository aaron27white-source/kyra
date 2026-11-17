import { createHash, randomUUID } from "node:crypto";
import {
  lmcEmailAddressSchema,
  type LmcProviderEvent,
} from "@lobbystack/contracts";
import { eq } from "drizzle-orm";
import {
  lmcSettings,
  withBusinessTransaction,
  type Database,
} from "@lobbystack/db";
import { routeReplyToken, verifyReplyToken } from "./capabilities";
import {
  emailIdentityKeys,
  loadEmailIdentity,
  storeEmailIdentities,
  LmcEmailIdentityConflict,
} from "./intakeIdentity";
import { suppressLmcEmail } from "./suppression";
import { LmcCaptureError, LmcLeadCapture } from "./capture";
import { normalizeInboundEmail, stripEmailHistory } from "./inbound";

/** Deterministic contact-form notification fields; quoted From/Reply-To never select the lead. */
export function parseForwardedLeadNotification(
  text: string,
): { email: string; name: string; message: string } | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let email: string | undefined,
    name = "",
    message: string | undefined,
    nameSeen = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const emailField = line.match(/^\s*(?:Lead\s+)?E-?mail\s*:\s*(.*?)\s*$/i);
    if (emailField) {
      if (email !== undefined) return null;
      const parsed = lmcEmailAddressSchema.safeParse(emailField[1]);
      if (!parsed.success) return null;
      email = parsed.data.toLowerCase();
      continue;
    }
    const nameField = line.match(
      /^\s*(?:(?:Full|Lead|Customer)\s+)?Name\s*:\s*(.*?)\s*$/i,
    );
    if (nameField) {
      if (nameSeen || nameField[1]!.length > 160) return null;
      nameSeen = true;
      name = nameField[1]!;
      continue;
    }
    const messageField = line.match(/^\s*(?:Lead\s+)?Message\s*:\s*(.*)$/i);
    if (messageField) {
      message = stripEmailHistory(
        [messageField[1], ...lines.slice(index + 1)].join("\n"),
      );
      break;
    }
  }
  return email && message && message.length <= 16000
    ? { email, name, message }
    : null;
}

export class LmcInitialEmailIntake {
  constructor(
    private readonly input: {
      database: Database;
      now: () => Date;
      receivingDomain: string;
    },
  ) {}
  private async optOut(
    token: string,
    email: Extract<
      ReturnType<typeof normalizeInboundEmail>,
      { kind: "message" }
    >,
    providerId: string,
  ): Promise<{ accepted: boolean; reason?: string }> {
    const tenantId = routeReplyToken(token);
    if (!tenantId) return { accepted: false, reason: "invalid_recipient" };
    return withBusinessTransaction(
      this.input.database,
      { businessId: tenantId, actorType: "worker" },
      async (tx) => {
        const [settings] = await tx
          .select()
          .from(lmcSettings)
          .where(eq(lmcSettings.tenantId, tenantId))
          .limit(1);
        if (
          !settings?.enabled ||
          !verifyReplyToken(token, tenantId, settings.captureTokenHash)
        )
          return { accepted: false, reason: "invalid_recipient" };
        const fingerprint = createHash("sha256")
          .update(
            JSON.stringify({
              kind: "opt_out",
              from: email.from,
              to: email.to,
              messageId: email.messageId,
              text: email.text,
            }),
          )
          .digest("hex");
        const keys = emailIdentityKeys({
            messageId: email.messageId,
            providerId,
          }),
          now = this.input.now();
        try {
          const prior = await loadEmailIdentity(
            tx,
            tenantId,
            keys,
            fingerprint,
          );
          if (prior?.leadId)
            throw new LmcEmailIdentityConflict("EMAIL_IDEMPOTENCY_CONFLICT");
          await storeEmailIdentities(tx, {
            tenantId,
            leadId: null,
            keys,
            fingerprint,
            now,
          });
          if (!prior)
            await suppressLmcEmail(tx, tenantId, email.from, "opt_out", now);
          return { accepted: true };
        } catch (error) {
          if (error instanceof LmcEmailIdentityConflict)
            return { accepted: false, reason: "EMAIL_IDEMPOTENCY_CONFLICT" };
          throw error;
        }
      },
    );
  }
  async receive(
    event: Extract<LmcProviderEvent, { kind: "message" }>,
  ): Promise<{ accepted: boolean; reason?: string }> {
    const email = normalizeInboundEmail(event.email, {
      preserveForwardedNotification: true,
    });
    if (email.kind !== "message")
      return { accepted: false, reason: email.reason };
    const suffix = `@${this.input.receivingDomain}`;
    const match = email.to.match(/^(lead|forward)\+([A-Za-z0-9_-]{43})@/);
    if (!match || !email.to.endsWith(suffix))
      return { accepted: false, reason: "invalid_recipient" };
    const kind = match[1] === "forward" ? "forward" : "direct",
      token = match[2]!;
    // Replies use ordinary history stripping; only the explicit forwarding ingress preserves quoted notifications.
    const normalized =
      kind === "forward" ? email : normalizeInboundEmail(event.email);
    if (normalized.kind !== "message")
      return { accepted: false, reason: normalized.reason };
    if (normalized.optOut && kind === "direct")
      return this.optOut(token, normalized, event.id);
    const lead =
      kind === "forward"
        ? parseForwardedLeadNotification(normalized.text)
        : {
            email: normalized.from,
            name: (event.email.from.match(/^\s*([^<>]+)\s*</)?.[1] ?? "")
              .trim()
              .replace(/^"|"$/g, "")
              .slice(0, 160),
            message: normalized.text,
          };
    if (
      !lead ||
      lead.message.length > 16000 ||
      /^(?:stop|unsubscribe|opt[ -]?out|remove me|cancel emails)[.!\s]*$/i.test(
        lead.message,
      )
    )
      return { accepted: false, reason: "invalid_lead_notification" };
    try {
      await new LmcLeadCapture(this.input).captureEmail(
        token,
        {
          requestId: randomUUID(),
          ...lead,
          subject: normalized.subject.slice(0, 200),
          consentToFollowUp: false,
        },
        {
          kind,
          from: normalized.from,
          recipient: normalized.to,
          messageId: normalized.messageId,
          providerId: event.id,
          injectionDetected: normalized.injectionDetected,
          attachmentsIgnored: normalized.attachmentsIgnored,
        },
      );
      return { accepted: true };
    } catch (error) {
      // Permanent invalid messages are acknowledged by the webhook, not retried forever.
      // Infrastructure and quota failures remain retryable through its existing 503 path.
      if (error instanceof LmcEmailIdentityConflict)
        return { accepted: false, reason: "EMAIL_IDEMPOTENCY_CONFLICT" };
      if (error instanceof LmcCaptureError && error.status !== 429)
        return { accepted: false, reason: error.code };
      throw error;
    }
  }
}

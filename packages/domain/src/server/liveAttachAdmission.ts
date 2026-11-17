import { and, eq, isNull } from "drizzle-orm";
import { calls, conversations, withBusinessTransaction } from "@lobbystack/db";
import type { DomainContext } from "./context";

export type LiveAttachIdentity = {
  businessId: string;
  callId: string;
  sessionId: string;
  channel: "voice" | "web_voice";
  conversationId?: string;
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bind trusted-service claims to durable identity before loading a snapshot or deduplicating a session. */
export async function canAttachLiveCall(
  context: DomainContext,
  input: LiveAttachIdentity,
): Promise<boolean> {
  if (
    !uuid.test(input.businessId) ||
    !uuid.test(input.callId) ||
    (input.conversationId !== undefined && !uuid.test(input.conversationId))
  )
    return false;
  return withBusinessTransaction(
    context.db,
    { businessId: input.businessId, actorType: "worker" },
    async (tx) => {
      const call = (
        await tx
          .select({
            conversationId: calls.conversationId,
            status: calls.status,
          })
          .from(calls)
          .where(
            and(
              eq(calls.id, input.callId),
              eq(calls.businessId, input.businessId),
              eq(calls.provider, "openai_live"),
              eq(calls.providerCallId, input.sessionId),
              eq(calls.gatewaySessionId, input.sessionId),
              eq(calls.transport, input.channel),
              isNull(calls.endedAt),
            ),
          )
          .limit(1)
      )[0];
      if (!call || call.status === "blocked") return false;
      if (
        input.conversationId !== undefined &&
        input.conversationId !== call.conversationId
      )
        return false;
      if (call.conversationId) {
        const conversation = (
          await tx
            .select({ id: conversations.id })
            .from(conversations)
            .where(
              and(
                eq(conversations.id, call.conversationId),
                eq(conversations.businessId, input.businessId),
              ),
            )
            .limit(1)
        )[0];
        if (!conversation) return false;
      }
      return true;
    },
  );
}

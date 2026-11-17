import { stepCountIs, ToolLoopAgent, type LanguageModel, type ToolSet } from "ai";

import { buildAgentInstructions } from "./instructions";
import { createReceptionistTools, type AgentToolContext } from "./tools";

export type ReceptionistAgent = ToolLoopAgent<never, ToolSet>;

export function createReceptionistAgent(input: { model: LanguageModel; context: AgentToolContext; extraInstructions?: string }): ReceptionistAgent {
  return new ToolLoopAgent({
    model: input.model,
    instructions: [buildAgentInstructions(input.context.snapshot, input.context.channel, { intakeOnly: input.context.intakeOnly ?? false, hasTrustedCallerId: Boolean(input.context.callerPhone) }), input.extraInstructions].filter(Boolean).join("\n\n"),
    tools: createReceptionistTools(input.context),
    // Voice callers are waiting. Asynchronous email can afford additional
    // knowledge lookups, without changing the voice latency budget.
    stopWhen: stepCountIs(input.context.channel === "email" ? 8 : 4),
  });
}

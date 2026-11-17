import { generateText, Output, jsonSchema, type LanguageModel } from "ai";
import {
  lmcEmailDecisionSchema,
  lmcEmailDecisionWireSchema,
  type LmcEmailDecisionWire,
  type LmcEmailModel,
  type LmcModelPrompt,
} from "@lobbystack/contracts";
import { createAgentModel } from "./model";

// Keep the SDK boundary independent of its Zod version; canonical validation follows generation.
const decisionSchema = jsonSchema<LmcEmailDecisionWire>({
  type: "object",
  additionalProperties: false,
  required: ["intent", "confidence", "qualification", "requestedSlot"],
  properties: {
    intent: {
      type: "string",
      enum: lmcEmailDecisionSchema.shape.intent.options,
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    requestedSlot: { type: ["string", "null"] },
    qualification: {
      type: "object",
      additionalProperties: false,
      required: [
        "serviceType",
        "zip",
        "city",
        "urgency",
        "propertyType",
        "name",
        "phone",
      ],
      properties: {
        serviceType: { type: ["string", "null"] },
        zip: { type: ["string", "null"] },
        city: { type: ["string", "null"] },
        urgency: {
          type: ["string", "null"],
          enum: ["normal", "urgent", "emergency", null],
        },
        propertyType: {
          type: ["string", "null"],
          enum: ["residential", "commercial", "other", null],
        },
        name: { type: ["string", "null"] },
        phone: { type: ["string", "null"] },
      },
    },
  },
});

export async function analyzeLmcEmail(input: {
  model: LanguageModel;
  prompt: LmcModelPrompt;
}): Promise<unknown> {
  const { model, prompt } = input;
  try {
    const generated = await generateText({
      model,
      instructions: prompt.trustedInstructions,
      prompt: JSON.stringify({
        business: prompt.business,
        untrusted: prompt.untrusted,
      }),
      output: Output.object({
        name: "email_lead_decision",
        schema: decisionSchema,
      }),
      maxRetries: 0,
      timeout: 20_000,
      maxOutputTokens: 2048,
    });
    const output = lmcEmailDecisionWireSchema.parse(generated.output);
    return lmcEmailDecisionSchema.parse({
      intent: output.intent,
      confidence: output.confidence,
      qualification: Object.fromEntries(
        Object.entries(output.qualification).filter(
          ([, value]) => value !== null,
        ),
      ),
      ...(output.requestedSlot ? { requestedSlot: output.requestedSlot } : {}),
    });
  } catch {
    throw new Error("LMC_MODEL_UNAVAILABLE");
  }
}

/** Reuses the existing text-model factory without changing voice model configuration. */
export function createLmcEmailModel(
  environment: Record<string, string | undefined> = process.env,
): LmcEmailModel {
  const key =
    environment.AI_CHAT_API_KEY?.trim() || environment.OPENAI_API_KEY?.trim();
  if (
    environment.NODE_ENV === "production" &&
    key &&
    (key.length < 16 ||
      /placeholder|change.?me|replace.?me|example|^(.)\1+$/i.test(key))
  )
    throw new Error("LMC_EMAIL_MODEL_REQUIRED");
  const model = createAgentModel(environment);
  if (!model) throw new Error("LMC_EMAIL_MODEL_REQUIRED");
  return { analyze: (prompt) => analyzeLmcEmail({ model, prompt }) };
}

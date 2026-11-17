import { MockLanguageModelV4 } from "ai/test";
import { expect, it } from "vitest";
import { analyzeLmcEmail } from "./emailModel";
const prompt = {
  tenantId: "private-tenant",
  trustedInstructions: "Extract explicit facts only.",
  business: {
    services: [{ name: "roof repair", aliases: [] }],
    tone: "professional",
  },
  untrusted: {
    message: { id: "message", subject: "Roof", text: "ZIP 33101" },
    history: [],
  },
};
const decision = {
  intent: "qualification",
  confidence: 0.9,
  qualification: {
    serviceType: null,
    zip: "33101",
    city: null,
    urgency: null,
    propertyType: null,
    name: null,
    phone: null,
  },
  requestedSlot: null,
};
function mock(text: string) {
  const calls: Parameters<MockLanguageModelV4["doGenerate"]>[0][] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      calls.push(options);
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: undefined },
        usage: {
          inputTokens: {
            total: 100,
            noCache: 100,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 40, text: 40, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
  return { model, calls };
}
it("sends a strict required/nullable schema through the actual SDK without tools or tenant metadata", async () => {
  const { model, calls } = mock(JSON.stringify(decision));
  expect(await analyzeLmcEmail({ model, prompt })).toEqual({
    intent: "qualification",
    confidence: 0.9,
    qualification: { zip: "33101" },
  });
  const call = calls[0]!;
  expect(call.responseFormat).toMatchObject({
    type: "json",
    schema: {
      additionalProperties: false,
      required: ["intent", "confidence", "qualification", "requestedSlot"],
    },
  });
  expect(call.tools ?? []).toHaveLength(0);
  expect(JSON.stringify(call.prompt)).not.toContain("private-tenant");
});
it("rejects invalid qualification facts after actual SDK object generation", async () => {
  const { model } = mock(
    JSON.stringify({
      ...decision,
      qualification: { ...decision.qualification, zip: "bad ZIP" },
    }),
  );
  await expect(analyzeLmcEmail({ model, prompt })).rejects.toThrow(
    "LMC_MODEL_UNAVAILABLE",
  );
});

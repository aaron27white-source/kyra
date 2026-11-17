import { demoSnapshot } from "@lobbystack/shared";
import type { LmcChannelRequest } from "@lobbystack/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
  createAgent: vi.fn(),
  generate: vi.fn(),
}));

vi.mock("@lobbystack/domain", () => ({ getCachedBusinessSnapshot: mocks.getSnapshot }));
vi.mock("./model", () => ({ createAgentModel: () => ({ modelId: "test" }) }));
vi.mock("./agent", () => ({ createReceptionistAgent: mocks.createAgent }));

import { createLmcEmailResponder } from "./emailResponder";

const request: LmcChannelRequest = {
  channel: "email",
  tenant: {
    id: demoSnapshot.businessId,
    settings: {
      ownerEmail: "owner@example.invalid",
      fromEmail: "team@example.invalid",
      physicalAddress: "123 Test Street, Miami, FL 33101",
      serviceAreaZips: ["33101"],
      serviceAreaCities: [],
      services: [{ id: "00000000-0000-4000-8000-000000000001", name: "HVAC repair", aliases: [] }],
      emergencyKeywords: ["gas leak"],
      emergencyText: "Leave the area and contact emergency services. Our team has been alerted.",
      priceInformation: "",
      tone: "professional",
      confidenceThreshold: 0.8,
      tools: ["availability", "book", "handoff"],
      followups: { enabled: false, maxTouches: 0, delaysHours: [], dailyCap: 10 },
    },
  },
  contact: { id: "lead-one", email: "lead@example.invalid" },
  message: { id: "message-two", subject: "Weekend service", text: "Are you open Saturday?" },
  history: [
    { role: "lead", text: "I need HVAC repair." },
    { role: "assistant", text: "What is your ZIP code?" },
    { role: "human", text: "We can help with that." },
  ],
};

describe("email receptionist responder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSnapshot.mockResolvedValue(demoSnapshot);
    mocks.generate.mockResolvedValue({ text: " We are open Saturday. " });
    mocks.createAgent.mockReturnValue({ generate: mocks.generate });
  });

  it("reuses the receptionist agent with tenant context, history and read-only tools", async () => {
    const responder = createLmcEmailResponder({ db: {} as never }, { AI_CHAT_API_KEY: "test-model-key-value" });
    await expect(responder?.reply(request)).resolves.toBe("We are open Saturday.");
    expect(mocks.getSnapshot).toHaveBeenCalledWith(expect.anything(), { businessId: demoSnapshot.businessId });
    expect(mocks.createAgent).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({
        snapshot: demoSnapshot,
        channel: "email",
        conversationId: "lead-one",
        toolPolicy: "information",
      }),
    }));
    expect(mocks.generate).toHaveBeenCalledWith({ messages: [
      { role: "user", content: "I need HVAC repair." },
      { role: "assistant", content: "What is your ZIP code?" },
      { role: "assistant", content: "We can help with that." },
      { role: "user", content: "Subject: Weekend service\n\nAre you open Saturday?" },
    ] });
  });

  it("fails closed when the tenant has no canonical snapshot", async () => {
    mocks.getSnapshot.mockResolvedValue(undefined);
    const responder = createLmcEmailResponder({ db: {} as never }, { AI_CHAT_API_KEY: "test-model-key-value" });
    await expect(responder?.reply(request)).resolves.toBeUndefined();
    expect(mocks.createAgent).not.toHaveBeenCalled();
  });
});

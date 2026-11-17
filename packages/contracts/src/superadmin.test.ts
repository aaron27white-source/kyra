import { expect, it } from "vitest";
import { superAdminClientDraftSchema } from "./superadmin";

const draft = {
  name: "Acme Heating",
  slug: "acme-heating",
  timezone: "America/New_York",
  businessType: "HVAC",
  ownerEmail: "OWNER@EXAMPLE.INVALID",
  hours: [{ dayOfWeek: 1, openMinutes: 480, closeMinutes: 1020 }],
  settings: {
    ownerEmail: "owner@example.invalid",
    fromEmail: "team@example.invalid",
    physicalAddress: "100 Main Street, Miami FL 33101",
    serviceAreaZips: ["33101"],
    serviceAreaCities: ["Miami"],
    services: [{ slug: "hvac-repair", name: "HVAC repair", aliases: ["AC repair"], durationMinutes: 60 }],
    emergencyKeywords: ["gas smell"],
    emergencyText: "Leave the property and contact emergency services immediately.",
    priceInformation: "The office confirms diagnostic fees.",
    tone: "professional" as const,
    confidenceThreshold: 0.8,
    tools: ["availability", "book", "handoff"] as const,
    followups: { enabled: false, maxTouches: 0, delaysHours: [], dailyCap: 0 },
  },
};

it("normalizes the managed owner identity and accepts a complete editable draft", () => {
  expect(superAdminClientDraftSchema.parse(draft).ownerEmail).toBe("owner@example.invalid");
});

it("rejects overlapping service labels and aliases before provisioning", () => {
  const duplicate = {
    ...draft,
    settings: {
      ...draft.settings,
      services: [
        draft.settings.services[0],
        { slug: "air-conditioning", name: "Air conditioning", aliases: ["AC REPAIR"], durationMinutes: 60 },
      ],
    },
  };
  expect(superAdminClientDraftSchema.safeParse(duplicate).success).toBe(false);
});

it("rejects a notification owner that differs from the invited owner", () => {
  expect(superAdminClientDraftSchema.safeParse({ ...draft, settings: { ...draft.settings, ownerEmail: "other@example.invalid" } }).success).toBe(false);
});

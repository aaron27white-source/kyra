import { describe, expect, it } from "vitest";

import { buildEmailQualificationPrompt } from "./conversation";

describe("email qualification prompts", () => {
  it("uses only the tenant's configured services", () => {
    const prompt = buildEmailQualificationPrompt(
      { services: [{ id: "00000000-0000-4000-8000-000000000001", name: "HVAC repair", aliases: ["air conditioning"] }] },
      {},
      false,
    );
    expect(prompt).toContain("HVAC repair");
    expect(prompt).not.toMatch(/roof|replacement/i);
  });

  it("asks only for facts that are still missing", () => {
    expect(buildEmailQualificationPrompt(
      { services: [{ id: "00000000-0000-4000-8000-000000000001", name: "HVAC repair", aliases: [] }] },
      { zip: "33101", serviceType: "HVAC repair" },
      true,
    )).toBe("Is the property residential or commercial?");
  });

  it("asks one useful question at a time when several facts are missing", () => {
    expect(buildEmailQualificationPrompt(
      { services: [{ id: "00000000-0000-4000-8000-000000000001", name: "HVAC repair", aliases: [] }] },
      {},
      false,
    )).toBe("Which service do you need: HVAC repair?");
  });
});

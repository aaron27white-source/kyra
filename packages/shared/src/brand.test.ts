import { describe, expect, it } from "vitest";
import { brand } from "./brand";

describe("LMC brand contract", () => {
  it("provides the agreed product identity for every channel", () => {
    expect(brand.name).toBe("Lead My Company");
    expect(brand.shortName).toBe("LMC");
    expect(brand.tagline).toBe("Lead My Company helps service businesses capture, engage, and convert more leads into booked jobs — automatically, 24/7.");
    expect(brand.domain).toBe("leadmycompany.com");
    expect(new URL(brand.url).hostname).toBe(brand.domain);
  });
  it("uses a local logo and neutral accessible theme tokens", () => {
    expect(brand.logoPath).toBe("/brand/lmc-logo.svg");
    expect(brand.colors.primary).toBe("#0f172a");
    expect(brand.colors.onPrimary).toBe("#ffffff");
    expect(brand.visualIdentityStatus).toBe("provisional");
  });
});
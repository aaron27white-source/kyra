import { describe, expect, it } from "vitest";
import { effectiveServiceIntakePolicy, validateServiceIntake } from "./service-intake";

describe("service-specific intake", () => {
  it("requires an address by default for newly configured onsite services, not legacy or remote services", () => {
    const legacy = effectiveServiceIntakePolicy(undefined, undefined);
    expect(legacy.serviceType).toBe("unspecified");
    expect(validateServiceIntake(legacy, {}).ok).toBe(true);

    const onsite = effectiveServiceIntakePolicy(undefined, { serviceType: "onsite", fields: {} });
    expect(validateServiceIntake(onsite, {})).toMatchObject({ ok: false, missingFields: ["serviceAddress"] });

    const remote = effectiveServiceIntakePolicy(undefined, { serviceType: "remote", fields: {} });
    expect(validateServiceIntake(remote, {}).ok).toBe(true);
  });

  it("retains a complete address in one answer and does not require a unit", () => {
    const policy = effectiveServiceIntakePolicy(undefined, { serviceType: "onsite", fields: { serviceAddress: "required" } });
    expect(validateServiceIntake(policy, { serviceLocation: { line1: "123 Main Street", unit: "", city: "Miami", region: "Florida", postalCode: "33101", country: "us" } })).toMatchObject({
      ok: true,
      serviceLocation: { line1: "123 Main Street", city: "Miami", region: "FL", postalCode: "33101", country: "US" },
    });
  });

  it("normalizes the country before schema validation and identifies an invalid country precisely", () => {
    const policy = effectiveServiceIntakePolicy(undefined, { serviceType: "onsite", fields: { serviceAddress: "required" } });
    expect(validateServiceIntake(policy, { serviceLocation: { line1: "123 Main Street", city: "Miami", region: "Florida", postalCode: "33101", country: "United States" } })).toMatchObject({ ok: true, serviceLocation: { country: "US", region: "FL" } });
    expect(validateServiceIntake(policy, { serviceLocation: { line1: "123 Main Street", city: "Miami", country: "United States of Atlantis" } })).toMatchObject({ ok: false, validationIssues: [{ field: "country", code: "invalid_country_code" }] });
    expect(validateServiceIntake(policy, { serviceLocation: { line1: "123 Main Street", city: "Miami" } as never })).toMatchObject({ ok: false, validationIssues: [{ field: "country", code: "invalid_country_code" }] });
  });

  it("asks only for a required postal code and validates a configured exact service area", () => {
    const policy = effectiveServiceIntakePolicy(undefined, { serviceType: "onsite", fields: { serviceAddress: "required", postalCode: "required" }, serviceArea: { allowedCities: ["Miami"], allowedPostalCodes: ["33101"] } });
    const missingZip = validateServiceIntake(policy, { serviceLocation: { line1: "123 Main Street", city: "Miami", country: "US" } });
    expect(missingZip).toMatchObject({ ok: false, reason: "missing_required_fields", missingFields: ["postalCode"] });
    expect(validateServiceIntake(policy, { serviceLocation: { line1: "123 Main Street", city: "Miami", postalCode: "33101", country: "US" } }).ok).toBe(true);
    expect(validateServiceIntake(policy, { serviceLocation: { line1: "123 Main Street", city: "Tampa", postalCode: "33602", country: "US" } })).toMatchObject({ ok: false, reason: "outside_service_area" });
  });

  it("allows service-specific policy overrides over business defaults", () => {
    const policy = effectiveServiceIntakePolicy({ serviceType: "onsite", fields: { serviceAddress: "required", issueDescription: "optional" } }, { serviceType: "remote", fields: { serviceAddress: "disabled", issueDescription: "required" } });
    expect(policy.fields).toMatchObject({ serviceAddress: "disabled", issueDescription: "required" });
    expect(validateServiceIntake(policy, {})).toMatchObject({ ok: false, missingFields: ["issueDescription"] });
  });

  it("fails closed instead of treating a malformed configured policy as legacy", () => {
    expect(() => effectiveServiceIntakePolicy(undefined, { serviceType: "onsite", fields: { serviceAddress: "must_have" } })).toThrow("Configured service intake policy is invalid.");
  });
});

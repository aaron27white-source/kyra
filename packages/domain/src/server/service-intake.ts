import { intakeFieldNames, serviceAddressSchema, serviceIntakePolicySchema, type IntakeField, type ServiceAddress, type ServiceIntakePolicy } from "@lobbystack/shared";

const onsiteDefaults: ServiceIntakePolicy["fields"] = { serviceAddress: "required" };

function cleanPolicy(policy: ServiceIntakePolicy): ServiceIntakePolicy {
  const fields = Object.fromEntries(Object.entries(policy.fields).filter(([, value]) => value !== undefined));
  const serviceArea = policy.serviceArea ? {
    ...(policy.serviceArea.allowedCities ? { allowedCities: policy.serviceArea.allowedCities.filter((value) => value !== undefined) } : {}),
    ...(policy.serviceArea.allowedPostalCodes ? { allowedPostalCodes: policy.serviceArea.allowedPostalCodes.filter((value) => value !== undefined) } : {}),
  } : undefined;
  return { serviceType: policy.serviceType, fields: fields as ServiceIntakePolicy["fields"], ...(serviceArea ? { serviceArea } : {}) };
}

export function effectiveServiceIntakePolicy(business: unknown, service: unknown): ServiceIntakePolicy {
  const parseConfigured = (value: unknown): ServiceIntakePolicy | undefined => {
    if (value === null || value === undefined) return undefined;
    const parsed = serviceIntakePolicySchema.safeParse(value);
    if (!parsed.success) throw Object.assign(new Error("Configured service intake policy is invalid."), { code: "invalid_service_intake_policy" });
    return cleanPolicy(parsed.data as unknown as ServiceIntakePolicy);
  };
  const businessPolicy = parseConfigured(business) ?? { serviceType: "unspecified" as const, fields: {} };
  const servicePolicy = parseConfigured(service);
  const selected = servicePolicy ?? businessPolicy;
  const defaults = selected.serviceType === "onsite" ? onsiteDefaults : {};
  return {
    ...selected,
    fields: { ...defaults, ...businessPolicy.fields, ...(servicePolicy?.fields ?? {}) },
    ...(servicePolicy?.serviceArea ? { serviceArea: servicePolicy.serviceArea } : businessPolicy.serviceArea ? { serviceArea: businessPolicy.serviceArea } : {}),
  };
}

export type ServiceIntake = { serviceLocation?: ServiceAddress; answers?: Partial<Record<IntakeField, string>> };
export type IntakeCheck = { ok: true; serviceLocation?: ServiceAddress; answers: Record<string, string>; required: boolean } | { ok: false; reason: "missing_required_fields" | "outside_service_area" | "invalid_service_address"; missingFields: IntakeField[]; validationIssues?: Array<{ field: string; code: string }> };

function normalizeAddress(raw: ServiceAddress): ServiceAddress {
  const country = String(raw.country ?? "").trim().toUpperCase();
  const normalizedCountry = ({ "UNITED STATES": "US", "UNITED STATES OF AMERICA": "US", USA: "US", "U.S.A.": "US", CANADA: "CA" } as Record<string, string>)[country] ?? country;
  const region = raw.region?.trim();
  const florida = normalizedCountry === "US" && region?.toUpperCase() === "FLORIDA";
  const postalCode = raw.postalCode?.trim().replace(/\s+/g, "");
  return { ...raw, country: normalizedCountry, ...(region ? { region: florida ? "FL" : region } : {}), ...(postalCode ? { postalCode } : {}) };
}

export function validateServiceIntake(policy: ServiceIntakePolicy, input: ServiceIntake): IntakeCheck {
  const answers: Record<string, string> = {};
  const provided: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.answers ?? {})) {
    if (!intakeFieldNames.includes(key as IntakeField) || policy.fields[key as IntakeField] === "disabled") continue;
    if (typeof value === "string" && value.trim()) {
      provided[key] = value.trim().slice(0, 2_000);
      if (key !== "customerName" && key !== "callbackPhone") answers[key] = provided[key]!;
    }
  }
  const required = Object.entries(policy.fields).filter(([, requirement]) => requirement === "required").map(([key]) => key as IntakeField);
  const missingFields: IntakeField[] = [];
  let serviceLocation: ServiceAddress | undefined;
  const addressAllowed = policy.fields.serviceAddress !== "disabled" || policy.fields.postalCode === "required";
  const rawAddress = addressAllowed ? input.serviceLocation : undefined;
  const addressNeeded = required.includes("serviceAddress") || required.includes("postalCode");
  if (rawAddress) {
    const parsed = serviceAddressSchema.safeParse(normalizeAddress(rawAddress));
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0]?.toString() ?? "serviceAddress";
      return { ok: false, reason: "invalid_service_address", missingFields: [field === "postalCode" ? "postalCode" : "serviceAddress"], validationIssues: [{ field, code: field === "country" ? "invalid_country_code" : `invalid_${field}` }] };
    }
    const address = parsed.data;
    serviceLocation = { line1: address.line1, city: address.city, country: address.country.toUpperCase(), ...(address.unit ? { unit: address.unit } : {}), ...(address.region ? { region: address.region } : {}), ...(address.postalCode ? { postalCode: address.postalCode.trim().toUpperCase() } : {}), ...(address.instructions ? { instructions: address.instructions } : {}) };
    if (!validPostalCode(serviceLocation.country, serviceLocation.postalCode)) return { ok: false, reason: "invalid_service_address", missingFields: ["postalCode"], validationIssues: [{ field: "postalCode", code: "invalid_postal_code" }] };
  }
  for (const field of required) {
    if (field === "serviceAddress") { if (!serviceLocation) missingFields.push(field); }
    else if (field === "postalCode") { if (!serviceLocation?.postalCode) missingFields.push(field); }
    else if (!provided[field]) missingFields.push(field);
  }
  if (missingFields.length) return { ok: false, reason: "missing_required_fields", missingFields };
  if (addressNeeded && serviceLocation && !isWithinServiceArea(policy, serviceLocation)) return { ok: false, reason: "outside_service_area", missingFields: [] };
  return { ok: true, ...(serviceLocation ? { serviceLocation } : {}), answers, required: addressNeeded || required.length > 0 };
}

function validPostalCode(country: string, value?: string): boolean {
  if (!value) return true;
  if (country === "US") return /^\d{5}(?:-\d{4})?$/.test(value);
  if (country === "CA") return /^[A-Z]\d[A-Z][ -]?\d[A-Z]\d$/.test(value);
  return /^[\p{L}\p{N}][\p{L}\p{N} -]{1,22}[\p{L}\p{N}]$/u.test(value);
}

function isWithinServiceArea(policy: ServiceIntakePolicy, address: ServiceAddress): boolean {
  const cities = policy.serviceArea?.allowedCities;
  const postalCodes = policy.serviceArea?.allowedPostalCodes;
  if (!cities?.length && !postalCodes?.length) return true;
  const cityAllowed = cities?.some((city) => city.trim().toLocaleLowerCase() === address.city.toLocaleLowerCase()) ?? false;
  const postalAllowed = postalCodes?.some((postal) => postal.replace(/\s/gu, "").toLocaleUpperCase() === address.postalCode?.replace(/\s/gu, "").toLocaleUpperCase()) ?? false;
  return Boolean((cities?.length ? cityAllowed : true) && (postalCodes?.length ? postalAllowed : true));
}

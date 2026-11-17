import { expect, it } from "vitest";
import { lmcBookingRulesSchema } from "./lmc";
import { lmcTenantBootstrapSchema, lmcTenantSeedSchema } from "./lmc-tenant-config";

it("keeps requester verification mandatory and bounds the existing seven-day scheduling horizon", () => {
  expect(lmcBookingRulesSchema.parse({})).toEqual({ minimumNoticeMinutes: 0, horizonDays: 7, requireVerifiedRequester: true });
  expect(lmcBookingRulesSchema.safeParse({ requireVerifiedRequester: false }).success).toBe(false);
  expect(lmcBookingRulesSchema.safeParse({ horizonDays: 8 }).success).toBe(false);
  expect(lmcBookingRulesSchema.safeParse({ minimumNoticeMinutes: -1 }).success).toBe(false);
});
it("rejects duplicate hours, overlapping service aliases and provider secrets before any write", () => {
  const minimal = { version: 1, tenantId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222", timezone: "America/New_York", hours: [], calendar: { connectionId: "33333333-3333-4333-8333-333333333333", staffId: "44444444-4444-4444-8444-444444444444", calendarId: "primary" }, enabled: true, settings: { ownerEmail: "owner@example.invalid", fromEmail: "team@example.invalid", physicalAddress: "100 Main Street, Miami FL 33101", serviceAreaZips: ["33101"], services: [{ slug: "roof-repair", name: "Roof repair", aliases: [], durationMinutes: 60 }], emergencyKeywords: ["active leak"], emergencyText: "Our team will contact you immediately.", tools: ["availability", "book", "handoff"], followups: { enabled: false, maxTouches: 0, delaysHours: [], dailyCap: 0 } } };
  expect(lmcTenantSeedSchema.safeParse(minimal).success).toBe(true);
  expect(lmcTenantSeedSchema.safeParse({ ...minimal, hours: [{ dayOfWeek: 1, openMinutes: 540, closeMinutes: 1020 }, { dayOfWeek: 1, openMinutes: 600, closeMinutes: 900 }] }).success).toBe(false);
  expect(lmcTenantSeedSchema.safeParse({ ...minimal, calendar: { ...minimal.calendar, accessToken: "never-accept-provider-credentials-here" } }).success).toBe(false);
  expect(lmcTenantSeedSchema.safeParse({ ...minimal, settings: { ...minimal.settings, services: [{ ...minimal.settings.services[0], aliases: ["Roof repair"] }] } }).success).toBe(false);
  expect(lmcTenantSeedSchema.safeParse({ ...minimal, timezone: "Invalid/Timezone" }).success).toBe(false);
});

it("rejects bootstrap slugs that canonical creation would normalize and break repeat lookup",()=>{
  const seed={userId:"22222222-2222-4222-8222-222222222222",name:"Pilot company",slug:"pilot-company",timezone:"America/New_York",businessType:"service_company"};
  expect(lmcTenantBootstrapSchema.safeParse(seed).success).toBe(true);
  expect(lmcTenantBootstrapSchema.parse({...seed,slug:"  pilot-company \n"}).slug).toBe("pilot-company");
  for(const slug of ["pilot--company","pilot-company-","Pilot-company","p"]){
    expect(lmcTenantBootstrapSchema.safeParse({...seed,slug}).success).toBe(false);
  }
});

import { z } from "zod";
import { lmcBusinessSettingsSchema } from "./lmc";

const settings = lmcBusinessSettingsSchema.omit({ services: true }).extend({
  services: z.array(z.object({
    slug: z.string().trim().regex(/^[a-z][a-z0-9-]{0,119}$/),
    name: z.string().trim().min(1).max(120),
    aliases: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
    durationMinutes: z.number().int().min(5).max(480),
  }).strict()).min(1).max(100),
}).strict().superRefine((value, ctx) => {
  const slugs = value.services.map(service => service.slug);
  const words = value.services.flatMap(service => [service.name, ...service.aliases]).map(word => word.toLowerCase());
  if (new Set(slugs).size !== slugs.length || new Set(words).size !== words.length) ctx.addIssue({ code: "custom", path: ["services"], message: "Services and aliases must be unique." });
  const followups = value.followups;
  if (followups.enabled && (followups.delaysHours.length < followups.maxTouches || followups.delaysHours.some((delay, index) => index > 0 && delay <= followups.delaysHours[index-1]!))) ctx.addIssue({ code: "custom", path: ["followups"], message: "Follow-up delays must increase and cover every touch." });
});

export const lmcTenantSeedSchema = z.object({
  version: z.literal(1),
  tenantId: z.string().uuid(),
  userId: z.string().uuid(),
  enabled: z.boolean(),
  timezone: z.string().max(80).refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }, "A valid IANA timezone is required."),
  hours: z.array(z.object({ dayOfWeek: z.number().int().min(0).max(6), openMinutes: z.number().int().min(0).max(1439), closeMinutes: z.number().int().min(1).max(1440) }).strict().refine(value => value.closeMinutes > value.openMinutes, "Closing time must follow opening time.")).max(7).refine(value => new Set(value.map(day => day.dayOfWeek)).size === value.length, "Each weekday appears once; omit closed days."),
  calendar: z.object({ connectionId: z.string().uuid(), staffId: z.string().uuid(), calendarId: z.string().trim().min(1).max(255) }).strict(),
  settings,
}).strict();
export type LmcTenantSeed = z.infer<typeof lmcTenantSeedSchema>;

export const lmcTenantIdentitySchema = z.object({ tenantId: z.string().uuid(), userId: z.string().uuid() }).strict();
export const lmcTenantBootstrapSchema = z.object({
  userId: z.string().uuid(),
  name: z.string().trim().min(2).max(160),
  slug: z.string().trim().min(2).max(120).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
  timezone: lmcTenantSeedSchema.shape.timezone,
  businessType: z.string().trim().min(2).max(120),
}).strict();
export const lmcTenantSetupSchema = z.discriminatedUnion("operation", [
  lmcTenantBootstrapSchema.extend({ operation: z.literal("bootstrap") }),
  lmcTenantIdentitySchema.extend({ operation: z.literal("calendar-authorize") }),
  lmcTenantIdentitySchema.extend({ operation: z.literal("inspect") }),
]);

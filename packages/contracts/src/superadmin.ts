import { z } from "zod";
import { lmcBusinessSettingsSchema } from "./lmc";
import { lmcTenantSeedSchema } from "./lmc-tenant-config";

const service = z.object({
  slug: z.string().trim().regex(/^[a-z][a-z0-9-]{0,119}$/),
  name: z.string().trim().min(1).max(120),
  aliases: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  durationMinutes: z.number().int().min(5).max(480),
}).strict();

export const superAdminClientDraftSchema = z.object({
  name: z.string().trim().min(2).max(160),
  slug: z.string().trim().min(2).max(120).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
  timezone: lmcTenantSeedSchema.shape.timezone,
  businessType: z.string().trim().min(2).max(120),
  ownerEmail: z.string().trim().email().max(320).transform((value) => value.toLowerCase()),
  hours: lmcTenantSeedSchema.shape.hours,
  settings: lmcBusinessSettingsSchema.omit({ services: true }).extend({ services: z.array(service).min(1).max(100) }).strict(),
}).strict().superRefine((value, ctx) => {
  const slugs = value.settings.services.map((item) => item.slug);
  const labels = value.settings.services.flatMap((item) => [item.name, ...item.aliases]).map((item) => item.toLowerCase());
  if (new Set(slugs).size !== slugs.length || new Set(labels).size !== labels.length) ctx.addIssue({ code: "custom", path: ["settings", "services"], message: "Services and aliases must be unique." });
  if (value.settings.ownerEmail !== value.ownerEmail) ctx.addIssue({ code: "custom", path: ["settings", "ownerEmail"], message: "The settings owner email must match the invited owner." });
});

export const superAdminDraftWriteSchema = z.object({
  draft: superAdminClientDraftSchema,
  expectedRevision: z.number().int().min(1).optional(),
}).strict();

export type SuperAdminClientDraft = z.infer<typeof superAdminClientDraftSchema>;

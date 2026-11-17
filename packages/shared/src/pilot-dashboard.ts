export const pilotDashboardCapabilityIds = [
  "leads",
  "email_settings",
  "business_profile",
  "services",
  "knowledge",
  "contacts",
  "voice",
  "integrations",
] as const;

export type PilotDashboardCapability = (typeof pilotDashboardCapabilityIds)[number];

/**
 * Maps authenticated pilot pages to the tenant capability that owns them.
 * The proxy remains the outer, static allowlist; this is the inner per-tenant
 * policy used by the dashboard and API handlers.
 */
export function pilotDashboardCapabilityForPath(pathname: string): PilotDashboardCapability | undefined {
  if (pathname === "/leads") return "leads";
  if (pathname === "/settings/email") return "email_settings";
  if (pathname === "/settings/business") return "business_profile";
  if (pathname === "/integrations") return "integrations";
  if (pathname === "/agent/services") return "services";
  if (pathname === "/agent/knowledge") return "knowledge";
  if (pathname === "/agent" || pathname === "/agent/basic-settings" || pathname === "/agent/rules" || pathname === "/calls" || /^\/calls\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pathname)) return "voice";
  if (pathname === "/appointments") return "voice";
  if (pathname === "/contacts" || /^\/contacts\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pathname)) return "contacts";
  return undefined;
}

export function hasPilotDashboardCapability(
  capabilities: readonly PilotDashboardCapability[],
  capability: PilotDashboardCapability,
): boolean {
  return capabilities.includes(capability);
}

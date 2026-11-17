/** Production defaults closed; legacy operation requires an explicit opt-out. */
export function isPilotMode(env: { NODE_ENV?: string; LMC_PILOT_MODE?: string }): boolean {
  return env.LMC_PILOT_MODE === "true" || (env.NODE_ENV === "production" && env.LMC_PILOT_MODE !== "false");
}

export const PILOT_WORKER_HEALTH_PATHS: ReadonlySet<string> = new Set([
  "/healthz", "/readyz", "/health/live", "/health/ready",
]);

export type PilotAdminRoute = { pattern: string; match: RegExp; methods: readonly string[] };
const read = ["GET", "HEAD"];
const apiRead = [...read, "OPTIONS"];
const post = ["POST", "OPTIONS"];

// Deliberately enumerate auth endpoints: the inherited catch-all also hosts OAuth/MCP.
const authPostPaths = [
  "sign-in/email", "sign-up/email", "sign-out",
  "email-otp/send-verification-otp", "email-otp/verify-email",
  "email-otp/request-password-reset", "email-otp/reset-password",
  "request-password-reset", "reset-password", "send-verification-email",
  "two-factor/enable", "two-factor/verify-totp", "two-factor/verify-backup-code",
];

export const PILOT_ADMIN_ROUTES: readonly PilotAdminRoute[] = [
  ...authPostPaths.map(path => ({ pattern: `/api/auth/${path}`, match: new RegExp(`^/api/auth/${path}$`), methods: ["POST"] })),
  ...["get-session", "verify-email"].map(path => ({ pattern: `/api/auth/${path}`, match: new RegExp(`^/api/auth/${path}$`), methods: ["GET"] })),
  { pattern: "/api/auth/reset-password/[token]", match: /^\/api\/auth\/reset-password\/[A-Za-z0-9_-]+$/, methods: ["GET"] },
  { pattern: "/api/account", match: /^\/api\/account$/, methods: apiRead },
  { pattern: "/api/businesses", match: /^\/api\/businesses$/, methods: [...apiRead, "PATCH"] },
  { pattern: "/api/businesses/switch", match: /^\/api\/businesses\/switch$/, methods: post },
  { pattern: "/api/leads", match: /^\/api\/leads$/, methods: apiRead },
  { pattern: "/api/leads/[leadId]", match: /^\/api\/leads\/[A-Za-z0-9_-]+$/, methods: apiRead },
  { pattern: "/api/leads/[leadId]/automation", match: /^\/api\/leads\/[A-Za-z0-9_-]+\/automation$/, methods: ["PATCH", "OPTIONS"] },
  { pattern: "/api/leads/[leadId]/reply", match: /^\/api\/leads\/[A-Za-z0-9_-]+\/reply$/, methods: post },
  { pattern: "/api/catalog", match: /^\/api\/catalog$/, methods: [...apiRead, "POST", "PATCH"] },
  { pattern: "/api/catalog/[serviceId]", match: /^\/api\/catalog\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, methods: ["PATCH", "DELETE", "OPTIONS"] },
  { pattern: "/api/business-hours", match: /^\/api\/business-hours$/, methods: [...apiRead, "PUT"] },
  { pattern: "/api/knowledge", match: /^\/api\/knowledge$/, methods: [...apiRead, "POST"] },
  { pattern: "/api/knowledge/[documentId]", match: /^\/api\/knowledge\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, methods: [...apiRead, "PATCH", "DELETE"] },
  { pattern: "/api/knowledge/snippets", match: /^\/api\/knowledge\/snippets$/, methods: [...apiRead, "POST"] },
  { pattern: "/api/knowledge/snippets/[snippetId]", match: /^\/api\/knowledge\/snippets\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, methods: ["PATCH", "DELETE", "OPTIONS"] },
  { pattern: "/api/uploads", match: /^\/api\/uploads$/, methods: ["POST", "PUT", "OPTIONS"] },
  { pattern: "/api/contacts", match: /^\/api\/contacts$/, methods: apiRead },
  { pattern: "/api/contacts/[contactId]", match: /^\/api\/contacts\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, methods: [...apiRead, "PATCH", "DELETE"] },
  { pattern: "/api/lmc/settings", match: /^\/api\/lmc\/settings$/, methods: [...apiRead, "PUT"] },
  { pattern: "/api/agent", match: /^\/api\/agent$/, methods: [...apiRead, "PATCH"] },
  { pattern: "/api/appointments", match: /^\/api\/appointments$/, methods: apiRead },
  { pattern: "/api/appointments/[appointmentId]", match: /^\/api\/appointments\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, methods: ["PATCH", "OPTIONS"] },
  { pattern: "/api/lmc/voice/number", match: /^\/api\/lmc\/voice\/number$/, methods: apiRead },
  { pattern: "/api/rules", match: /^\/api\/rules$/, methods: [...apiRead, "POST", "PATCH", "DELETE"] },
  { pattern: "/api/calls", match: /^\/api\/calls$/, methods: apiRead },
  { pattern: "/api/calls/active", match: /^\/api\/calls\/active$/, methods: apiRead },
  { pattern: "/api/calls/[callId]", match: /^\/api\/calls\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, methods: apiRead },
  { pattern: "/api/calls/[callId]/recording", match: /^\/api\/calls\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/recording$/i, methods: apiRead },
  { pattern: "/api/webhooks/openai/live", match: /^\/api\/webhooks\/openai\/live$/, methods: post },
  { pattern: "/api/lmc/settings/capture-token", match: /^\/api\/lmc\/settings\/capture-token$/, methods: post },
  { pattern: "/api/lmc/setup/calendar", match: /^\/api\/lmc\/setup\/calendar$/, methods: [...apiRead, "PATCH"] },
  { pattern: "/api/lmc/capture/[token]", match: /^\/api\/lmc\/capture\/[A-Za-z0-9_-]+$/, methods: post },
  { pattern: "/api/lmc/unsubscribe/[token]", match: /^\/api\/lmc\/unsubscribe\/[A-Za-z0-9_.-]+$/, methods: ["GET", "POST", "OPTIONS"] },
  { pattern: "/api/webhooks/lmc-email", match: /^\/api\/webhooks\/lmc-email$/, methods: post },
  { pattern: "/api/calendar/google/callback", match: /^\/api\/calendar\/google\/callback$/, methods: ["GET", "OPTIONS"] },
  { pattern: "/api/calendar/google/start", match: /^\/api\/calendar\/google\/start$/, methods: ["GET", "OPTIONS"] },
  { pattern: "/api/integrations", match: /^\/api\/integrations$/, methods: [...apiRead, "PATCH", "POST", "DELETE"] },
  { pattern: "/api/internal/superadmin/overview", match: /^\/api\/internal\/superadmin\/overview$/, methods: apiRead },
  { pattern: "/api/internal/superadmin/clients", match: /^\/api\/internal\/superadmin\/clients$/, methods: [...apiRead, "POST"] },
  { pattern: "/api/internal/superadmin/clients/[tenantId]/draft", match: /^\/api\/internal\/superadmin\/clients\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/draft$/i, methods: [...apiRead, "PUT"] },
  { pattern: "/api/internal/superadmin/clients/[tenantId]/invite", match: /^\/api\/internal\/superadmin\/clients\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/invite$/i, methods: post },
  { pattern: "/api/internal/superadmin/clients/[tenantId]/activation", match: /^\/api\/internal\/superadmin\/clients\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/activation$/i, methods: [...apiRead, "POST"] },
  { pattern: "/api/internal/superadmin/clients/[tenantId]/voice", match: /^\/api\/internal\/superadmin\/clients\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/voice$/i, methods: ["PATCH", "OPTIONS"] },
  { pattern: "/api/team/accept", match: /^\/api\/team\/accept$/, methods: ["GET", "POST", "OPTIONS"] },
  ...["/healthz", "/readyz", "/api/health/live", "/api/health/ready"].map(path => ({ pattern: path, match: new RegExp(`^${path}$`), methods: apiRead })),
  { pattern: "/", match: /^\/$/, methods: read },
  { pattern: "/leads", match: /^\/leads$/, methods: read },
  { pattern: "/contacts", match: /^\/contacts$/, methods: read },
  { pattern: "/contacts/[contactId]", match: /^\/contacts\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, methods: read },
  { pattern: "/agent/knowledge", match: /^\/agent\/knowledge$/, methods: read },
  { pattern: "/agent", match: /^\/agent$/, methods: read },
  { pattern: "/agent/basic-settings", match: /^\/agent\/basic-settings$/, methods: read },
  { pattern: "/agent/rules", match: /^\/agent\/rules$/, methods: read },
  { pattern: "/agent/services", match: /^\/agent\/services$/, methods: read },
  { pattern: "/appointments", match: /^\/appointments$/, methods: read },
  { pattern: "/integrations", match: /^\/integrations$/, methods: read },
  { pattern: "/calls", match: /^\/calls$/, methods: read },
  { pattern: "/calls/[callId]", match: /^\/calls\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, methods: read },
  { pattern: "/setup-required", match: /^\/setup-required$/, methods: read },
  { pattern: "/settings/email", match: /^\/settings\/email$/, methods: read },
  { pattern: "/settings/business", match: /^\/settings\/business$/, methods: read },
  { pattern: "/internal", match: /^\/internal$/, methods: read },
  { pattern: "/internal/clients", match: /^\/internal\/clients$/, methods: read },
  { pattern: "/internal/clients/new", match: /^\/internal\/clients\/new$/, methods: read },
  { pattern: "/internal/clients/[tenantId]", match: /^\/internal\/clients\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, methods: read },
  { pattern: "/internal/mfa", match: /^\/internal\/mfa$/, methods: read },
  { pattern: "/internal/mfa/setup", match: /^\/internal\/mfa\/setup$/, methods: read },
  { pattern: "/[locale]/auth-pages", match: /^\/(?:(?:en|fr)\/)?(?:login|signup|forgot-password|reset-password|verify-email|confirm-email-change|accept-invite)$/, methods: read },
  { pattern: "/[locale]/reset-password/[token]", match: /^\/(?:(?:en|fr)\/)?reset-password\/[A-Za-z0-9_.~-]+$/, methods: read },
  { pattern: "/favicon.ico", match: /^\/favicon\.ico$/, methods: read },
  { pattern: "/brand/[asset]", match: /^\/brand\/(?:lmc-logo|logo-icon|logo-wordmark)\.svg$/, methods: read },
  { pattern: "/locales/[locale]/[namespace].json", match: /^\/locales\/(?:en|fr)\/(?:common|auth|onboarding|lmc|nav|settings|agent|contacts|knowledge|widget)\.json$/, methods: read },
  { pattern: "/_next/static/[asset]", match: /^\/_next\/static\/[A-Za-z0-9_./~-]+$/, methods: read },
];

export function pilotAdminRoute(pathname: string): PilotAdminRoute | undefined {
  // Do not decode ambiguous separators or control characters into allowed segments.
  if (pathname.includes("%") || pathname.includes("\\") || pathname.split("/").some(part => part === "." || part === "..")) return undefined;
  return PILOT_ADMIN_ROUTES.find(route => route.match.test(pathname));
}

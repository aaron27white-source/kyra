import { randomBytes, randomUUID } from "node:crypto";
import { signActionToken } from "../../packages/domain/src/server/lmc/capabilities";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { config, proxy } from "./proxy";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("LMC_PILOT_MODE", undefined);
});
afterEach(() => vi.unstubAllEnvs());
const request = (path: string, method = "GET", headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost:3210${path}`, { method, headers: { origin: "http://localhost:3210", ...headers } });

it("denies inherited routes for every method before CSRF, locale redirects or maintenance", () => {
  vi.stubEnv("LOBBYSTACK_MAINTENANCE_MODE", "true");
  for (const path of ["/api/voice/test", "/api/mcp", "/api/auth/oauth2/register", "/api/billing", "/api/widget/lead", "/api/realtime", "/en/demo", "/embed.js", "/api/leads/one/unknown", "/api/leads/one/reply/extra", "/api/lmc/capture/opaque/extra", "/locales/en/auth.json/extra", "/brand/future-handler"]) {
    for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const response = proxy(request(path, method, { origin: "https://foreign.invalid" }));
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  }
});

it("allows concrete pilot actions while refusing other methods on allowed routes", () => {
  const tenant = "11111111-1111-4111-8111-111111111111";
  for (const [path, method] of [["/api/auth/sign-in/email", "POST"], ["/api/auth/two-factor/verify-totp", "POST"], ["/api/auth/get-session", "GET"], ["/api/businesses", "GET"], ["/api/businesses", "PATCH"], ["/api/leads", "GET"], ["/api/leads/lead/reply", "POST"], ["/api/leads/lead/automation", "PATCH"], ["/api/catalog", "GET"], ["/api/catalog", "POST"], [`/api/catalog/${tenant}`, "PATCH"], ["/api/business-hours", "GET"], ["/api/business-hours", "PUT"], ["/api/knowledge", "GET"], ["/api/knowledge", "POST"], [`/api/knowledge/${tenant}`, "GET"], ["/api/knowledge/snippets", "POST"], [`/api/knowledge/snippets/${tenant}`, "DELETE"], ["/api/uploads", "POST"], ["/api/uploads", "PUT"], ["/api/contacts", "GET"], [`/api/contacts/${tenant}`, "GET"], [`/api/contacts/${tenant}`, "PATCH"], ["/api/lmc/settings", "PUT"], ["/api/lmc/setup/calendar", "GET"], ["/api/lmc/setup/calendar", "PATCH"], ["/api/lmc/capture/opaque", "POST"], ["/api/lmc/capture/opaque", "OPTIONS"], ["/api/lmc/unsubscribe/opaque", "POST"], ["/api/webhooks/lmc-email", "POST"], ["/api/calendar/google/start", "GET"], ["/api/calendar/google/callback", "GET"], ["/api/integrations", "GET"], ["/api/integrations", "PATCH"], ["/api/integrations", "POST"], ["/api/integrations", "DELETE"], ["/api/internal/superadmin/overview", "GET"], ["/api/internal/superadmin/clients", "GET"], ["/api/internal/superadmin/clients", "POST"], [`/api/internal/superadmin/clients/${tenant}/draft`, "PUT"], [`/api/internal/superadmin/clients/${tenant}/invite`, "POST"], [`/api/internal/superadmin/clients/${tenant}/activation`, "GET"], [`/api/internal/superadmin/clients/${tenant}/activation`, "POST"], ["/api/team/accept", "POST"], ["/healthz", "HEAD"], ["/leads", "GET"], ["/contacts", "GET"], [`/contacts/${tenant}`, "GET"], ["/agent/knowledge", "GET"], ["/agent/services", "GET"], ["/setup-required", "GET"], ["/settings/email", "GET"], ["/settings/business", "GET"], ["/integrations", "GET"], ["/internal", "GET"], ["/internal/clients", "GET"], ["/internal/clients/new", "GET"], [`/internal/clients/${tenant}`, "GET"], ["/en/accept-invite", "GET"], ["/internal/mfa", "GET"]] as const) {
    expect(proxy(request(path, method)).status, `${method} ${path}`).toBe(200);
  }
  for (const [path, method] of [["/api/businesses", "POST"], ["/leads", "POST"], ["/setup-required", "POST"], ["/api/leads", "DELETE"], ["/api/auth/get-session", "POST"], ["/healthz", "DELETE"]] as const) {
    const response = proxy(request(path, method));
    expect(response.status, `${method} ${path}`).toBe(405);
    expect(response.headers.get("allow")).toBeTruthy();
  }
  expect(proxy(request("/api/leads/lead/reply", "POST", { origin: "https://foreign.invalid" })).status).toBe(403);
  expect(proxy(request("/api/internal/superadmin/clients", "DELETE")).status).toBe(405);
  expect(proxy(request(`/api/internal/superadmin/clients/${tenant}/invite`, "GET")).status).toBe(405);
  expect(proxy(request(`/api/internal/superadmin/clients/${tenant}/activation`, "DELETE")).status).toBe(405);
  expect(proxy(request("/api/lmc/setup/calendar", "PATCH", { origin: "https://foreign.invalid" })).status).toBe(403);
  expect(proxy(request(`/api/internal/superadmin/clients/not-a-uuid/draft`, "GET")).status).toBe(404);
  expect(proxy(request("/api/contacts/not-a-uuid", "GET")).status).toBe(404);
  expect(proxy(request("/api/knowledge/11111111-1111-1111-1111-111111111111", "GET")).status).toBe(404);
  expect(proxy(request("/internal", "POST", { "next-action": "admin-action" })).status).toBe(404);
});

it("allows the voice surfaces and only the reviewed call API methods in the pilot", () => {
  const tenant = "11111111-1111-4111-8111-111111111111";
  for (const [path, method] of [["/agent", "GET"], ["/agent/basic-settings", "GET"], ["/agent/rules", "GET"], ["/api/lmc/voice/number", "GET"], ["/calls", "GET"], [`/calls/${tenant}`, "GET"], ["/api/agent", "PATCH"], ["/api/rules", "GET"], ["/api/rules", "POST"], ["/api/rules", "PATCH"], ["/api/rules", "DELETE"], ["/api/calls", "GET"], ["/api/calls/active", "GET"], [`/api/calls/${tenant}`, "GET"], [`/api/calls/${tenant}/recording`, "GET"], ["/api/webhooks/openai/live", "POST"], [`/api/internal/superadmin/clients/${tenant}/voice`, "PATCH"]] as const) {
    expect(proxy(request(path, method)).status, `${method} ${path}`).toBe(200);
  }
  expect(proxy(request("/api/calls", "POST")).status).toBe(405);
  expect(proxy(request(`/api/calls/${tenant}`, "PATCH")).status).toBe(405);
  expect(proxy(request("/api/billing", "GET")).status).toBe(404);
  expect(proxy(request("/integrations/webhooks", "GET")).status).toBe(404);
});

it("blocks Server Actions and malformed dynamic segments even through allowed paths", () => {
  expect(proxy(request("/leads", "POST", { "next-action": "inherited-action" })).status).toBe(404);
  expect(proxy(request("/setup-required", "GET", { "next-action": "inherited-action" })).status).toBe(404);
  expect(proxy(request("/api/lmc/settings", "PUT", { "next-action": "inherited-action" })).status).toBe(404);
  expect(proxy(request("/internal/clients/new", "POST", { "next-action": "inherited-action" })).status).toBe(404);
  for (const path of ["/api/leads/one%2ftwo", "/api/leads/one%5ctwo", "/api/lmc/capture/token%00", "/api/leads//", "/api/lmc/capture/.", "/api/lmc/capture/.."])
    expect(proxy(request(path)).status, path).toBe(404);
});

it("covers assets with the proxy and permits only required static reads", () => {
  for (const path of ["/brand/lmc-logo.svg", "/locales/en/auth.json", "/_next/static/chunks/abc.js", "/favicon.ico"]) {
    expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url: path }), path).toBe(true);
    expect(proxy(request(path)).status, path).toBe(200);
    expect(proxy(request(path, "POST")).status, path).toBe(405);
  }
  expect(proxy(request("/_next/image")).status).toBe(404);
});

it("redirects the post-login root to CRM and enables the gate explicitly outside production", () => {
  expect(proxy(request("/")).headers.get("location")).toBe("http://localhost:3210/leads");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("LMC_PILOT_MODE", "true");
  expect(proxy(request("/api/billing")).status).toBe(404);
});

it("passes real signed unsubscribe capabilities through the pilot boundary", () => {
  const token = signActionToken({ tenantId: randomUUID(), leadId: randomUUID(), purpose: "unsubscribe" }, randomBytes(32).toString("hex"));
  expect(token).toContain(".");
  for (const method of ["GET", "POST", "OPTIONS"]) {
    expect(proxy(request(`/api/lmc/unsubscribe/${token}`, method)).status, method).toBe(200);
  }
  expect(proxy(request(`/api/lmc/unsubscribe/${token}`, "HEAD")).status).toBe(405);
  expect(proxy(request(`/api/lmc/unsubscribe/${token}/extra`)).status).toBe(404);
});

it("does not expose the auth catch-all's legacy OAuth preflight or unsupported HEAD methods", () => {
  for (const [path, method] of [["/api/auth/get-session", "HEAD"], ["/api/auth/get-session", "OPTIONS"], ["/api/auth/sign-in/email", "OPTIONS"], ["/api/auth/verify-email", "HEAD"]] as const)
    expect(proxy(request(path, method)).status, `${method} ${path}`).toBe(405);
});

it("refuses HEAD callbacks before they can consume a calendar OAuth capability", () => {
  expect(proxy(request("/api/calendar/google/callback?state=opaque", "HEAD")).status).toBe(405);
});

it("allows the real password-reset link callback without allowing other auth catch-all paths", () => {
  expect(proxy(request("/api/auth/reset-password/opaqueRecoveryToken?callbackURL=%2Fen%2Freset-password")).status).toBe(200);
  for (const method of ["HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
    expect(proxy(request("/api/auth/reset-password/opaqueRecoveryToken", method)).status, method).toBe(405);
  expect(proxy(request("/api/auth/reset-password/opaqueRecoveryToken/extra")).status).toBe(404);
});

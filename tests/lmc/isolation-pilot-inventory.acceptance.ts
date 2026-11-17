import { expect, it } from "vitest";
import { PILOT_ADMIN_ROUTES } from "@lobbystack/shared";
import { discoverApiRoutes } from "./support/isolation-inventory";
import { discoverPilotApiRoutes, PILOT_AUDIT_METHODS } from "./support/isolation-pilot-inventory";

it("independently resolves every allowlisted API pattern and inventories every HTTP method", () => {
  const raw = discoverApiRoutes();
  const routes = discoverPilotApiRoutes(raw);
  const expected = PILOT_ADMIN_ROUTES.filter(route => route.pattern.startsWith("/api/") || ["/healthz", "/readyz"].includes(route.pattern)).map(route => route.pattern).sort();
  expect(routes.filter(route => route.surface === "admin").map(route => route.path).sort()).toEqual(expected);
  expect(expected.length).toBeGreaterThanOrEqual(30);
  expect(routes.filter(route => route.surface === "worker").map(route => route.path).sort()).toEqual(["/health/live", "/health/ready", "/healthz", "/readyz"]);
  expect(routes.every(route => JSON.stringify(route.methods) === JSON.stringify(PILOT_AUDIT_METHODS))).toBe(true);
  expect(routes.some(route => route.surface === "landing")).toBe(false);
  expect(routes.some(route => route.path === "/api/mcp" || route.path === "/internal/live/attach")).toBe(false);
  expect(routes.find(route => route.path === "/api/auth/sign-in/email")?.file).toBe("apps/admin/app/api/auth/[...all]/route.ts");
  expect(routes.find(route => route.path === "/api/auth/email-otp/send-verification-otp")?.file).toBe("apps/admin/app/api/auth/email-otp/send-verification-otp/route.ts");
});

it("fails closed if a permitted handler disappears or an allowed pattern is not inventoried", () => {
  const raw = discoverApiRoutes();
  expect(() => discoverPilotApiRoutes(raw.filter(route => route.path !== "/api/leads"))).toThrow("PILOT_HANDLER_MISSING:admin:/api/leads");
  expect(() => discoverPilotApiRoutes(raw.filter(route => route.path !== "/api/auth/[...all]"))).toThrow("PILOT_HANDLER_MISSING:admin:/api/auth/");
  expect(() => discoverPilotApiRoutes(raw.filter(route => route.surface !== "worker"))).toThrow("PILOT_HANDLER_MISSING:worker:");
  expect(() => discoverPilotApiRoutes(raw, [...PILOT_ADMIN_ROUTES, { pattern: "/api/new-unprobed", match: /^\/api\/new-unprobed$/, methods: ["GET"] }])).toThrow("PILOT_HANDLER_MISSING:admin:/api/new-unprobed");
});

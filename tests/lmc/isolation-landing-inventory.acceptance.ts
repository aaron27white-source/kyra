import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";
import { discoverLandingHttpRoutes } from "./support/isolation-landing-inventory";
import { auditRouteId, discoverApiRoutes } from "./support/isolation-inventory";

it("discovers every Astro endpoint and deployment middleware independently, including nested discovery and dynamic paths", () => {
  const routes = discoverLandingHttpRoutes();
  expect(routes).toHaveLength(32);
  expect(routes.map((route) => route.path)).toEqual(
    expect.arrayContaining([
      "/api/status",
      "/openapi.json",
      "/.well-known/api-catalog",
      "/fr/blog/[slug].md",
      "/og/[...slug].jpg",
      "/[indexNowKey].txt",
      "/[[...path]]",
    ]),
  );
  expect(
    routes.every(
      (route) => route.surface === "landing" && route.methods.length === 7,
    ),
  ).toBe(true);
  expect(
    discoverApiRoutes().filter((route) => route.surface === "landing"),
  ).toEqual(routes);
  expect(
    auditRouteId(routes.find((route) => route.path === "/api/status")!, "GET"),
  ).toBe("landing:GET /api/status");
});

it("detects new endpoint/function files and rejects unresolved or conflicting routes", () => {
  const root = mkdtempSync(join(tmpdir(), "lmc-landing-inventory-"));
  const pages = join(root, "apps/landing/src/pages"),
    functions = join(root, "apps/landing/functions");
  try {
    mkdirSync(join(pages, "nested"), { recursive: true });
    mkdirSync(functions, { recursive: true });
    writeFileSync(
      join(pages, "nested/new.ts"),
      'export const POST=()=>new Response("ok");',
    );
    writeFileSync(
      join(functions, "_middleware.js"),
      "export async function onRequest(context){return context.next();}",
    );
    expect(discoverLandingHttpRoutes(root).map((route) => route.path)).toEqual([
      "/[[...path]]",
      "/nested/new",
    ]);
    writeFileSync(
      join(functions, "extra.js"),
      'export const onRequestPost=()=>new Response("ok");',
    );
    expect(
      discoverLandingHttpRoutes(root).map((route) => route.path),
    ).toContain("/extra");
    writeFileSync(
      join(pages, "unknown.ts"),
      "export const handler = unknownRuntimeHandler;",
    );
    expect(() => discoverLandingHttpRoutes(root)).toThrow(
      "UNRESOLVED_LANDING_ENDPOINT",
    );
    rmSync(join(pages, "unknown.ts"));
    writeFileSync(
      join(functions, "unresolved.js"),
      "export const handler=unknownRuntimeHandler;",
    );
    expect(() => discoverLandingHttpRoutes(root)).toThrow(
      "UNRESOLVED_LANDING_FUNCTION",
    );
    rmSync(join(functions, "unresolved.js"));
    writeFileSync(
      join(pages, "extra.ts"),
      'export const GET=()=>new Response("ok");',
    );
    expect(() => discoverLandingHttpRoutes(root)).toThrow(
      "DUPLICATE_LANDING_ROUTE",
    );
  } finally {
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("lmc-landing-inventory-")
    )
      throw new Error("UNSAFE_TEMP_CLEANUP");
    rmSync(root, { recursive: true, force: true });
  }
});

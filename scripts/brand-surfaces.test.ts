import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
describe("LMC public identity", () => {
  it("uses shared identity in admin metadata", () => {
    const source = read("apps/admin/src/app/root-document.tsx");
    expect(source).toContain("title: brand.name");
    expect(source).toContain("description: brand.tagline");
  });
  it("uses shared identity in landing SEO", () => {
    const source = read("apps/landing/src/lib/seo.ts");
    expect(source).toContain("SITE_URL = brand.url");
    expect(source).toContain("SITE_NAME = brand.name");
  });
  it("uses LMC copy in both dashboard locales", () => {
    for (const locale of ["en", "fr"]) {
      const source = read(`apps/admin/public/locales/${locale}/common.json`);
      expect(source).toContain("Lead My Company");
      expect(source).not.toMatch(/Kyra|LobbyStack/);
    }
  });
});

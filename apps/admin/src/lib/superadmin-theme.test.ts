import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const internalRoot = fileURLToPath(new URL("../../app/(app)/internal/", import.meta.url));
const componentRoot = fileURLToPath(new URL("../components/", import.meta.url));

const themedSurfaces = [
  `${internalRoot}layout.tsx`,
  `${internalRoot}page.tsx`,
  `${internalRoot}clients/page.tsx`,
  `${internalRoot}clients/new/page.tsx`,
  `${internalRoot}clients/[tenantId]/page.tsx`,
  `${componentRoot}managed-client-form.tsx`,
  `${componentRoot}superadmin-mfa.tsx`,
];

describe("Super Admin theme", () => {
  it("uses semantic theme colors across every internal surface", () => {
    const hardcodedLightPalette = /(?:bg-white|bg-zinc-|text-zinc-|border-zinc-)/;
    for (const file of themedSurfaces) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(hardcodedLightPalette);
    }
  });
});

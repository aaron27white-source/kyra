import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

for (const locale of ["en", "fr"]) {
  const html = readFileSync(resolve(`apps/admin/.next/server/app/${locale}/login.html`), "utf8");
  assert.ok(html.includes("<title>Lead My Company</title>"), `${locale}: incorrect dashboard title`);
  assert.ok(html.includes("Lead My Company"), `${locale}: missing visible product identity`);
  // Login prerenders a session-loading shell; its logo appears after hydration.
  assert.ok(html.includes("Checking your session") || html.includes("Vérification") || html.includes("/brand/lmc-logo.svg"), `${locale}: missing login shell`);
}
const landing = readFileSync(resolve("apps/landing/dist/index.html"), "utf8");
const title = landing.match(/<title>([^<]*)<\/title>/)?.[1];
assert.ok(title?.includes("Lead My Company"), "incorrect landing title");
const canonical = [...landing.matchAll(/<link\b[^>]*>/g)].map(([tag]) => tag).find(tag => /rel="canonical"/.test(tag));
assert.ok(canonical?.includes('href="https://leadmycompany.com/"'), "incorrect canonical host");
assert.ok(landing.includes("/brand/lmc-logo.svg"), "missing landing logo");
console.log("Verified LMC titles, landing logo and canonical URL in production HTML.");
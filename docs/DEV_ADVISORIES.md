# Dependency advisory triage — 2026-10-22

Release command: `pnpm audit --prod --audit-level high`. Refreshed after the Next 16.4.1 / DOMPurify 3.4.17 security update: **exit 0; high 0, critical 0**. The production graph reports one moderate and one low advisory. The full graph reports two high, three moderate and two low findings (seven distinct advisories). These are a timestamped registry result, not permanent exceptions; hosted CI refreshes the production gate. The prior production audit briefly returned two high and three critical findings before the security pins were updated; that failed result is not counted as a pass.

| Dependency | Severity | Scope | Disposition |
| --- | --- | --- | --- |
| [http-cache-semantics](https://github.com/advisories/GHSA-ch52-4w7c-c8xp) | high | Development only | Astro build/preview tooling; no patched version reported. The separate deployment ships only static output, without Astro's HTTP cache. Build trusted repository inputs and do not expose preview as the production server. |
| [braces](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) | high | Development only | Next ESLint plugin → fast-glob → micromatch. No patched version reported. Lint trusted repository files/globs; no external patterns are accepted by the pilot. No lint-parser or scanner-policy workaround is introduced. |
| [nodemailer](https://github.com/advisories/GHSA-39m8-27wv-hr27) | moderate | Production | SMTP provider dependency; DKIM header-unfolding denial of service, patched in 10.0.10. The default SmtpConfig/transport and per-message options do not configure local DKIM signing. Keep this visible as a production advisory and upgrade before enabling that signer; do not describe the dependency as remediated. |
| [katex](https://github.com/advisories/GHSA-238p-pmpm-9mq7) | low | Development only | Mintlify documentation tooling, outside pilot runtime. Patched line starts at 0.18.2; defer the documentation-toolchain migration during feature freeze and render only trusted docs inputs. |
| [postcss-selector-parser](https://github.com/advisories/GHSA-rj75-hqrm-r3gf) | moderate | Development only | Mintlify/Tailwind selector-parser chain. Patched version starts at 7.1.6; the retained older development-only chain needs a separate compatible migration. |
| [ip-address](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5) | moderate | Development only | next-devtools-mcp → MCP SDK → express-rate-limit. IPv6 zone-identifier parsing denial of service, patched in 10.7.4. It is absent from the reported production graph; keep development tooling local and do not feed it inbound lead data. Deferred tooling update, not an exception to the production severity gate. |
| [i18next-http-backend](https://github.com/advisories/GHSA-xvq9-wjp8-hwqf) | low | Production | Fixed in 4.0.2. Translation URLs remain fixed same-origin paths; no backend URL is accepted from lead content. Track the runtime advisory and defer a major migration in this freeze. |

The earlier sprintf-js row is not present in the refreshed registry advisory set; it is historical evidence rather than a current finding. No advisory was suppressed to obtain these results.

## Packaging boundary

The landing configuration explicitly uses `output: "static"` and has no server adapter. Astro and its compiler/integrations are development dependencies. Ship only its generated `dist` files on a separate static host; never ship a pruned Node installation as a landing server. Browser libraries remain declared as dependencies. This classification does not suppress advisories and the full development audit remains available.

The standalone `integrations/zapier` npm project is outside the pnpm workspace globs (`apps/*`, `packages/*`, `mintlify`), has no pilot runtime import, and is not invoked by the pilot build or dependency job. Its separate job and release dependency are removed from this workflow because the email pilot does not use it. Its previous 33 advisories (28 high, five moderate) are **not fixed**. Do not publish or enable that integration under this release; give it its own remediation/release gate if adopted. Preserve its source and license notices.

The inherited Railway project ID was removed. Production migrations require explicit `LMC_ENABLE_PRODUCTION_DEPLOY=true` and the user-owned `LMC_RAILWAY_PROJECT_ID` repository variables plus credentials; no automatic upstream deployment is configured. Hosted pilot integration execution and evidence remain pending.

## Local HTTP verification annotation

The production boundary runner binds its owned Next process to `127.0.0.1:3100` and sends only synthetic, credential-free loopback requests. Its literal local HTTP origin has one exact `react-insecure-request` Semgrep annotation. This is not a runtime transport exception: staging/public traffic still requires HTTPS. The script refuses non-local or mismatched database roles and requires a test/acceptance database. No scanner rules or parser checks were disabled.

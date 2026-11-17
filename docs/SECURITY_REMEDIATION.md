# Dependency security remediation

## Critical advisory checkpoint — 2026-10-21

The current registry audit was refreshed rather than reusing the reconnaissance
snapshot. It found three critical advisories in the resolved workspace graph.
This checkpoint fixes those three; it does not claim the whole audit is clean or
that every installed vulnerability was reachable from LMC's public APIs.

| Resolved package | Before | After | Actual dependency path |
| --- | --- | --- | --- |
| Next.js | 16.3.5 | 16.3.6 | admin runtime directly |
| proxy-addr | 2.0.7 | 2.0.8 | root next-devtools-mcp → MCP SDK → Express |
| shell-quote | 1.9.0 | 1.11.0 | root concurrently development launcher |

The matching Next ESLint plugin also moves to 16.3.6. A bounded override applies
the proxy-addr patch to vulnerable 2.x copies; the existing shell-quote override
is updated within its current major. pnpm's generated lockfile records the exact
resolved packages and integrities. No audit ignore/suppression or application
voice handler/controller change is introduced.

The maintainers describe conditional attack prerequisites: untrusted SVG input to
Node ImageResponse, an incorrectly trusted IPv6 subnet, or a line terminator after
a shell comment token. The dependency findings alone are not evidence that an LMC
deployment has those conditions. References:

- [Next.js ImageResponse advisory](https://github.com/vercel/next.js/security/advisories/GHSA-vcvr-r3jv-pc5j).
- [proxy-addr trust-subnet advisory](https://github.com/jshttp/proxy-addr/security/advisories/GHSA-jqcg-44mw-7w3h).
- [shell-quote comment-token advisory](https://github.com/ljharb/shell-quote/security/advisories/GHSA-pqg4-j6r4-53mv).

## Verification and remaining findings

Two behavioral regressions resolve the transitive copies actually used by the
launcher and MCP tooling. Before the upgrade, shell quoting accepted the dangerous
token sequence and the short IPv4-mapped IPv6 subnet trusted an unrelated IPv4
address. Both tests failed. Afterward, all four line terminators are rejected and
unrelated clients are not trusted; normal quoted arguments and a valid mapped
subnet remain positive controls. The tests do not execute generated shell text.

Fresh `pnpm audit --json` before/after results:

| Audit measure | Before | After |
| --- | ---: | ---: |
| Distinct advisory objects | 96 | 93 |
| Critical advisory objects | 3 | 0 |
| High advisory objects | 38 | 38 |
| Moderate advisory objects | 43 | 43 |
| Low advisory objects | 12 | 12 |
| pnpm metadata vulnerability total | 129 | 126 |

The metadata totals differ from the number of distinct advisory objects:
remaining metadata is high 46, moderate 65, low 15, critical 0. Both
audit invocations exit 1; the second remains red because noncritical findings still
exist. Raw before/after JSON is kept in task outputs, outside the repository.
No remaining advisory is treated as an accepted release exception by this document.

The two regressions, all 162 script tests and full script typecheck (including the
new regression source) pass. Admin tests pass 908 with 27 environment-dependent
skips; admin typecheck and Next 16.3.6 production build pass. Admin lint exits 0
with 17 warnings and no errors. The actual launcher smoke passes. The strengthened
startup role checks cover all five logins and reject invalid System metadata.
Post-upgrade real HTTP health tests pass. The unchanged exhaustive isolation test
remains red on 111/755 pairs; a separate fresh audit reports zero observed failures
and 644 unprobed pairs. These are incomplete gates, not overall release success.
Additional verification and further remediation are recorded in STATUS.md.
Full CI/security gates, remaining dependency fixes and operational release checks
must still be completed before the original goal can be marked done.

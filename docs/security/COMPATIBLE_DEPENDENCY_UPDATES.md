# Compatible dependency security updates — 2026-10-22

The audit at the preceding committed checkpoint had 93 distinct workspace
advisories and 126 metadata findings. This update applies verified registry
versions within existing supported major lines (including the existing 0.35
Sharp line), leaving required major migrations and unpatched advisories explicit.
Package integrity/engine metadata was verified before installation. The local
runtime is Node 22.22.1; the selected packages support it and CI's Node 22.12 floor.

| Package | Verified selected version |
| --- | --- |
| undici | 7.29.1 |
| fast-uri | 3.1.8 |
| ip-address | 10.7.1 |
| brace-expansion | 5.0.12 |
| engine.io | 6.6.10 |
| axios | 1.20.0 |
| dompurify | 3.4.16 |
| @grpc/grpc-js | 1.14.5 |
| devalue | 5.9.3 |
| smol-toml | 1.9.0 |
| source-map-js | 1.2.2 |
| sharp | 0.35.5 |
| hono | 4.13.11 |
| follow-redirects | 1.16.1 |
| vite | 8.2.4 |
| vitest | 4.1.12 |
| next | 16.3.8 |
| @next/eslint-plugin-next | 16.3.8 |
| @modelcontextprotocol/client | 2.3.1 |
| @modelcontextprotocol/server | 2.3.1 |
| @modelcontextprotocol/sdk | 1.32.1 |
| brace-expansion | 1.1.21 |
| vite | 7.3.7 |

Vite has two intentionally retained major lines: the landing/embed declarations
move to patched 7.3.7; root/admin testing explicitly declares 8.2.4, preserving
the existing OXC test configuration. Broad version-range overrides initially
selected Vite 7 for Vitest's multi-major peer range and produced a real typecheck
failure. Explicit peer hosts resolve that conflict without changing the test
compiler configuration or its assertions. Both MCP 1.x tooling and 2.x application
packages are patched in their existing lines.

## Behavioral evidence

The new URI test resolves fast-uri from the actual SDK → AJV dependency. The old
version serialized an injected port into authority 127.0.0.1 instead of the fixed
trusted host. The patched serializer rejects/prevents this while retaining a
valid numeric-port control. No network request is issued.

The Buffer tests resolve devalue from the actual Astro React integration. A
cached 5.9.2 baseline was separately verified to expose neighboring synthetic
bytes for both an explicit backing buffer and a Node allocation-pool view. Both
cases pass with 5.9.3, retaining the exact absence-of-neighbor-bytes assertion and
the correct owned payload. They execute serialization/parsing only.

During design, an initial uncommitted fixture used a generic Uint8Array with an
intentionally shared ArrayBuffer. That fixture also exposed its complete backing
buffer after 5.9.3 because the serializer preserves generic shared-buffer
relationships by contract. The maintainer's security fix specifically protects
Node Buffer allocation pools. The fixture was refined to that actual condition,
then checked against both vulnerable and fixed versions. This was not treated as
evidence of an LMC endpoint exploit or used to relax any committed acceptance test.

References: [fast-uri authority injection](https://github.com/fastify/fast-uri/security/advisories/GHSA-qw65-cvwx-89v3),
[devalue Buffer correction](https://github.com/sveltejs/devalue/releases/tag/v5.9.3),
[MCP release notes](https://github.com/modelcontextprotocol/typescript-sdk/releases).

## Pilot audit result

The pilot scope now gates production dependencies at high/critical, rather than
requiring remediation of every inherited development tool. Nodemailer was also
migrated to 10.0.9, including its global override. A real resolver regression
demonstrates cross-transport TLS identity reuse on 9.1.1 and passes on 10.0.9,
without DNS, sockets or email delivery. All six dependency regressions pass.

`pnpm audit --prod --audit-level high` now exits 0: zero high and zero critical,
with one moderate and one low remaining. Full development audit reports six
findings (two high, two moderate, two low). Astro and build integrations are
development dependencies because only static landing output is deployed.
This does not waive any production finding. See `docs/DEV_ADVISORIES.md` for
individual scope, remaining risks and the excluded standalone Zapier graph.

The earlier broad LMC run passed 121 tests and failed route coverage equality.
That remains an incomplete release gate, not a passing acceptance run. The pilot
must audit its effective allowlist and prove every excluded inherited route is
unreachable while retaining all 88 catalog-driven database probes.

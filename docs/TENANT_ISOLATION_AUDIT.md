# Tenant isolation audit

## Astro source inventory checkpoint (supersedes older counts)

All 31 Astro source endpoints and the Cloudflare Pages wildcard middleware are
now independently discovered from the source tree. The inventory includes Markdown
sidecars, static/dynamic discovery metadata, RSS, schema, images, the optional
IndexNow key endpoint and locale variants. It records all seven HTTP methods for
these 32 source routes, because deployment/static method behavior is not inferred
from an exported GET alone. `landing:` IDs cannot collide with admin/worker IDs.

New source endpoint/function files are detected; missing HTTP exports, unresolved
function exports and duplicate endpoint/function paths fail discovery. Two new
acceptance cases pass, including mutation controls; the four worker inventory
cases and strict audit typecheck still pass.

The generic landing scope marker is replaced by 224 concrete unprobed method/path
pairs. Current combined result: 88/88 tables, 85/735 pairs, 650 unprobed pairs,
zero observed probe failures; exit 1. Of the uncovered pairs, 426 belong to admin
and 224 to landing. No static/public exemption or behavioral coverage is inferred
from source discovery. Conditional static routes still need positive/disabled
controls, and Pages middleware needs deployment-aware behavioral verification.
The original exhaustive assertions and bound are unchanged. Earlier counts below
are historical. This inventory does not prove all requests to all rendered pages
or server actions; the original broader security/startup requirements also remain.


## Latest checkpoint (supersedes older counts below)

The independent inventory now covers every Next route handler (490 method/path
pairs) and the reachable worker HTTP source graph (21 pairs), totaling 511 pairs
across 137 paths. Worker IDs have a `worker:` prefix so another server cannot
accidentally satisfy an admin probe. Seven nested OAuth/discovery/embed paths
outside the admin `/api` directory are now included.

The combined report executes real behavioral proofs for 88/88 catalog tables,
64 admin pairs and all 21 worker pairs. Worker health uses the production Node
server, all methods, forged tenant headers/query fields and each readiness
dependency. The live attach proof uses real HTTP, controller/agent/domain/PG and
only fake external SDK/Redis transports in an isolated Vitest process. Coverage
requires the exact fresh test file to finish successfully with its one assertion
suite; failed/partial/missing output, process failure or a 45-second timeout
records no coverage. No prior success artifact is reused. The runner has positive
and missing-database negative acceptance controls.

Current result: 85/511 pairs, 426 unprobed pairs, one pending landing HTTP surface,
427 skipped entries and zero observed failures; exit 1. The Astro endpoints and
Cloudflare deployment middleware must still be independently inventoried and
classified/probed. They are not silently treated as tenant-free exceptions.
Original exhaustive assertions and timeout are unchanged. Read/CRUD protection
does not complete all mixed ownership/association reviews. Older sections below
are historical checkpoints, not the current completion status.


The database audit discovers its inventory from `pg_catalog`, not ORM table lists.
Next admin API inventory is independently discovered from exported route methods using the
TypeScript AST, including implicit HEAD and OPTIONS. At this checkpoint there are
88 application tables, 127 API paths, and 469 method/path pairs.

## Database checks implemented

- Every application table must enable and force RLS and have policies.
- All seven runtime roles must exist without superuser or BYPASSRLS flags.
- App, system, worker, and dispatcher are checked through actual authenticated
  connections. The app role must not inherit any other database role.
- Distinct synthetic A/B rows are committed on every table with constraints and
  RLS enabled. Administrative positive controls prove the target rows exist.
- The actual app connection reads its own allowed rows, then attempts foreign
  reads, updates, and deletes with selected-company tampering, service-actor
  spoofing, and absent-user contexts. Mutations roll back.
- INSERT probes create fresh committed prerequisite rows without a target row.
  Each candidate is inserted and rolled back administratively, materialized, then
  inserted and rolled back again to prove the exact payload is valid. The app
  connection attempts that payload under six foreign contexts. Only PostgreSQL
  authorization denial counts as a denied insertion; FK, uniqueness, or schema
  errors fail the audit. Column-grant checks reject probes whose extra forbidden
  columns could mask an RLS defect.
- A temporary test-owned table with FORCE RLS and a deliberately permissive policy
  must be detected by all four operation probes. It and its rows are removed.
- Fixture cleanup uses only the synthetic rows' exact primary keys, in dependency
  order. Required dependencies that cannot be seeded are failures, never coverage.

These tests found that `lobbystack_app` could select the `system` actor and access
another business without membership. Migration 0072 restricts that actor to a
separate authenticated identity. See [internal identity setup](SYSTEM_DATABASE_IDENTITY.md).
Original business creation and affiliate integration tests, actual global auth
email enqueue/deduplication/rollback, and the full domain suite were checked after
the change. No HTTP exploit was established from the original SQL finding.

## Running locally

Use an isolated local test database and explicit role URLs; the helper rejects
production or a non-test database and disallows privileged role fallback. Keep
credentials in a private environment file outside the repository. Load it in the
shell before running:

```sh
pnpm exec vitest run --config tests/lmc/vitest.config.mts \
  tests/lmc/isolation-inventory.acceptance.ts \
  tests/lmc/isolation-fixtures.acceptance.ts \
  tests/lmc/isolation-grants.acceptance.ts \
  tests/lmc/isolation-system.acceptance.ts \
  tests/lmc/isolation-tables.acceptance.ts \
  tests/lmc/isolation-inserts.acceptance.ts

pnpm exec tsx --tsconfig scripts/tsconfig.json \
  scripts/lmc-isolation-inventory.ts /absolute/output/inventory.json
```

The inventory artifact contains schema metadata and role assertions, not tenant
rows or connection credentials. It is generated outside source control; generating
it does not prove behavioral coverage.

## Remaining acceptance work

The exhaustive `isolation.acceptance.ts` gate executes the combined table/API
helper and remains red because 405 discovered admin method/path pairs have no
behavioral probe yet. No API method is counted as
behaviorally probed solely because it was discovered. Authenticated tenant A/B
requests, foreign resource IDs, mutations, transport credentials, and provider
webhooks need route-specific controls and persisted side-effect assertions.

The app mutation probes also do not establish equivalent CRUD coverage for every
other service login. Database user context is supplied by trusted server code;
these checks do not prove that arbitrary HTTP inputs cannot select that context.
The legacy schema still needs the requested `tenant_id NOT NULL` review/migration
for tenant-owned tables. Global auth/platform relations require explicit ownership
classification. Neither this document nor the focused database suite declares
the complete isolation requirement achieved.


## First live HTTP probes

`isolation-http.acceptance.ts` currently probes only GET, HEAD and OPTIONS for
`/api/leads` and `/api/leads/[leadId]`: six method/path pairs out of the discovered
469. It uses the running Next server, real Better Auth password sign-in/cookies,
real role-specific PostgreSQL connections, and two synthetic businesses. Own A/B
responses are positive controls; anonymous requests, forged actor/user headers,
foreign business headers/query parameters and foreign resource IDs must fail
without exposing foreign IDs/content. Read responses must prevent shared caching.
OPTIONS is checked as metadata-only. Sessions are signed out and synthetic
identities/accounts/leads are removed afterward. No real provider is called.

Start the local admin against the same isolated test database with fake providers
before running this HTTP suite. `LMC_TEST_HTTP_BASE_URL` can select another explicit
HTTP loopback origin; the default is `http://localhost:3000`. Sign-in must return the
exact synthetic user seeded in the guarded test database, binding the test to that
server/database. This focused suite does not count the auth catch-all route as
fully audited and does not replace the remaining route-specific mutation probes.


The combined report can be generated with an explicit output path:

```sh
pnpm exec tsx --tsconfig scripts/tsconfig.json \
  scripts/lmc-isolation-audit.ts /absolute/output/audit.json
```

This command exits unsuccessfully if any table/route is uncovered or any probe
fails. The current expected summary is 88/88 tables and 64/469 admin method/path pairs,
with 405 uncovered admin method/path pairs. The original acceptance assertions are
unchanged: this partial report cannot make the exhaustive gate green.


## Live mutation probes

`isolation-http-mutations.acceptance.ts` adds ten method/path pairs:
POST/OPTIONS human replies, PATCH/OPTIONS automation, GET/HEAD/PUT/OPTIONS email
settings, and POST/OPTIONS capture-token rotation. These are the email-specific
pairs; the public-key group below extends total admin coverage.

Real owner writes must succeed and persist the exact intended action in both
businesses without changing the other business. Human replies must create one
queued human message and one send job, pause automation, and replay idempotently.
Pause state, settings tone, and a new token's stored hash are checked directly.
The old capture token must fail hash verification after rotation.

Each denied attempt compares complete before/after state for all seven email
tables plus contacts, appointments and tenant-scoped outbox rows in both
businesses. Cases cover anonymous access, a viewer, foreign business headers and
queries, forged user/actor headers, foreign lead IDs, and an invalid CSRF origin.
Settings also reject another business's service IDs and a sender outside the
platform sending identity. OPTIONS must return only method metadata. The server
must report fake providers before these action probes proceed.

The probes found that the foreign-lead reply path returned HTTP 500 despite
rejecting the write. A typed domain error now returns 404 after membership checks,
matching lead reads and automation. The red HTTP case was retained and passed
after the production change.

Login fixtures obey the unchanged five-per-minute production rule. Only a rejected
429 sign-in is retried, at most twice, after a validated Retry-After of 0–60 seconds.
Successful or uncertain writes are never replayed by this retry path. The read
HTTP fixture's overall time allowance includes that quota wait; its access,
content, cache, and status assertions are unchanged. The email-response latency
acceptance tests and the original exhaustive 120-second gate are unchanged.


Migration 0073 and `isolation-tenant-columns.acceptance.ts` additionally verify
stored, non-null tenant identities on all directly business-owned legacy
relations. See [tenant identity scope and remaining ownership work](TENANT_IDENTITY.md).
The general catalog checker rejects missing or divergent generated keys on this
class of table. Mixed and globally scoped relations remain in every behavioral
probe and in the outstanding ownership review.


## HTTP fixture lifecycle

Probe groups can share one real authenticated A/B context, preserving the original
assertions and login quota. Standalone focused suites still use the same setup.
Fixtures sign out before removing synthetic identities.

A deliberate failing-probe regression holds a real parent FK lock, waits until
cleanup is blocked, and then commits an outbox row. The former teardown left that
row orphaned through ON DELETE SET NULL. Cleanup now locks the synthetic business
parents and deletes their queue rows and parents in one transaction, before the
remaining fixture/user cleanup. The same red concurrency case passes afterward.
All cleanup remains scoped to the randomly generated fixture IDs in the guarded
local test database. No background worker or production protection is disabled.


## Public-key API probes

`isolation-public-api.acceptance.ts` contributes 48 method/path pairs:
all seven standard methods on `/api/v1/contacts`, contact detail, `/services`,
`/staff`, `/me`, and `/business`, plus list/create and revoke dashboard key routes.
Of these, 21 are explicitly unsupported method handlers: they must return 405 in
the documented error shape, with the correct Allow header and unchanged database
state for both businesses. Supported operations have real positive controls.
The combined admin report now covers 64/469 pairs with 405 still unprobed.

Keys are issued through the real signed-in dashboard endpoint, used as bearer
credentials on the real Next server, and revoked through the dashboard. The test
proves only hashes are stored and lists do not disclose plaintext keys or hashes.
Anonymous requests, cookie-only public calls, viewers managing keys, insufficient
scopes, altered keys, revoked keys, foreign resource IDs and forged tenant/user
headers and query/body fields are exercised. A foreign cookie cannot override a
presented API key. Dashboard key mutations retain CSRF checks. Valid contact
creation/replay/conflict, contact updates, business updates and queued snapshot
refreshes are checked against persisted data in both directions.

The state comparison is built from the live catalog and includes every relation
with a tenant_id or business_id (71 at this checkpoint). Only the presented key's
legitimate last_used_at update is excluded when that operation is expected to
authenticate; its asynchronous write is settled before comparisons. Other key
state remains included. Redis rate counters are expected request metadata.
There are no fake handler responses, policy bypasses or disabled runtime quotas.
Fixtures require the server's fake provider mode and remove their queue work.

The combined audit shares one authenticated fixture among probe groups instead
of issuing another set of logins per group. Original exhaustive acceptance
assertions and their 120-second bound remain unchanged. Standalone focused
suites still exercise the same callbacks and real HTTP pipeline.

## Worker HTTP inventory still required

The 469-method inventory above currently covers the Next admin application.
Worker HTTP surfaces must also be independently inventoried and behaviorally
probed before the original all-API requirement can be declared complete.
Source review identifies `/health/live` and `/health/ready` in
`apps/worker/src/health.ts`, plus the feature-flagged `/internal/live/attach` in
`apps/worker/src/liveCalls.ts`. These are pending, not silently exempted or counted
as covered by the admin matrix. Health handlers currently accept methods without
an explicit method guard; attach admits POST only when enabled and checks its
internal service token. Tests must preserve real voice behavior and fake only
external transports. Remaining tenant ownership/association and security/product
requirements also remain active.


The combined report also retains `pendingHttpSurfaces: ["worker"]` and an explicit
`UNINVENTORIED_HTTP_SURFACE:worker` skipped entry. Completing only admin methods
therefore cannot turn the all-API gate green. The CLI distinguishes 405 uncovered
admin methods from the additional worker inventory gap (406 total skipped
entries at this checkpoint). Replace that marker with independently discovered
worker routes and real probes when the worker audit is implemented; do not
remove it merely to obtain a passing gate.

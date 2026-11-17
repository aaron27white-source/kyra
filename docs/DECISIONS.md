# Decisions

- 2026-10-19: Use the temporary GitLab upstream mirror linked by the official LobbyStack website because the original GitHub endpoint is unavailable. Preserve all existing copyright notices.
- 2026-10-19: Keep business_id unchanged during reconnaissance; decide the requested tenant_id migration only after catalog and policy inspection.
- 2026-10-19: Treat the latest request to execute everything as authorization for the complete scope, subject to the explicit license, baseline and credential gates. No real provider credentials are needed or requested during reconnaissance.
- 2026-10-19: User explicitly requested completing the full scope without stopping over licensing. Upstream MIT evidence was already obtained. Keep the existing notices in place and continue technical work.
- 2026-10-19: On Windows, execute the existing Unix-style build environment assignment with pnpm shell-emulator enabled. Record this invocation as environment setup; do not change production voice behavior for local tooling compatibility.

- 2026-10-20: Centralize public brand identity in @lobbystack/shared/brand. Keep package names, database roles and protocol identifiers stable to avoid voice/runtime migrations. Use a provisional neutral slate/white theme and local SVG logo; final brand approval remains a TODO.

- 2026-10-20: Preserve historical upstream blog comparisons and their original tests as attributed historical material. Do not rename upstream offers, customer claims or legal entity names into purported LMC facts. Remove the inherited legalName from LMC organization metadata; production legal documents require owner review.

- 2026-10-20: Add email persistence with tenant_id referencing businesses.id; preserve the existing voice schema and business context names. Use a separate durable email queue so the voice dispatcher and latency path remain unchanged. An unscoped dispatcher may discover queue tenant IDs/status/timing, with no payload privilege; workers read payloads only inside a tenant transaction.
- 2026-10-20: Run the new end-to-end acceptance gate explicitly with pnpm test:lmc against an isolated local database. Its incomplete workflow/audit harnesses must fail, and will not be skipped or treated as passing until implemented.

- 2026-10-20: Separate platform instructions from untrusted model input. Model output supplies bounded intent/qualification facts only; prices, availability, booking permissions and sender verification must be checked by application code before side effects.
- 2026-10-20: Conversation reply tokens contain a tenant UUID routing prefix and 128 random secret bits, fitting an email local-part. Store and compare a SHA-256 token hash inside the resolved tenant. Routing alone grants no access. Action links use HMAC-SHA256, explicit purpose and mandatory expiry for appointment changes; unsubscribe links may remain valid for the life of the lead.

- 2026-10-20: Public capture capabilities authorize creating a lead only; they never reveal or authorize the resulting conversation. Reply tokens are delivered only to the lead address in outgoing Reply-To and held in tenant-private queued work. Capture request IDs deduplicate only identical normalized payloads.
- 2026-10-20: Email ingestion requires all three receiving-server SPF/DKIM/DMARC results to pass. This strict initial policy may reject legitimate forwarded mail; do not relax it by trusting sender Authentication-Results. The [Resend receiving API](https://resend.com/docs/api-reference/emails/retrieve-received-email) documents server-computed verdicts and aligned DKIM semantics. Legacy messages without verdicts fail closed.
- 2026-10-20: Verify [Resend webhook signatures](https://resend.com/docs/webhooks/verify-webhooks-requests) over exact bounded bytes before provider fetches or tenant resolution. Preserve case in recipient local parts because conversation tokens are case sensitive. No attachments or arbitrary raw/download URLs are fetched.
- 2026-10-20: Persist a stable outbound payload and idempotency key before delivery. [Resend send idempotency keys](https://resend.com/docs/api-reference/emails/send-email) expire after 24 hours; retries after that provider window require an explicit fail-closed policy before production rollout. The current worker is not yet production wired. Bounce/complaint tenant tags only route a lookup; the stored provider delivery ID and recipient must match before suppression.
- 2026-10-20: Unsubscribe GET renders a confirmation form without changing consent, so link scanners cannot silently opt out a lead. POST supports signed one-click unsubscribe without a login. Every pending lead delivery rechecks suppression; sender opt-out applies to all conversations for that email within the tenant.

- 2026-10-21: Use canonical service/staff/calendar availability and transaction locks for email booking, with the existing calendar outbox. Email-only contacts retain a null phone; booking and rescheduling do not create SMS jobs. Persist Google event identities in busy blocks so a change can exclude only its own event. Unknown identities remain blocked. The [Google events list API](https://developers.google.com/workspace/calendar/api/v3/reference/events/list) supplies these IDs without fetching message or calendar description content.
- 2026-10-21: Schedule follow-ups relative to actual successful delivery and cap them per tenant per UTC day. Delayed work does not send a backlog of touches at once. Any reply, human takeover, opt-out or booking prevents queued follow-up delivery. Stop uncertain retries after a conservative 23-hour window and notify the owner rather than risk a send after provider idempotency expiry.
- 2026-10-21: Allow viewer CRM reads, scheduler conversation actions and administrator configuration changes. Read responses and model history redact action/reply capabilities, including copies in untrusted text. Keep the platform sender fixed; tenant settings may select only that tenant's active canonical services.
- 2026-10-21: Public intake and signed unsubscribe authenticate with scoped capabilities, not browser cookies; exempt only their exact path prefixes from CSRF origin checks. Keep operator mutations protected. Intake CORS permits anonymous cross-site forms without credentialed access. Provider webhooks remain signature protected.
- 2026-10-21: The email API defaults to fake providers locally, including when provider keys are present. Its public development-only signing fallback is forbidden in real mode. Real configuration requires HTTPS, non-placeholder signing material and real sending/receiving identities. Global production startup validation and legacy runtime fake-default integration are still pending.

- 2026-10-21: Scope email UI caches and component state by the selected workspace. Reset conversation/draft state on workspace changes; retain a human reply request ID across uncertain retries of the same text. Render all messages as plain React text, label owner notifications separately and show queued delivery as queued. Reuse canonical service IDs and the platform sender in settings. Capture tokens are displayed only after creation/replacement; replacement requires an explicit acknowledgment of existing-form invalidation. Email booking continues to use canonical hours/calendar data; a complete hours editor remains pending.

- 2026-10-21: Ship email lead capture as a small dependency-free classic script with isolated styles and fixed DOM copy. The script derives the capture origin from its own URL, sends no cookies, renders no inbound/API HTML and requires explicit unchecked follow-up consent. Reuse the same UUID for unchanged-payload retries after uncertain acceptance; changes get a fresh UUID. The install snippet appears only alongside a newly created/replaced capture token. A nonce on the embedding script is propagated to its style element.

- 2026-10-21: Enable the dedicated email consumer by default outside production; production explicitly opts in with LMC_EMAIL_WORKER_ENABLED=true so existing voice-only deployments retain their startup behavior. Share email environment validation across admin and worker. Drain serially, lease only the executing task and stop new claims on shutdown before closing database pools. Keep existing voice handlers/controllers unchanged.
- 2026-10-21: Reuse the existing text-model factory for email extraction, without tools, and pass a required/nullable JSON Schema to the SDK. Validate both wire and normalized decisions with the canonical contracts. The [official structured-output guide](https://developers.openai.com/api/docs/guides/structured-outputs) documents required properties and nullable optional values. JSON Schema at the SDK boundary avoids mixing the repository’s Zod versions. Keep trusted instructions separate from untrusted JSON conversation data, omit tenant metadata, bound execution and sanitize provider failures into human fallback.

- 2026-10-21: Separate internal system database authority from user-supplied SQL session actor settings. Migration 0072 introduces lobbystack_system with one-way app object-grant inheritance and no BYPASSRLS/superuser/create-role/create-database authority. The app login cannot inherit or SET ROLE into it. Trusted explicit system operations authenticate separately, assert their actual role in every environment, and must target the same database. Keep existing privileged transaction fixtures transactional through PostgreSQL-authorized SET LOCAL ROLE, restoring the prior role on success; real app logins cannot use that bridge. Require a fresh system secret and restart affected runtimes after migration/bootstrap. No real provider credential is needed for this local change.
- 2026-10-21: Tenant audit coverage comes from live catalog discovery and actual constrained A/B operations. Prove each INSERT candidate twice with the exact materialized payload before testing runtime denial; reject uniqueness/FK/type errors as invalid probes. Guard against column-privilege masking, and require detection of a deliberately permissive FORCE-RLS table. A discovered route or structural RLS check is not behavioral coverage. Keep the original exhaustive acceptance gate red until all table/API requirements are implemented.

- 2026-10-21: Prove HTTP authorization using valid owner mutations on both sides and complete persisted state comparisons for denied attempts. Keep canonical service and sender-identity validation in the HTTP audit. Map unavailable human-reply conversations to typed 404 errors after membership checks; preserve other domain behavior and the voice path. Local auth fixtures honor the existing Retry-After on rejected sign-ins, with bounded retries, without changing runtime quotas or replaying successful/uncertain writes.

- 2026-10-21: Add canonical tenant_id to directly business-owned legacy relations as a stored generated UUID NOT NULL of the existing business_id (id at the business root). Preserve the established voice/application payloads and make divergent tenant identity impossible at the database level. Keep the immutable raw migration authoritative and require introspection checks to preserve its expressions. Mixed global/business storage needs an explicit design; never fill those rows with a fictitious tenant to satisfy a NOT NULL check. Global/user/OAuth/affiliate classification remains a separate required review.

- 2026-10-21: Exercise public REST authentication with keys minted/revoked by the actual dashboard HTTP endpoints. Use valid tenant A/B writes as controls, exact persistent state comparisons across catalog-discovered scoped relations, and explicit 405/no-write checks for unsupported exports. Allow only the presented key's documented asynchronous usage timestamp and expected Redis counters; settle usage writes before comparisons. Reuse real signed-in fixtures across the combined audit without changing production quotas or original gate bounds. Keep worker HTTP discovery/probes explicit pending scope beyond the admin filesystem inventory.

- 2026-10-21: Authenticate the internal voice attach service as before, then bind its
  submitted call/session/business/channel/conversation claims to canonical worker-role
  PostgreSQL reads before deduplicating. Add an admission wrapper rather than editing
  the existing voice handler/controller. Keep omitted conversations compatible, reject
  stored cross-business conversation associations, and deny ended/blocked calls. Use
  real controller/domain/HTTP/PG acceptance with only external SDK/Redis transports
  faked; an authenticated 202 mismatch is not evidence of an anonymous exploit.

- 2026-10-21: Inventory all Next route handlers, including paths outside `/api`,
  and independently walk the worker's reachable local runtime modules for Node HTTP
  routing. Namespace worker coverage; fail on unresolved dynamic imports/routes or
  unknown listeners. Require fresh real HTTP/PG/controller admission proof in an
  isolated process so external SDK/Redis mocks cannot replace the admin runtime.
  Failed/missing/timed-out proof gives no coverage. Keep Astro/Cloudflare landing
  endpoint scope explicitly pending until independently classified and probed.

- 2026-10-21: Independently inventory Astro endpoint and Cloudflare function source,
  including dynamic/conditional static routes and wildcard middleware. Record seven
  potential methods until actual deployment behavior is probed. Replace the generic
  landing scope gap only with its concrete 224 unprobed pairs; readonly static output
  is not automatically a passed tenant-isolation proof.

- 2026-10-21: Reuse the shared brand module for public canonical/www/preview host
  redirects and operational discovery identity. Update only fixture branding in
  the existing eight middleware cases, retaining all branch/assertion coverage;
  add three regressions against the configured LMC identity. The preview Pages
  project hostname is a provisional domain-derived default, not an asserted live
  deployment. Keep static preview smoke checks separate from full A/B API coverage.

- 2026-10-21: Allow the email HTTP acceptance fixture to use the actual signed
  inbound provider adapter with only its external fetch transport fake. Remove
  fixture outbox rows and their business parent atomically under a parent lock in
  the general harness, extending the earlier HTTP-audit teardown fix. A regression
  first observed one orphaned outbox row and now observes none. Do not run separate
  LMC acceptance processes concurrently against the same test database: each real
  email worker dispatches all due tenant jobs, while fake transports belong to that
  process. Use the serial full suite for final evidence, not overlapping fake inboxes.

- 2026-10-21: Reuse the tenant capture capability for distinct direct/forward intake
  addresses, without granting thread/booking authority or implicit follow-up consent.
  Only the authenticated configured owner can forward explicit notification fields;
  do not guess recipients from quoted routing headers or arbitrary vendor formats.
  Keep contact/message/source/identity claims/job atomic. Serialize provider-event and
  RFC Message-ID aliases so changed IDs conflict and rekeyed deliveries deduplicate.
  Initial direct STOP uses the shared tenant-scoped suppression lock. Preserve normal
  history stripping except for the explicit forwarding parser, redact intake tokens
  from reads/prompts, and omit the owner's notification ID from the first lead reply.
  DNS/provider setup and a dedicated inbox-address settings panel remain separate work.

- 2026-10-21: Implement the offline demo as an executable workflow sharing the
  real HTTP/domain/PG/worker acceptance fixture, not a second business simulator.
  Use a separate explicitly consenting unanswered lead for follow-up/STOP so the
  booked email lead never receives a follow-up. Require local tokenized-test DB
  names and actual unprivileged runtime roles, reject destination override query
  options/real/production modes, serialize demos, and refuse existing due work.
  Emit only redacted synthetic transcripts and check fixture cleanup; explicit
  report output cannot overwrite existing files. The demo does not launch a
  persistent Next dashboard or establish exhaustive production-route coverage.

- 2026-10-21: Document architecture from the implemented source and keep operations
  procedures explicit about validation limits. Existing Compose restore scripts
  replace the selected database/cache/storage and are not generic WSL test-DB tools.
  Backups require confidentiality protection in addition to checksums; restore must
  reconcile provider effects after the recovery point before outbound replay. A
  documented procedure is not a completed restore drill or a production release gate.

- 2026-10-21: Add `/healthz` and `/readyz` to admin and worker as aliases of existing health behavior, preserving service identifiers and legacy paths. Admin aliases explicitly remain dynamic and delegate to existing handlers; automatic HEAD/OPTIONS and unsupported mutations are verified through real Next HTTP. Worker retains all-method routing compatibility. Dependency fault behavior is tested without external providers. Local preview storage uses a private generated signing secret outside the repository; readiness must not be forced green by bypassing dependencies.

- 2026-10-21: Refresh the dependency audit and patch the three current critical findings in a separate small change: Next/its ESLint plugin 16.3.6, proxy-addr 2.0.8 on vulnerable 2.x paths and shell-quote 1.11.0. Resolve transitive copies from their actual consumers for behavioral regression tests. Keep audit failures for every remaining advisory; do not add ignores or infer public exploitability from package presence. See SECURITY_REMEDIATION.md for source advisories, paths and before/after counts.

- 2026-10-22: Make workspace/npm audit, redacted full-history Gitleaks and strict Semgrep independent required CI jobs, and require the existing Zapier gate. Add the dedicated System role to ephemeral CI database configuration. Review false positives individually: exact historical Gitleaks fingerprints plus a fresh-secret regression, and two exact Semgrep audit annotations with preserved negative tests and installer boundary checks. Initially leave dependency findings and 38 parser reports (37 test files plus the schema) blocking; no blanket test/path/rule or parser-error waiver. See SECURITY_SCANNING.md.

- 2026-10-22: Resolve Semgrep import-type parsing by using explicit type-only namespace imports in the affected schema and tests. Verify all 38 emitted JavaScript ASTs are identical before writing the change, retain every test assertion and run strict scanning without parser exclusions. The final scanner has zero errors/findings; dependency audit failures remain required release blockers.

- 2026-10-22: Apply compatible security patches from verified registry metadata and keep existing major lines. Declare Vite 8.2.4 directly for root/admin tests so Vitest peer resolution preserves the existing OXC configuration; keep landing/embed on patched Vite 7.3.7. Validate dependency-level URI authority and real Node Buffer-pool boundaries against vulnerable and fixed versions. Record the initial generic-view fixture correction transparently, retain committed tests, and keep the remaining 11 workspace advisories and standalone audit failures blocking. See docs/security/COMPATIBLE_DEPENDENCY_UPDATES.md.

## 2026-10-22 — Pilot release scope

Freeze features and gate the effective email pilot surface rather than inherited-app completeness. Production HTTP routing defaults closed; legacy operation needs explicit pilot opt-out outside the pilot deployment. Keep all 88-table isolation probes. Production dependencies gate high/critical zero; development-only advisories are triaged separately without blanket suppression. Static landing ships generated files separately; unused standalone Zapier is excluded, not declared remediated. Tenant setup is CLI-based. Hosted CI and an executed isolated restore rehearsal remain release requirements.

## 2026-10-22 — Behavioral pilot isolation coverage

Inventory the effective concrete admin/worker APIs independently from implemented probes and require all seven methods on every permitted pattern. Retain all 88 catalog table CRUD/insert probes, exact coverage equality, no skips/failures and the original exhaustive timeout. A negative signature or malformed-body rejection alone does not count as a positive webhook/auth control. Current 220/231 coverage remains a failing gate.

OAuth's existing missing-session error redirect is a safe callback contract when its exact destination is reachable and neither stored capability is consumed; the new probe was refined from an initial generic-API 401 expectation to those stronger callback-specific invariants. Different authenticated users still require 403. No existing committed assertion was removed. Test-only signing keys are generated in a mode-600 WSL overlay outside the repository and are never printed, exported or committed.

Opt-out cancels pending lead-facing jobs in the suppression transaction. Already-running work retains the existing locked send-time suppression check; owner alerts and unrelated contacts remain active. This is an opt-out correction, not a new messaging feature.

## 2026-10-22 — Complete pilot API controls

Add only the GET password-reset callback actually emitted in recovery emails, increasing the method inventory to 238 rather than dropping routes to pass. Discovery resolves exact auth routes before the catch-all. The SDK verification-email sender remains intentionally disabled and receives a valid-input/no-persistence 404 control alongside the successful supported custom sender.

Signed webhook fixtures are loaded from an owner-private file only in test mode. They preserve server-side event registration and signature validation; incoming JSON never supplies a trusted event and no public fixture endpoint exists. Both default in-memory prepare and cross-process fixtures remain tested. Keys, queued codes and capability URLs are never printed or committed. The full API/table gate passes; pages/assets, tenant CLI, site cleanup, staging recovery and hosted CI remain required.


## Existing-tenant configuration checkpoint — 2026-10-22

The operator seed uses the existing canonical service catalog, business hours, staff assignments, calendar connection and native email settings; no table or migration was added. Optional FAQ/escalation/booking fields retain old email defaults, and voice controllers and voice availability behavior are unchanged. Requester verification remains mandatory. Both offered and final email booking slots enforce the configured notice and local-day horizon.

The trusted CLI uses separate actual App and Auth logins, always verifies their roles, preserves the verified-operator check and confirms administrator membership and calendar/staff ownership before writing. Auth alone reads the private email-verification column; no App grants were broadened. The strict JSON rejects provider credentials. New capture credentials go exclusively into a new mode-0600 private file, never stdout. Matching repeat configuration preserves the existing capture token and calendar freshness; changing the selected calendar/staff invalidates freshness and queues canonical reconciliation.

This checkpoint configures an existing tenant. Initial business/staff provisioning and Google OAuth state issuance still need a complete operator CLI path because their inherited public endpoints remain denied in pilot mode. The pilot release gate remains active; no hosted CI or staging rehearsal is claimed.


## Initial setup CLI — 2026-10-22

Initial business/staff provisioning and OAuth initiation are now available through the trusted operator CLI, completing the previously documented setup prerequisite. Bootstrap calls canonical createBusiness rather than inserting parallel tenant records; a matching authorized slug is idempotent and mismatched details fail. The operator must already be verified through the existing auth flow. Metadata inspection requires business administrator membership. OAuth issuance reuses the existing state cryptography and one-use storage contract, with a private URL, ten-minute lifetime, dedicated Auth write, strong signing secret and production redirect origin/path enforcement. The existing callback still requires the same signed-in account and encrypts provider tokens; no public start endpoint is enabled. Actual consent remains a manual step requiring the user's Google OAuth configuration.


## Static pilot public site — 2026-10-22

The sole Astro build profile now routes `pilot/src/pages` and copies `pilot-public`, producing six pages rather than the inherited 118-page marketing site. LMC contact/legal details are `[FILL]`; unsupported product/pricing/performance claims and upstream contact/legal content are absent from the output. There is no browser JavaScript, voice demo, analytics, form, runtime or database configuration. A bundled local Geist font includes its SIL OFL 1.1 notice. Existing copyright/attribution notices are preserved, with a narrowly defined artifact exception for exact required notice files.

Original source fixtures and tests are retained, including the unchanged 32-endpoint historical source-inventory assertions. An initial attempt to retire the old route sources conflicted with that inventory; the dedicated pilot source profile keeps those assertions intact while the complete output gate and real HTTP 404 controls prove that the old routes/assets are not published. There is no legacy publishing flag. Only the verified dist directory or its revalidated static archive may be deployed, separately from admin/worker. Hosted CI and production host header/method checks remain pending.


## Configured pilot dashboard access — 2026-10-22

CLI-configured LMC businesses can enter leads/email settings without completing voice/billing onboarding, but only after fresh Auth verification, canonical active-business resolution, active recognized membership and valid native LMC configuration. The flag alone is insufficient; every failed condition returns 404. Existing API permissions remain authoritative for operations and no onboarding stage/grant is changed. Paused automation still permits operator settings access. The non-pilot flow keeps its original onboarding check and full navigation. Pilot UI suppresses only links/widgets/providers that call closed endpoints, using a server-resolved mode prop.


## Preserve the favicon contract with the existing LMC asset

The full public method inventory found an allowlisted favicon with no physical file. Keep every original proxy test unchanged and resolve GET/HEAD internally to the existing LMC SVG, preserving MIME type and security headers. Metadata references that SVG directly. The default method gate still runs before the rewrite, so writes and Server Actions remain denied. No new handler or duplicate image is introduced. The production audit compares bytes for all emitted Next assets and every explicitly allowed public asset, and checks exact public-policy coverage.


## Dedicated production pilot profile and isolated recovery

Keep the legacy Compose and voice source intact. The dedicated prod profile exposes only loopback admin, fixes production pilot/real-provider settings and supplies a private provider template/preflight. The one-shot migrator applies existing immutable migrations and bootstrap credentials; the password-printing legacy init script is not mounted. Recovery uses the existing backup/restore functions with an explicit Compose file and a freshly allocated local-only project. New backups use umask 077; copied private local storage is assigned to the invoking operator so checksums work, while restore retains runtime ownership. All three production images must build or already exist with the exact selected revision label. A final exact inventory uses every compiled PgTable export, not the incomplete legacy convenience map; the same journal exclusions as the existing isolation audit are paired with an independent nonempty-journal preservation check. No application schema/grant/migration or original audit assertion is relaxed.

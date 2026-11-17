# Kyra full-codebase reuse audit for Lead My Company

Status: implementation baseline for `lmc/v1`

Audited revision: `b7c2287ae2243845be927735d20e40d2b57d9657`

Audit date: 2026-10-27

## Purpose and decision

Lead My Company is a product configuration and extension of Kyra/LobbyStack, not a second application. PostgreSQL, the Kyra domain layer, `ToolLoopAgent`, the worker, providers, dashboard, authentication, tenant model and operational controls remain canonical. LMC-specific code is justified only for channel adaptation, pilot administration, commercial configuration or a capability that the shared platform does not yet implement.

This inventory is a prerequisite to consolidation. It records what exists and what is hidden or disconnected; it is not a claim that every inherited feature is ready to expose in the production pilot. No duplicate LMC table or workflow should be removed until its data ownership, consumers, migration and rollback path are tested.

## Evidence and method

The audit covered the current tree, the commit history, the upstream description, all applications and packages, route and schema inventories, migrations, workers, provider adapters, capability gates, existing architecture/security documents and automated suites.

Current inventory at the audited revision:

- 3 runtime applications: Next.js Admin, Worker and Astro Landing.
- 11 shared packages, including the embed bundle.
- 34 dashboard page implementations and 133 Next API route handlers.
- 20 public `/api/v1` route handlers.
- 92 Drizzle `pgTable` declarations and 94 migration files.
- 86 non-test domain server modules.
- 217 Admin component/source modules and 377 test/acceptance/spec files.
- 132 files whose path identifies LMC-specific implementation or acceptance coverage.

History establishes three layers:

1. LobbyStack is the original shared platform foundation.
2. Kyra begins at `d5ba199` and extends that foundation with missed-call recovery, callbacks, assistant automation and back-office workflows.
3. LMC email/pilot work begins later and adds durable email-specific records, a guarded classifier, a database-backed email queue, pilot allowlists and managed-client administration.

The only configured remote in this checkout is the user's fork, `joaopramalho/kyra`. The historical upstream reference in `docs/RECON.md` is `aaron27white-source/kyra` at `edeb61a`; the LobbyStack mirror examined by the earlier reconnaissance was `55379a5`.

## Canonical target architecture

```text
LMC brand, plans, onboarding and channel configuration
                         |
Kyra dashboard + authenticated APIs + public APIs/MCP
                         |
       shared tenant-aware domain and agent core
                         |
 voice | SMS | email | web chat | widget | webhooks
                         |
 PostgreSQL/RLS + outbox + BullMQ/Redis + object storage
                         |
  provider adapters and tenant-scoped provider connections
```

`businesses.id` is the canonical tenant identifier. Channel records may preserve provider and consent metadata, but contacts, services, staff, hours, knowledge, appointments, conversations and business configuration must converge on the canonical tables and domain operations.

## Application and package inventory

| Area | Existing capability | Current LMC status | Classification | Required action |
| --- | --- | --- | --- | --- |
| `apps/admin` | Complete Next dashboard, auth, onboarding, business UI, REST/MCP/webhook endpoints, widget and browser voice entry points | Most routes compile and remain tested, but production pilot middleware exposes only a narrow allowlist and the pilot sidebar shows Leads and Email Settings | Existing but hidden / requires adaptation | Replace the single coarse pilot experience with reviewed tenant capabilities; enable each route only with its backend, authorization and acceptance coverage |
| `apps/worker` | BullMQ consumers, schedulers, outbox dispatch, knowledge extraction/indexing, calendar sync, notifications, retention, billing, telemetry, voice attach and Kyra assistant jobs | Shared worker remains active; LMC adds a separate PostgreSQL email consumer inside the same process | Reused and working; partially duplicated | Keep the runtime and handlers; move email orchestration toward shared agent/domain primitives and evaluate migration of the separate email queue to canonical jobs only after durability equivalence is proven |
| `apps/landing` | Static Astro marketing site and production public-boundary verification | LMC-branded/pilot static output is used | Reused and working | Keep the static security boundary and update product claims only as capabilities become production-ready |
| `packages/agent-core` | `ToolLoopAgent`, receptionist instructions/tools, knowledge search, availability/booking, appointment changes, messages, transfer/end-call controls, text-model factory, live controller and summaries | Voice, web voice, chat and SMS use shared components; LMC email primarily used a narrower structured classifier | Requires adaptation / duplicated by LMC | Make shared agent orchestration the email intelligence layer with an email-specific authorization policy; keep deterministic verification around side effects |
| `packages/domain` | Canonical business, CRM, conversation, booking, calendar, knowledge, notification, billing, OAuth, API, voice, assistant and audit logic | LMC scheduling and booking already call canonical functions, but lead/message/settings/handoff processing is separate | Reused and working; partially duplicated | Route email behavior through canonical services; define migration/compatibility for LMC lead and message records before consolidation |
| `packages/contracts` | Shared API, job, realtime, provider and domain schemas | LMC adds separate email/tenant configuration contracts | Reused; requires consolidation | Preserve strict channel schemas but share canonical business/contact/action concepts and avoid a parallel settings model |
| `packages/db` | PostgreSQL/Drizzle, role-specific clients, migrations, `FORCE RLS`, outbox, canonical business data | Seven LMC email tables plus managed-client drafts/operations coexist with canonical contacts, conversations, messages and jobs | Reused and working; LMC duplication present | Do not drop tables yet; document mappings, backfill and dual-read/write or cutover plan with rollback and cross-tenant probes |
| `packages/providers` | OpenAI-compatible AI/embeddings, Google Calendar, Twilio, SMTP/Resend transactional email, Resend webhook verification, crawling, storage, Polar | LMC delivery/ingress assumes global Resend credentials and sender configuration | Requires provider setup / new functionality genuinely required | Add tenant-scoped email connection adapters for managed Resend, client Resend where officially supported, Gmail, Microsoft Graph and forwarding |
| `packages/jobs` | Typed BullMQ queues, retry behavior, worker options and voice presence | Shared platform uses it; LMC email has its own durable database queue | Reused; duplicated by LMC | Compare leasing, ordering, retry, idempotency and tenant fairness before selecting one canonical queue path |
| `packages/shared` | Business snapshots, billing facts, booking/transfer policies, capability status and pilot route policy | `isPilotMode` and `PILOT_ADMIN_ROUTES` globally hide/deny most inherited functionality in production by default | Existing but restrictive | Introduce explicit tenant capability evaluation without weakening default-deny middleware or HTTP method controls |
| `packages/ai` | Shared AI utilities and token budgets | Available to inherited workflows | Reused and working | Reuse; no LMC replacement |
| `packages/config` | Validated environment/runtime configuration and trusted-client-IP handling | Used across applications | Reused and working | Extend only for provider-neutral configuration; tenant credentials belong in encrypted persistence, not per-client environment variables |
| `packages/embed` | Embeddable website widget loader | Runtime exists; new key issuance is restricted by capability policy | Existing but restricted | Retain restriction until product support and abuse controls are explicitly approved |
| `packages/telemetry` | Browser/node telemetry, redaction, meters and test helpers | Shared runtime and LMC gates use it | Reused and working | Add channel/provider dimensions without including message content or secrets |

## Functional subsystem inventory

### AI, reasoning and automation

| Subsystem | Evidence | Status | Consolidation decision |
| --- | --- | --- | --- |
| Receptionist orchestration | `packages/agent-core/src/agent.ts`, `tools.ts`, `instructions.ts` | Reused by voice, web chat and SMS; email disconnected | Extend the same agent for email with a channel policy; do not create another agent framework |
| Business personalization | `business_context_snapshots`, snapshot cache/refresh, structured services/hours/rules | Reused and working | Snapshot is the common read model for all agent channels |
| Knowledge reasoning | `searchKnowledgeEvidence`, snippets, vector chunks and agent `searchKnowledge` tool | Working for inherited agents; absent from the primary LMC email classifier | Connect email to this tool under tenant scope; do not add a second RAG stack |
| Availability and booking | Canonical booking and receptionist actions plus calendar busy blocks | Reused by LMC through `findEmailAvailabilityInTransaction` and `bookEmailAppointmentInTransaction` | Retain canonical transaction/recheck; booking interest must remain read-only until exact slot selection and verification |
| Appointment changes | Canonical lookup/verification/OTP/cancel/reschedule tools | Voice implementation is mature; LMC has separate email checks | Adapt identity proof per channel, then converge on canonical change operations |
| Missed-call/callback automation | `assistant/*`, worker assistant jobs and scheduler | Existing and operational subject to provider configuration | Reuse unchanged; email work must not alter voice/SMS behavior |
| Human escalation/takeover | Transfers/messages/notifications in shared domain; LMC `handoff.ts` and AI pause | Both exist | Preserve channel-specific handoff state while converging owner work into the canonical inbox/conversation model |
| Follow-up automation | Canonical outreach automation plus LMC email touches | Duplicated | Define one policy engine with channel consent adapters before migration |

### Business management and CRM

| Subsystem | Canonical implementation | Current LMC state | Classification |
| --- | --- | --- | --- |
| Business profile/workspaces | `businesses`, memberships, invitations, `/api/businesses` | Managed-client bootstrap materializes canonical business data | Reused and working |
| Services/staff/hours/closures | Canonical tables, catalog APIs and Agent pages | Managed-client draft copies data into canonical tables; pages hidden in pilot | Existing but hidden; draft/settings duplication requires adaptation |
| Contacts | Canonical contacts/domain/API/pages | LMC lead gains a canonical `contactId`, but keeps separate identity/state | Partially integrated |
| Leads and inbox | Canonical inbox/messages plus LMC lead CRM | Pilot uses LMC Leads; inherited Messages/Contacts are denied | Duplicated/disconnected |
| Conversations/messages | Canonical `conversations`, `conversation_sessions`, `messages`; LMC `lmc_messages` | Separate persistence and history formats | Duplicated; migration required |
| Appointments | Canonical appointments and audit/outbox flow | LMC stores canonical `appointmentId` and books canonically | Reused and working |
| Calendar | Google OAuth, encrypted connection, busy-block sync and reconciliation | Managed workflow requires owner-bound Google Calendar; pilot setup route is exposed | Reused and working; additional providers genuinely required |
| Notifications | Canonical notification/preferences/deliveries and worker handlers | LMC owner alerts are separate outbound email messages | Partially duplicated |
| Quotes/invoices/back office | Kyra assistant tables/domain/pages | Present but hidden by pilot | Existing but hidden; validate applicability before exposure |

### Communication channels

| Channel | Implementation | Status |
| --- | --- | --- |
| Telephone voice | GPT-Live/WebRTC/SIP, Twilio numbers, live controller, tools, recordings/transcripts/summaries | Reused and working when provider configuration is valid; preserve latency and consent controls |
| Browser voice | Session endpoint and shared live stack | Available according to capability facts; hidden in pilot |
| SMS | Canonical inbound storage/manual replies, opt-out/consent; Kyra assistant responder and alerts | Alert SMS available; AI SMS intentionally restricted as a product capability |
| Email | LMC capture/forward/webhook, dedicated queue, classifier, replies, follow-ups, suppression, booking and owner alerts | Working for one global Resend configuration; intelligence and data model only partially unified; tenant-owned providers absent |
| Website chat | Widget conversations and shared receptionist agent | Runtime exists; issuance of new widget keys is restricted |
| Widget/lead capture | Embed bundle, widget APIs and LMC capture form | Implemented through two surfaces | Requires product/identity consolidation, not a third widget |
| Public API/webhooks/MCP | Scoped hashed API keys, REST resources, webhook delivery and OAuth/MCP | Implemented and tested; denied by pilot except explicitly allowed paths | Existing but hidden; capability-based activation required |

### Knowledge infrastructure

The shared platform already implements document uploads, storage objects, document extraction, text chunking, website ingestion, snippets, embedding generation, pgvector/hybrid retrieval, source lifecycle, reindexing, telemetry and snapshot projection. The Admin Knowledge page and worker handlers exist. This subsystem is **reused and working outside the pilot**, **hidden in the pilot**, and **requires provider setup** for storage, crawling and embeddings in production. LMC must expose and consume it; it must not add parallel document, chunk or embedding tables.

Supported extraction code covers PDF, DOCX and text-compatible formats; route/UI validation must remain the source of truth for the exact advertised extension list. Production completion requires exercising upload, extraction, embedding, search, update and deletion with the configured Railway storage and embedding providers.

### Platform and operations

| Capability | Status and finding |
| --- | --- |
| Authentication/MFA | Existing Better Auth flows, email verification, sessions, invitations and MFA; Super Admin adds platform-role and MFA requirements. Reused and working. |
| Authorization | Membership roles and domain/API checks exist. Pilot route authorization is separate and default-deny. Replace neither with UI-only checks. |
| Tenant isolation | `businesses.id` is canonical; role-specific clients, transaction GUCs and `FORCE RLS` are extensively tested. Exhaustive catalog/route probes remain mandatory after every expansion. |
| OAuth | Google Calendar and general OAuth/MCP grant infrastructure exist. Gmail/Microsoft mailbox authorization is not implemented and must use separate provider scopes/callback validation. |
| API keys/webhooks | Canonical implementation exists with hashing, scopes, idempotency, SSRF protection, retries and delivery history. Hidden by pilot. |
| Storage | Local and S3-compatible adapters, signed access and retention jobs exist. Requires production provider configuration. |
| Jobs/queues | BullMQ/Redis canonical queues plus outbox are mature; LMC email uses a second PostgreSQL queue. Consolidation requires an explicit durability migration. |
| Billing/usage | Polar, billing ledgers, caps, usage and unit economics exist. Hidden in pilot and should be enabled only after the LMC commercial model is mapped. |
| Analytics/telemetry | Dashboard analytics, product events, PostHog and OTEL abstractions exist. Hidden in pilot; provider configuration required. |
| Rate limits/security | Redis/API limits, CSRF, webhook signatures, email authentication checks, secret encryption, redaction and static-route method controls exist. Preserve them while expanding capabilities. |
| Deployment | Railway/Docker documentation, health/readiness, maintenance mode, backup/restore and release gates exist. Provider DNS/credentials remain operational prerequisites rather than code defaults. |

## Dashboard route status

The inherited dashboard includes Overview, Agent settings, Knowledge, Services, Rules, Calls, Messages, Contacts, Appointments, Analytics, Integrations/Webhooks, Teams, connected apps, notifications, API keys, widget, phone, plan, usage, appearance and account settings. Their pages and APIs still exist; pilot mode intentionally hides most navigation and `apps/admin/proxy.ts` denies routes not listed in `PILOT_ADMIN_ROUTES`. Google Calendar settings are now a reviewed pilot capability; webhooks and unrelated inherited integration controls remain closed.

Therefore these features are not “removed.” They are **existing but hidden/disabled for the production pilot**. Restoration must proceed by capability slice:

1. Add the exact page and API method inventory for the slice.
2. Confirm canonical authorization and tenant transaction usage.
3. Validate provider dependencies and empty/error states.
4. Add A/B tenant and unsupported-method acceptance probes.
5. Add the capability to tenant policy and navigation.
6. Keep the default-deny catch-all.

Simply setting `LMC_PILOT_MODE=false`, showing all navigation, or globally admitting inherited routes is explicitly rejected.

## LMC duplication and migration map

| LMC construct | Canonical overlap | Current bridge | Safe next step |
| --- | --- | --- | --- |
| `lmc_settings.config` | business profile, services, hours, receptionist profile/rules and channel settings | Managed bootstrap materializes canonical services/hours; runtime still reads JSON config | Split common canonical facts from email-only policy; introduce compatibility reads before removing fields |
| `lmc_leads` | contacts, inbox items, conversations and appointment linkage | stores `contactId` and `appointmentId` | Define identity matching, lead status mapping and canonical conversation ownership; backfill with tenant checks |
| `lmc_messages` | canonical messages/conversations/outbox | keeps email headers/provider state and thread capabilities | Preserve email metadata in a channel extension while migrating common message fields |
| `lmc_events` | audit logs, product events and webhook/provider events | separate email audit trail | Establish event taxonomy and retention requirements before consolidation |
| `lmc_jobs` | BullMQ jobs and transactional outbox | dedicated DB leases/retries/idempotency | Prove equivalent crash recovery, ordering and reconciliation before migration |
| `lmc_suppressions` | SMS consent/suppression concepts and contact preferences | channel-specific email suppression | Keep channel-specific legal state; expose it through a shared consent service |
| `lmc_rate_windows` | canonical API/provider limits | email-specific caps | Move policy into a shared limiter only when atomic semantics remain equivalent |
| Structured email classifier | shared `ToolLoopAgent` | classifier gates intent before deterministic LMC worker actions | Use shared agent for understanding/knowledge while deterministic code retains authorization and side-effect checks |

No table deletion or destructive migration is authorized by this audit.

## Multi-tenant email gap analysis

What works today:

- authenticated Resend inbound events and forwarding ingestion;
- durable tenant-scoped LMC leads/messages/jobs;
- safe threading and reply capabilities;
- suppression, duplicate/replay handling and bounded delivery reconciliation;
- canonical availability and booking rechecks;
- global Resend delivery plus owner notifications.

What is genuinely new work:

- encrypted per-tenant email connection and sender-identity records;
- provider-neutral inbound/outbound connection interfaces and routing;
- LMC-managed Resend sender/domain authorization;
- client-owned Resend connection only through capabilities officially supported by Resend;
- Gmail OAuth, watch/Pub/Sub lifecycle, history cursor recovery and send authority;
- Microsoft OAuth, Graph subscriptions/renewal/delta recovery and send authority;
- forwarding verification plus an independently authorized outbound identity;
- connection health, revoked-token handling, diagnostics, test/reconnect/disconnect UX;
- provider-scoped webhook routing, deduplication and tenant resolution that never trusts message headers to choose a tenant.

These credentials must be encrypted and tenant-scoped. They must not become one Railway variable per customer, must not be returned to the browser or Super Admin, and must be usable only after server-side ownership/sender verification.

## Implementation sequence and PR boundaries

1. **Audit and shared email intelligence.** Land this inventory, connect email questions to the shared read-only receptionist/knowledge tools, correct clarification/availability semantics and remove industry hardcoding. Preserve deterministic booking authorization and voice behavior.
2. **Capability policy and first dashboard slices.** Introduce tenant-aware capability evaluation and restore Business/Services/Hours/Knowledge/Contacts with exact route/method tests.
3. **Canonical CRM/conversation bridge.** Define and implement compatible contact/conversation/message writes and migration observability without deleting LMC records.
4. **Email connection domain.** Add encrypted tenant-scoped connection/sender/health models, provider-neutral contracts and managed-Resend support.
5. **Mailbox providers.** Add Gmail and Microsoft authorization, webhook/subscription lifecycles, recovery and diagnostics in separate reviewable PRs.
6. **Remaining dashboard and platform slices.** Restore appointments, messages, analytics, integrations, teams, notifications, API/webhooks/MCP and billing only after each backend is production-verified.
7. **Consolidation migrations.** Remove duplicated reads/writes only after backfill, parity, tenant-isolation, rollback and production observation gates pass.

## Production prerequisites and blockers

- Gmail and Microsoft application registrations, verified redirect URLs, webhook/Pub/Sub endpoints and provider review are external prerequisites; repository code and fake/contract tests can be completed first.
- Managed sender/domain activation requires DNS records controlled by the client and provider verification. Code must report pending/failed state rather than claim readiness.
- Knowledge production readiness requires configured object storage, embedding and optional crawl providers.
- Voice/SMS requires Twilio/OpenAI provider configuration and jurisdiction-appropriate recording/consent policy.
- Widget and AI SMS remain explicitly restricted product capabilities until separately approved.
- Billing exposure requires mapping LMC plans and entitlements to the canonical billing catalog.

## Non-negotiable verification

Every consolidation or restored dashboard slice must retain:

- original voice regression suites and latency budget;
- exact route/method default-deny behavior;
- PostgreSQL `FORCE RLS` and A/B tenant probes;
- provider signature/state/PKCE verification as applicable;
- explicit customer confirmation and requester verification before booking or appointment changes;
- canonical availability recheck inside the booking transaction;
- idempotent inbound and outbound processing;
- opt-out/consent enforcement;
- secret and message-content redaction from logs/telemetry;
- production build, typecheck, unit, integration, LMC acceptance and security/static gates.

## Reuse report for the first consolidation slice

The first implementation slice extends, rather than replaces:

- `createReceptionistAgent` and `ToolLoopAgent` for asynchronous email reasoning;
- the existing business snapshot loader and knowledge search tool;
- canonical LMC availability and booking transactions;
- existing email authentication, queue, threading, suppression and human-handoff boundaries.

Email receives a read-only tool policy for business hours, services and knowledge. Side-effecting booking/change/message/transfer tools remain withheld; the verified domain workflow still owns them. Voice retains its four-step budget while email may use a larger asynchronous reasoning budget. This is an incremental bridge toward one agent architecture, not a new agent or a claim that the CRM/email persistence consolidation is complete.

## Current implementation status

The email bridge currently provides:

- shared `createReceptionistAgent` reasoning with email-specific untrusted-content instructions;
- tenant snapshot and conversation-history reuse;
- read-only business-hours, services, and knowledge tools;
- structured intent/qualification actions followed by backend validation;
- clarification instead of terminal low-confidence handoff for routine ambiguity;
- one qualification question per response;
- bounded model-provider retries through the durable LMC job queue;
- privacy-conscious decision and failure metadata in LMC events;
- existing inbound authentication, suppression, threading, handoff, and outbound idempotency boundaries.

The following are intentionally not yet exposed to the email agent:

- direct booking, cancellation, and rescheduling tools;
- phone-based appointment-change authorization;
- voice transfer/hangup controls;
- arbitrary customer-provided tool arguments;
- cross-channel conversation-table unification.

These capabilities require an email-specific identity and confirmation contract before exposure. Keeping them behind the existing domain workflow is safer than granting the model direct side effects.

## Operational requirements

- Configure `LMC_EMAIL_WORKER_ENABLED` only for environments with the LMC database, provider credentials, webhook signing secret, receiving domain, and public HTTPS base URL available.
- Run the worker with the worker database role and retain the dispatcher role separation for due-job discovery.
- Set `LMC_TEST_DATABASE_URL` and start PostgreSQL for the full LMC acceptance and RLS suites.
- Treat `email_processing_failed` events and `MODEL_UNAVAILABLE` job errors as operational signals; inspect provider/model health before manually replaying jobs.
- Do not replay an outbound message after an uncertain provider response without checking provider reconciliation and the persisted idempotency key.

## Rollout and rollback

Roll out the email bridge behind the existing LMC enablement flag, first with fake providers in a non-production environment, then with one tenant and provider-backed acceptance tests. Monitor clarification rate, human-handoff rate, model failure retries, outbound reconciliation events, suppression events, and duplicate-message alarms.

Rollback is configuration-first: disable LMC email processing, leave persisted jobs and messages intact, and route affected leads to the existing human workflow. Code rollback is a revert of the email bridge commits only; do not remove LMC tables, events, or queued-message history during rollback. Re-enable processing only after the failed job and provider states have been reconciled.

## Remaining risks

- Provider delivery still occurs in the send transaction; separating validation/state transition from the external call is a follow-up reliability change.
- Resend idempotency protects the primary LMC provider path, while SMTP uncertainty requires explicit reconciliation before retry.
- LMC email persistence remains separate from the original `conversations/messages` model.
- Full PostgreSQL acceptance, cross-tenant negative tests, and provider smoke tests require the configured test infrastructure and are not replaced by unit tests.

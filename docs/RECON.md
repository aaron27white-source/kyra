# LMC reconnaissance

## Verified Linux baseline — 2026-10-20

Ubuntu 26.04.1 WSL2, Node 22.22.1, pnpm 10.30.3, PostgreSQL 18/pgvector 0.8.1 and Redis 8. Frozen installation, full tests, lint (17 existing warnings), typecheck, production build and build-config tests passed. The build verified 16 localized public routes. All 155 script tests passed unchanged, resolving the historical Windows POSIX blocker below.

Migrations and role bootstrap passed twice, followed by schema and RLS checks. Live catalog: all 81 application tables have ENABLE/FORCE RLS and policies; the migration journal is the 82nd public table. All seven lobbystack roles have rolsuper=false and rolbypassrls=false. Reliability/MCP/OAuth/auth/voice integration runs passed 84 tests; additional assistant/tenancy tests passed 12 and Redis rate-limit tests passed 5. This does not replace Phase 5 exhaustive table/API isolation probes.

Fresh audit: 76 vulnerabilities (3 critical, 33 high, 30 moderate, 10 low), exit 1. Detailed findings supersede the earlier 72-count audit. Remediation remains Phase 6 work. Test secrets are outside the repository. Linux logs: /opt/lmc/logs. Current checkout: /opt/lmc/kyra, lmc/v1.

The sections below retain historical reconnaissance and Windows attempts. Any statements that WSL, database verification or a green test/build baseline are pending are superseded by this section. Product phases 1–6 remain incomplete.

## Scope and baseline

Source: aaron27white-source/kyra at edeb61ae8ff0602f31d106c77fe54d913b066c47. Working branch: lmc/v1. A local clone exists; a hosted GitHub fork has not been created. No product code has been changed.

Frozen-lockfile installation passed with pinned pnpm 10.30.3. Initial tests failed on an unresolved unbuilt workspace package. Lint passed with 17 warnings. Typecheck and build are running. Dependency audit reported 72 vulnerabilities; no passing overall baseline is claimed. Docker is not on PATH, so database-backed verification needs a local PostgreSQL provision or another available runtime.

## License findings

Kyra LICENSE declares MIT, copyright 2026 LobbyStack contributors. NOTICE retains Key 20 Consultations copyright and describes the upstream MIT portions. THIRD_PARTY_NOTICES.md preserves shadcn-admin MIT attribution; mintlify/LICENSE declares MIT (2023 Mintlify).

The original upstream GitHub URL returned 404. The official site links to https://gitlab.com/lobbystack-group/lobbystack as its temporary mirror. That mirror was cloned at 55379a5f6ddb73d0d4a954b66622ad7e52371879. Its LICENSE declares MIT; its tracked tree contains no NOTICE. Its THIRD_PARTY_NOTICES.md preserves shadcn-admin MIT attribution. Historical AGPL references in articles discuss the previous license and subsequent MIT change or other products. No current AGPL declaration was found in the inspected license files. Dependency license inspection remains pending. These are source findings, not legal conclusions.

## Architecture

- apps/admin: Next.js dashboard, authentication, HTTP APIs, widget and browser call entry points.
- apps/worker: asynchronous jobs, transactional outbox, live-call sideband controller.
- apps/landing: Astro marketing site; mintlify: documentation.
- packages/db: Drizzle schema, PostgreSQL migrations, role-specific clients and RLS.
- packages/domain: shared durable business logic, scheduling and conversations.
- packages/agent-core: ToolLoopAgent, tools, instructions, model factory, call summaries and live-call controller.
- packages/providers: Twilio, Google Calendar, SMTP, email webhook verification, embeddings, storage, billing and crawling.
- Redis/BullMQ provide asynchronous infrastructure; PostgreSQL is canonical storage.

## Voice coupling

packages/agent-core/src/agent.ts creates a shared ToolLoopAgent with channel-aware instructions and tools, but imposes a four-step limit explicitly justified by voice latency. packages/agent-core/src/live/session.ts imports OpenAI live session types and configures gpt-live-1, audio, delegation and stored calls. live/callController.ts handles the call lifecycle; callSummary.ts supports post-call summaries. apps/worker attaches to live sessions; admin handles incoming-call entry points. Preserve these paths and their tests when introducing email mode; do not alter their latency or audio configuration to accommodate asynchronous email.

## Tenant isolation observations

The existing tenant key is business_id, with businesses.id representing the tenant itself. This differs from the requested tenant_id naming. Migration 0002_rls.sql enables and forces RLS using dynamic loops, plus special auth/user/affiliate policies. It also gives system/dispatcher broader access on certain infrastructure tables. Later migrations must be evaluated in order. Static SQL declarations are not proof of an installed database policy or effective cross-tenant isolation. A full catalog probe remains required.

## Outstanding

Finish typecheck/build and rerun tests after workspace compilation; verify database policies in a real PostgreSQL catalog. Static table and environment inventories and dependency audit are recorded below. No Phase 1–6 acceptance claim is made.

## Schema table inventory (live catalog verified)

| Table | Tenant/ownership column in declaration | RLS evidence |
| --- | --- | --- |
| users | no direct business_id in declaration | 0002_rls.sql (named RLS loop); live catalog: ENABLE/FORCE and policy verified |
| accounts | user_id; no direct business_id | 0002_rls.sql (named RLS loop); live catalog: ENABLE/FORCE and policy verified |
| sessions | user_id; no direct business_id | 0002_rls.sql (named RLS loop); live catalog: ENABLE/FORCE and policy verified |
| verifications | no direct business_id in declaration | 0002_rls.sql (named RLS loop); live catalog: ENABLE/FORCE and policy verified |
| businesses | id (tenant root) | 0002_rls.sql (named RLS loop); live catalog: ENABLE/FORCE and policy verified |
| business_memberships | business_id NOT NULL | 0002_rls.sql (named RLS loop); live catalog: ENABLE/FORCE and policy verified |
| business_invitations | business_id NOT NULL | 0002_rls.sql (named RLS loop); live catalog: ENABLE/FORCE and policy verified |
| prospect_demos | business_id NOT NULL | 0017_prospect_demo_isolation.sql (explicit FORCE/ENABLE); live catalog: ENABLE/FORCE and policy verified |
| staff | business_id NOT NULL | 0002_rls.sql (named RLS loop); live catalog: ENABLE/FORCE and policy verified |
| services | business_id NOT NULL | 0002_rls.sql (named RLS loop); live catalog: ENABLE/FORCE and policy verified |
| staff_service_assignments | business_id NOT NULL | 0002_rls.sql (named RLS loop); live catalog: ENABLE/FORCE and policy verified |
| business_hours | business_id NOT NULL | 0002_rls.sql (named RLS loop); live catalog: ENABLE/FORCE and policy verified |
| closures | business_id NOT NULL | 0002_rls.sql (named RLS loop); live catalog: ENABLE/FORCE and policy verified |
| phone_numbers | business_id NOT NULL | 0002_rls.sql (named RLS loop); live catalog: ENABLE/FORCE and policy verified |
| onboarding_phone_verifications | business_id NOT NULL | 0024_phone_onboarding.sql (explicit array RLS loop); live catalog: ENABLE/FORCE and policy verified |
| onboarding_number_claim_events | business_id NOT NULL | 0024_phone_onboarding.sql (explicit array RLS loop); live catalog: ENABLE/FORCE and policy verified |
| receptionist_profiles | business_id NOT NULL | 0002_rls.sql (named RLS loop); live catalog: ENABLE/FORCE and policy verified |
| contacts | business_id NOT NULL | 0002_rls.sql (named RLS loop); live catalog: ENABLE/FORCE and policy verified |
| widget_keys | business_id NOT NULL | 0038_website_chat_widget.sql (explicit FORCE/ENABLE); live catalog: ENABLE/FORCE and policy verified |
| widget_visitors | business_id NOT NULL | 0038_website_chat_widget.sql (explicit FORCE/ENABLE); live catalog: ENABLE/FORCE and policy verified |
| sms_consent_events | business_id NOT NULL | 0029_sms_consent.sql (explicit FORCE/ENABLE); live catalog: ENABLE/FORCE and policy verified |
| conversations | business_id NOT NULL | 0002_rls.sql (named RLS loop); live catalog: ENABLE/FORCE and policy verified |
| conversation_sessions | business_id NOT NULL | 0002_rls.sql (named RLS loop); live catalog: ENABLE/FORCE and policy verified |
| messages | business_id NOT NULL | 0002_rls.sql (named RLS loop); live catalog: ENABLE/FORCE and policy verified |
| calls | business_id NOT NULL | 0002_rls.sql (named RLS loop); live catalog: ENABLE/FORCE and policy verified |
| inbox_items | business_id NOT NULL | 0041_ui_functional_parity.sql (explicit FORCE/ENABLE); live catalog: ENABLE/FORCE and policy verified |
| transcripts | business_id NOT NULL | 0002_rls.sql (named RLS loop); live catalog: ENABLE/FORCE and policy verified |
| appointments | business_id NOT NULL | 0002_rls.sql (named RLS loop); live catalog: ENABLE/FORCE and policy verified |
| appointment_change_verifications | business_id NOT NULL | 0002_rls.sql (named RLS loop); live catalog: ENABLE/FORCE and policy verified |
| knowledge_documents | business_id NOT NULL | 0002_rls.sql (named RLS loop); live catalog: ENABLE/FORCE and policy verified |
| knowledge_chunks | business_id NOT NULL | 0002_rls.sql (named RLS loop); live catalog: ENABLE/FORCE and policy verified |
| knowledge_snippets | business_id NOT NULL | 0002_rls.sql (named RLS loop); live catalog: ENABLE/FORCE and policy verified |
| agent_rules | business_id NOT NULL | 0002_rls.sql (named RLS loop); live catalog: ENABLE/FORCE and policy verified |
| website_ingestion_jobs | business_id NOT NULL | 0002_rls.sql (named RLS loop); live catalog: ENABLE/FORCE and policy verified |
| business_context_snapshots | business_id NOT NULL | 0002_rls.sql (named RLS loop); live catalog: ENABLE/FORCE and policy verified |
| storage_objects | business_id NOT NULL | 0002_rls.sql (named RLS loop); live catalog: ENABLE/FORCE and policy verified |
| calendar_connections | business_id NOT NULL | 0002_rls.sql (named RLS loop); live catalog: ENABLE/FORCE and policy verified |
| calendar_busy_blocks | business_id NOT NULL | 0002_rls.sql (named RLS loop); live catalog: ENABLE/FORCE and policy verified |
| notifications | business_id NOT NULL | 0002_rls.sql (named RLS loop); live catalog: ENABLE/FORCE and policy verified |
| operator_notification_preferences | business_id NOT NULL | 0022_operator_notification_preferences.sql (explicit FORCE/ENABLE); live catalog: ENABLE/FORCE and policy verified |
| operator_notification_deliveries | business_id NOT NULL | 0023_operator_notification_deliveries.sql (explicit FORCE/ENABLE); live catalog: ENABLE/FORCE and policy verified |
| billing_accounts | business_id NOT NULL | 0002_rls.sql (named RLS loop); live catalog: ENABLE/FORCE and policy verified |
| billing_checkout_requests | business_id NOT NULL | 0013_billing_checkout.sql (explicit FORCE/ENABLE); live catalog: ENABLE/FORCE and policy verified |
| billing_transactions | business_id NOT NULL | 0011_billing_affiliate_ledger.sql (explicit FORCE/ENABLE); live catalog: ENABLE/FORCE and policy verified |
| billing_usage_events | business_id NOT NULL | 0002_rls.sql (named RLS loop); live catalog: ENABLE/FORCE and policy verified |
| billing_usage_months | business_id NOT NULL | 0030_billing_usage_caps.sql (explicit FORCE/ENABLE); live catalog: ENABLE/FORCE and policy verified |
| compliance_records | business_id NOT NULL | 0002_rls.sql (named RLS loop); live catalog: ENABLE/FORCE and policy verified |
| feedback_submissions | business_id nullable | 0031_feedback_submissions.sql (explicit FORCE/ENABLE); live catalog: ENABLE/FORCE and policy verified |
| affiliate_profiles | user_id; no direct business_id | 0002_rls.sql (explicit FORCE/ENABLE); live catalog: ENABLE/FORCE and policy verified |
| affiliate_attributions | business_id NOT NULL | 0002_rls.sql (named RLS loop); live catalog: ENABLE/FORCE and policy verified |
| affiliate_profile_stats | no direct business_id in declaration | 0011_billing_affiliate_ledger.sql (explicit FORCE/ENABLE); live catalog: ENABLE/FORCE and policy verified |
| affiliate_clicks | no direct business_id in declaration | 0011_billing_affiliate_ledger.sql (explicit FORCE/ENABLE); live catalog: ENABLE/FORCE and policy verified |
| affiliate_voided_sources | business_id NOT NULL | 0011_billing_affiliate_ledger.sql (explicit FORCE/ENABLE); live catalog: ENABLE/FORCE and policy verified |
| affiliate_payout_runs | no direct business_id in declaration | 0011_billing_affiliate_ledger.sql (explicit FORCE/ENABLE); live catalog: ENABLE/FORCE and policy verified |
| affiliate_payout_items | no direct business_id in declaration | 0011_billing_affiliate_ledger.sql (explicit FORCE/ENABLE); live catalog: ENABLE/FORCE and policy verified |
| affiliate_commissions | no direct business_id in declaration | 0011_billing_affiliate_ledger.sql (explicit FORCE/ENABLE); live catalog: ENABLE/FORCE and policy verified |
| audit_logs | business_id NOT NULL | 0002_rls.sql (named RLS loop); live catalog: ENABLE/FORCE and policy verified |
| idempotency_keys | business_id nullable | 0002_rls.sql (named RLS loop); live catalog: ENABLE/FORCE and policy verified |
| provider_events | business_id nullable | 0002_rls.sql (named RLS loop); live catalog: ENABLE/FORCE and policy verified |
| outbox_messages | business_id nullable | 0002_rls.sql (named RLS loop); live catalog: ENABLE/FORCE and policy verified |
| product_events | business_id nullable | 0002_rls.sql (named RLS loop); live catalog: ENABLE/FORCE and policy verified |
| unit_economics_events | business_id NOT NULL | 0032_unit_economics.sql (explicit array RLS loop); live catalog: ENABLE/FORCE and policy verified |
| unit_economics_rollups | business_id NOT NULL | 0032_unit_economics.sql (explicit array RLS loop); live catalog: ENABLE/FORCE and policy verified |
| api_keys | business_id NOT NULL | 0066_public_api.sql (explicit array RLS loop); live catalog: ENABLE/FORCE and policy verified |
| webhook_endpoints | business_id NOT NULL | 0066_public_api.sql (explicit array RLS loop); live catalog: ENABLE/FORCE and policy verified |
| webhook_events | business_id NOT NULL | 0066_public_api.sql (explicit array RLS loop); live catalog: ENABLE/FORCE and policy verified |
| webhook_deliveries | business_id NOT NULL | 0066_public_api.sql (explicit array RLS loop); live catalog: ENABLE/FORCE and policy verified |
| webhook_delivery_attempts | business_id NOT NULL | 0066_public_api.sql (explicit array RLS loop); live catalog: ENABLE/FORCE and policy verified |
| oauth_clients | reference_id; inspect OAuth grant semantics | 0069_mcp_oauth.sql (explicit array RLS loop); live catalog: ENABLE/FORCE and policy verified |
| oauth_resources | no direct business_id in declaration | 0069_mcp_oauth.sql (explicit array RLS loop); live catalog: ENABLE/FORCE and policy verified |
| oauth_client_resources | no direct business_id in declaration | 0069_mcp_oauth.sql (explicit array RLS loop); live catalog: ENABLE/FORCE and policy verified |
| oauth_refresh_tokens | reference_id; inspect OAuth grant semantics | 0069_mcp_oauth.sql (explicit array RLS loop); live catalog: ENABLE/FORCE and policy verified |
| oauth_access_tokens | reference_id; inspect OAuth grant semantics | 0069_mcp_oauth.sql (explicit array RLS loop); live catalog: ENABLE/FORCE and policy verified |
| oauth_consents | reference_id; inspect OAuth grant semantics | 0069_mcp_oauth.sql (explicit array RLS loop); live catalog: ENABLE/FORCE and policy verified |
| oauth_client_assertions | no direct business_id in declaration | 0069_mcp_oauth.sql (explicit array RLS loop); live catalog: ENABLE/FORCE and policy verified |
| assistant_settings | business_id NOT NULL | 0070_key20_assistant.sql (explicit array RLS loop); live catalog: ENABLE/FORCE and policy verified |
| missed_calls | business_id NOT NULL | 0070_key20_assistant.sql (explicit array RLS loop); live catalog: ENABLE/FORCE and policy verified |
| outreach_automations | business_id NOT NULL | 0070_key20_assistant.sql (explicit array RLS loop); live catalog: ENABLE/FORCE and policy verified |
| outreach_sends | business_id NOT NULL | 0070_key20_assistant.sql (explicit array RLS loop); live catalog: ENABLE/FORCE and policy verified |
| quotes | business_id NOT NULL | 0070_key20_assistant.sql (explicit array RLS loop); live catalog: ENABLE/FORCE and policy verified |
| invoices | business_id NOT NULL | 0070_key20_assistant.sql (explicit array RLS loop); live catalog: ENABLE/FORCE and policy verified |

Inventory includes 
81
 Drizzle declarations, including historical/deprecated declarations. RLS evidence names the migration with an explicit FORCE declaration or a loop containing that table; effective policy behavior remains unverified. Reconcile dropped tables and dynamically generated policies with an installed catalog before claiming completeness.

## Environment variable names in .env.example

Values are deliberately omitted. These are example-file declarations; runtime-only variables require additional inventory.

- `POSTGRES_PASSWORD`
- `POSTGRES_PORT`
- `REDIS_PORT`
- `LOBBYSTACK_APP_PASSWORD`
- `LOBBYSTACK_AUTH_PASSWORD`
- `LOBBYSTACK_WORKER_PASSWORD`
- `LOBBYSTACK_DISPATCHER_PASSWORD`
- `LOBBYSTACK_MIGRATOR_PASSWORD`
- `LOBBYSTACK_READONLY_PASSWORD`
- `LOBBYSTACK_FINANCE_EXPORT_DATABASE_URL`
- `FINANCE_EXPORT_ENABLED`
- `FINANCE_EXPORT_TOKEN`
- `ADMIN_PORT`
- `WORKER_PORT`
- `LOBBYSTACK_MAINTENANCE_MODE`
- `LOBBYSTACK_CERTIFICATION_MODE`
- `LOBBYSTACK_CERTIFICATION_EMAILS`
- `LOBBYSTACK_CERTIFICATION_PHONES`
- `LOBBYSTACK_CERTIFICATION_CALENDARS`
- `BETTER_AUTH_SECRET`
- `REQUIRE_EMAIL_VERIFICATION`
- `INTERNAL_SERVICE_SECRET`
- `INTERNAL_SERVICE_TOKEN`
- `ENCRYPTION_KEY`
- `OTP_HASH_SECRET`
- `TURNSTILE_SECRET_KEY`
- `NEXT_PUBLIC_TURNSTILE_SITE_KEY`
- `DEPLOYMENT_MODE`
- `APP_BASE_URL`
- `WEB_CALL_ALLOWED_ORIGINS`
- `WEB_CALL_PUBLIC_BUSINESS_SLUG`
- `TRUSTED_CLIENT_IP_HEADER`
- `APP_HOSTNAME`
- `PROSPECT_DEMO_OPERATOR_EMAIL`
- `STORAGE_PROVIDER`
- `LOCAL_STORAGE_PATH`
- `LOCAL_STORAGE_SIGNING_SECRET`
- `S3_ENDPOINT`
- `S3_BUCKET`
- `S3_REGION`
- `S3_ACCESS_KEY_ID`
- `S3_SECRET_ACCESS_KEY`
- `S3_FORCE_PATH_STYLE`
- `OPENAI_API_KEY`
- `AI_CHAT_API_KEY`
- `AI_CHAT_BASE_URL`
- `AI_CHAT_MODEL`
- `AI_CHAT_REASONING_EFFORT`
- `AI_CHAT_PROVIDER_NAME`
- `AI_SUMMARY_MODEL`
- `AI_SUMMARY_REASONING_EFFORT`
- `LIVE_PROTOTYPE_ENABLED`
- `OPENAI_WEBHOOK_SECRET`
- `WORKER_INTERNAL_URL`
- `TWILIO_SIP_TRUNK_SID`
- `AI_CHAT_INPUT_COST_PER_MILLION_TOKENS`
- `AI_CHAT_OUTPUT_COST_PER_MILLION_TOKENS`
- `AI_CHAT_PRICING_VERSION`
- `AI_CHAT_PRICING_SOURCE`
- `AI_CHAT_PRICING_EFFECTIVE_DATE`
- `AI_CHAT_TIMEOUT_MS`
- `AI_CHAT_CHUNK_TIMEOUT_MS`
- `AI_EMBEDDING_API_KEY`
- `AI_EMBEDDING_BASE_URL`
- `AI_EMBEDDING_MODEL`
- `AI_EMBEDDING_PROVIDER_NAME`
- `AI_EMBEDDING_REVISION`
- `AI_EMBEDDING_INPUT_COST_PER_MILLION_TOKENS`
- `AI_EMBEDDING_PRICING_VERSION`
- `AI_EMBEDDING_PRICING_SOURCE`
- `AI_EMBEDDING_PRICING_EFFECTIVE_DATE`
- `AI_EMBEDDING_TIMEOUT_MS`
- `AI_EMBEDDING_MAX_PARALLEL_CALLS`
- `WIDGET_SESSION_SECRET`
- `WIDGET_KEY_ISSUANCE_ENABLED`
- `PUBLIC_API_RATE_LIMIT_PER_MINUTE`
- `CONTENT_RETENTION_ENABLED`
- `CONTENT_RETENTION_POLICY_JSON`
- `CONTENT_RETENTION_DATABASE_URL`
- `VOICE_RECOVERY_DATABASE_URL`
- `FIRECRAWL_API_KEY`
- `FIRECRAWL_BASE_URL`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`
- `POLAR_ACCESS_TOKEN`
- `POLAR_WEBHOOK_SECRET`
- `POLAR_ACCEPT_LEGACY_BUSINESS_IDS`
- `RESEND_WEBHOOK_SECRET`
- `POLAR_ORGANIZATION_ID`
- `POLAR_API_BASE_URL`
- `POLAR_STARTER_MONTHLY_PRODUCT_ID`
- `POLAR_STARTER_ANNUAL_PRODUCT_ID`
- `POLAR_PRO_MONTHLY_PRODUCT_ID`
- `POLAR_PRO_ANNUAL_PRODUCT_ID`
- `POSTHOG_API_KEY`
- `POSTHOG_HOST`
- `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN`
- `NEXT_PUBLIC_POSTHOG_HOST`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_ALERT_SMS_FROM`
- `TWILIO_ALERT_ACCOUNT_SID`
- `TWILIO_ALERT_API_KEY_SID`
- `TWILIO_ALERT_API_KEY_SECRET`
- `TWILIO_ALERT_WEBHOOK_KEY_ID`
- `TWILIO_ALERT_WEBHOOK_SECRET`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_VERIFY_SERVICE_SID`
- `NUMBER_CLAIM_TOKEN_SECRET`
- `TWILIO_SMS_WEBHOOK_URL`
- `TWILIO_STATUS_CALLBACK_URL`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_SECURE`
- `SMTP_USERNAME`
- `SMTP_PASSWORD`
- `EMAIL_FROM`
- `EMAIL_REPLY_TO`
- `FEEDBACK_TO_EMAIL`
- `ONBOARDING_FOLLOWUP_FROM`
- `ONBOARDING_FOLLOWUP_SENDER_NAME`
- `UNIT_ECONOMICS_MONTHLY_DATABASE_COST_USD`
- `UNIT_ECONOMICS_MONTHLY_HOSTING_COST_USD`
- `UNIT_ECONOMICS_MONTHLY_STORAGE_COST_USD`
- `OTEL_EXPORTER_OTLP_ENDPOINT`
- `OTEL_EXPORTER_OTLP_HEADERS`
- `SERVICE_VERSION`

## Dependency audit baseline

pnpm audit --json exited 1. Full output retained in work/audit-baseline.json outside the repository. Findings below are from the package manager registry response; no dependency upgrades have been made.

| Package | Severity | Patched range | Advisory |
| --- | --- | --- | --- |
| nodemailer | moderate | >=10.0.2 | https://github.com/advisories/GHSA-6vj9-mwq6-2f5v |
| undici | moderate | >=7.29.1 | https://github.com/advisories/GHSA-3wwx-pv8p-q78v |
| fast-uri | high | >=3.1.7 | https://github.com/advisories/GHSA-qw65-cvwx-89v3 |
| fast-uri | high |  | https://github.com/advisories/GHSA-58mr-gqgx-xq4g |
| ip-address | moderate | >=10.5.1 | https://github.com/advisories/GHSA-rpw4-54j3-4h4q |
| ip-address | moderate | >=10.5.1 | https://github.com/advisories/GHSA-2vr4-cq9g-pvrc |
| nodemailer | moderate | >=10.0.2 | https://github.com/advisories/GHSA-8vvx-rff5-p5rq |
| undici | moderate | >=7.29.1 | https://github.com/advisories/GHSA-pmjh-fq2x-6v4x |
| undici | low | >=7.29.1 | https://github.com/advisories/GHSA-r53p-7pc4-xj5r |
| undici | high | >=7.29.1 | https://github.com/advisories/GHSA-rfgv-xxqx-mfg5 |
| undici | moderate | >=7.29.1 | https://github.com/advisories/GHSA-3xpg-4rpp-hhhm |
| undici | moderate | >=7.29.1 | https://github.com/advisories/GHSA-2jfj-6hjv-fm6j |
| undici | low | >=7.29.1 | https://github.com/advisories/GHSA-2gqq-gqf2-x968 |
| undici | high | >=7.29.1 | https://github.com/advisories/GHSA-w293-vg96-wgc3 |
| undici | low | >=7.29.1 | https://github.com/advisories/GHSA-8436-99hf-9mmv |
| undici | moderate | >=7.29.1 | https://github.com/advisories/GHSA-rx4f-c7p8-82vq |
| fast-uri | moderate | >=3.1.8 | https://github.com/advisories/GHSA-hrr3-gc8f-f4qj |
| ip-address | moderate | >=10.7.1 | https://github.com/advisories/GHSA-j6r3-76f7-8jcv |
| ip-address | moderate | >=10.7.1 | https://github.com/advisories/GHSA-h3mg-xc3c-68pw |
| brace-expansion | moderate | >=1.1.21 | https://github.com/advisories/GHSA-q2hr-2g5m-vwhr |
| brace-expansion | moderate | >=5.0.12 | https://github.com/advisories/GHSA-q2hr-2g5m-vwhr |
| brace-expansion | high | >=1.1.20 | https://github.com/advisories/GHSA-qhr7-859c-m2p7 |
| brace-expansion | high | >=5.0.11 | https://github.com/advisories/GHSA-qhr7-859c-m2p7 |
| brace-expansion | high | >=1.1.19 | https://github.com/advisories/GHSA-6j4f-fj2g-mc7p |
| brace-expansion | high | >=5.0.10 | https://github.com/advisories/GHSA-6j4f-fj2g-mc7p |
| engine.io | high | >=6.6.10 | https://github.com/advisories/GHSA-2gc4-cqfq-p2gv |
| nodemailer | moderate | >=10.0.9 | https://github.com/advisories/GHSA-g57g-f23g-4646 |
| nodemailer | high | >=10.0.6 | https://github.com/advisories/GHSA-v53p-9fqp-m79j |
| axios | moderate | >=1.20.0 | https://github.com/advisories/GHSA-vh66-26gq-q6x8 |
| axios | moderate | >=1.20.0 | https://github.com/advisories/GHSA-9fr6-4gfg-395g |
| axios | high | >=1.20.0 | https://github.com/advisories/GHSA-c29m-xwm3-cm6r |
| axios | high | >=1.20.0 | https://github.com/advisories/GHSA-mghh-pgcx-3jjj |
| axios | high | >=1.20.0 | https://github.com/advisories/GHSA-x97p-jq2g-jp4f |
| axios | high | >=1.20.0 | https://github.com/advisories/GHSA-3pq3-5fj3-cg6v |
| axios | high | >=1.20.0 | https://github.com/advisories/GHSA-542g-h47m-68v8 |
| next | critical | >=16.3.6 | https://github.com/advisories/GHSA-vcvr-r3jv-pc5j |
| dompurify | low | >=3.4.16 | https://github.com/advisories/GHSA-p98j-92pf-mc4p |
| @grpc/grpc-js | high | >=1.14.5 | https://github.com/advisories/GHSA-m9gg-hp2v-232j |
| @grpc/grpc-js | low | >=1.14.5 | https://github.com/advisories/GHSA-f596-whhp-79r4 |
| axios | moderate | >=1.20.0 | https://github.com/advisories/GHSA-j8rh-479h-cp32 |
| axios | moderate | >=1.20.0 | https://github.com/advisories/GHSA-4hqw-qxg8-jxx2 |
| axios | high | >=1.20.0 | https://github.com/advisories/GHSA-m8m8-qj5v-23w3 |
| axios | moderate | >=1.20.0 | https://github.com/advisories/GHSA-44g4-m2mj-wpvx |
| axios | high | >=1.20.0 | https://github.com/advisories/GHSA-r4gj-5m52-g5wh |
| devalue | high | >=5.9.3 | https://github.com/advisories/GHSA-j22f-vq7h-c4qm |
| devalue | moderate | >=5.9.3 | https://github.com/advisories/GHSA-hx4r-w6wj-j8fg |
| devalue | high | >=5.9.3 | https://github.com/advisories/GHSA-mcm9-63f2-9j32 |
| devalue | low | >=5.9.3 | https://github.com/advisories/GHSA-wf3x-273g-mvxv |
| devalue | high | >=5.9.3 | https://github.com/advisories/GHSA-x5rw-q4pp-hg5g |
| devalue | moderate | >=5.9.3 | https://github.com/advisories/GHSA-4q55-j62x-fr9h |
| http-cache-semantics | high | >=4.3.0 | https://github.com/advisories/GHSA-ch52-4w7c-c8xp |
| braces | high |  | https://github.com/advisories/GHSA-vfj7-8cjw-p6xm |
| sprintf-js | moderate |  | https://github.com/advisories/GHSA-hp3w-g68c-fv3c |
| dompurify | low | >=3.4.16 | https://github.com/advisories/GHSA-6688-9rhm-gjv2 |
| smol-toml | moderate | >=1.9.0 | https://github.com/advisories/GHSA-r4xh-jqrq-34v2 |
| katex | low | >=0.18.2 | https://github.com/advisories/GHSA-238p-pmpm-9mq7 |
| source-map-js | high | >=1.2.2 | https://github.com/advisories/GHSA-68fv-2mgg-jv7q |
| proxy-addr | critical | >=2.0.8 | https://github.com/advisories/GHSA-jqcg-44mw-7w3h |
| postcss-selector-parser | moderate | >=7.1.6 | https://github.com/advisories/GHSA-rj75-hqrm-r3gf |
| nodemailer | high | >=10.0.5 | https://github.com/advisories/GHSA-prgh-xp8r-p3m5 |
| sharp | high | >=0.35.5 | https://github.com/advisories/GHSA-wq5f-xc86-pv6w |
| shell-quote | critical | >=1.11.0 | https://github.com/advisories/GHSA-pqg4-j6r4-53mv |
| @modelcontextprotocol/client | high | >=2.2.0 | https://github.com/advisories/GHSA-6qxp-vccf-f47h |
| @modelcontextprotocol/sdk | high | >=1.31.0 | https://github.com/advisories/GHSA-6qxp-vccf-f47h |
| i18next-http-backend | low | >=4.0.2 | https://github.com/advisories/GHSA-xvq9-wjp8-hwqf |
| next | moderate | >=16.3.8 | https://github.com/advisories/GHSA-3w37-wq28-93x7 |
| next | moderate | >=16.3.8 | https://github.com/advisories/GHSA-4jqv-mc3x-m676 |
| next | low | >=16.3.8 | https://github.com/advisories/GHSA-39w2-rjm5-chcv |
| next | moderate | >=16.3.8 | https://github.com/advisories/GHSA-f87g-xv8r-7p7x |
| next | moderate | >=16.3.8 | https://github.com/advisories/GHSA-mcj8-r9mp-w47p |
| next | high | >=16.3.8 | https://github.com/advisories/GHSA-cjq9-62q9-8jv4 |
| devalue | high | >=5.9.3 | https://github.com/advisories/GHSA-r9w8-h9r3-54w4 |

## Runtime and audit details

Observed runtime: Node v26.5.0, pnpm 11.25.0. The repository pins pnpm 10.30.3, so this mismatch must be addressed or explicitly retained as a baseline limitation. Installation has finished package downloads and is processing install scripts; completion is not yet confirmed.

Audit metadata reports 72 vulnerabilities: 3 critical, 30 high, 29 moderate, 10 low. A passing supply-chain policy check during installation is distinct from a clean vulnerability audit.

Docker, psql, postgres and initdb were not found on PATH. wsl --list --quiet reports that WSL is not installed. No live database policy validation has run.

packages/db/src/rls/context.ts sets app.user_id, app.business_id and app.actor_type using transaction-local set_config. Migration 0069 forces RLS on seven OAuth tables but grants lobbystack_auth an unrestricted auth policy; tenant grant resolution is handled through dedicated functions. This requires explicit cross-tenant testing rather than treating FORCE RLS alone as sufficient.

Migration reconciliation: recursively including migrations/generated yields 81 unique CREATE TABLE names, matching the 81 Drizzle table declarations. This establishes inventory coverage of the checked-in declarations, not live catalog state.

Installation attempts: pnpm 11.25.0 downloaded the dependencies but exited 1 with ERR_PNPM_IGNORED_BUILDS for msgpackr-extract. Its automatically inserted workspace placeholder was removed. Switched to the pinned pnpm 10.30.3 via npx. The first pinned attempt aborted because no TTY was available to recreate node_modules; retried with CI=true. No dependency versions or existing tests were modified.

## Additional direct environment references

Static process.env.NAME references outside test files, beyond .env.example. Dynamic role-based names and object-based config parsing are not exhaustively represented by this lexical inventory.

- `ADMIN_BASE_URL`
- `ALLOW_QUERY_PLAN_CHECK`
- `AUTH_TRUSTED_ORIGINS`
- `BETTER_AUTH_USE_SECURE_COOKIES`
- `CI`
- `DASHBOARD_CHECK_BASE_URL`
- `DATABASE_URL`
- `DEMO_OPERATOR_E2E`
- `GIT_SHA`
- `GITHUB_SHA`
- `INDEXNOW_KEY`
- `INVITATION_PARITY_ARTIFACTS`
- `INVITATION_PARITY_BASE_URL`
- `INVITATION_PARITY_SIDE`
- `LIVE_PROTOTYPE_TEST_BUSINESS_ID`
- `LOADING_PARITY_ARTIFACTS`
- `LOADING_PARITY_BASE_URL`
- `LOADING_PARITY_SIDE`
- `LOBBYSTACK_APP_DATABASE_URL`
- `LOBBYSTACK_AUTH_DATABASE_URL`
- `LOBBYSTACK_DISPATCHER_DATABASE_URL`
- `LOBBYSTACK_FINANCE_EXPORT_PASSWORD`
- `LOBBYSTACK_MIGRATOR_DATABASE_URL`
- `LOBBYSTACK_SKIP_ENV_FILES`
- `LOBBYSTACK_WORKER_DATABASE_URL`
- `NEXT_PHASE`
- `NEXT_PUBLIC_AFFILIATE_PROGRAM_ENABLED`
- `NEXT_PUBLIC_ASSET_VERSION`
- `NEXT_PUBLIC_DEPLOYMENT_ENVIRONMENT`
- `NEXT_PUBLIC_DEPLOYMENT_MODE`
- `NEXT_PUBLIC_LANDING_SITE_URL`
- `NEXT_PUBLIC_SERVICE_VERSION`
- `NEXT_PUBLIC_SITE_URL`
- `NEXT_RUNTIME`
- `NODE_ENV`
- `OPERATOR_BASELINE_ARTIFACTS`
- `OPERATOR_BASELINE_BASE_URL`
- `OTEL_CERTIFICATION_ENDPOINT`
- `OTEL_SERVICE_NAME`
- `PARITY_ARTIFACT_DIR`
- `PARITY_BASE_URL`
- `PARITY_CALL_ID`
- `PARITY_CONTACT_ID`
- `PARITY_DEMO_TOKEN`
- `PARITY_GREP`
- `PARITY_INCLUDE_PORT_BASELINES`
- `PARITY_OPERATOR_USER_ID`
- `PARITY_OUTPUT_DIR`
- `PARITY_PARALLEL`
- `PARITY_PORT_OPERATOR_STORAGE_STATE_EN`
- `PARITY_PORT_OPERATOR_STORAGE_STATE_FR`
- `PARITY_REQUIRE_FULL`
- `PARITY_RESET_TOKEN`
- `PARITY_SETUP_GUIDE_EXPECTED`
- `PARITY_SIDE`
- `PARITY_SKIP_REFERENCE`
- `PARITY_SNAPSHOT_DIR`
- `PARITY_WORKERS`
- `PASSWORD_RECOVERY_CERTIFICATION`
- `PASSWORD_RECOVERY_E2E`
- `PERFORMANCE_BASELINE_MODULE`
- `PERFORMANCE_CONCURRENCY`
- `PERFORMANCE_DEPLOYMENT_ID`
- `PERFORMANCE_OUTPUT`
- `PLAYWRIGHT_BASE_URL`
- `POLAR_PRO_PRODUCT_ID`
- `PORT`
- `POSTHOG_KEY`
- `POSTHOG_PROJECT_ID`
- `POSTHOG_SOURCEMAP_API_KEY`
- `PRODUCTION_IMPORT_APPROVED`
- `PRODUCTION_IMPORT_DATABASE_URL`
- `PRODUCTION_IMPORT_TARGET_NONCE`
- `PRODUCTION_REBUILD_DATABASE_URL`
- `PRODUCTION_REBUILD_TARGET_NONCE`
- `PRODUCTION_REBUILD_WORKER_DATABASE_URL`
- `PROSPECT_DEMO_TOKEN`
- `RAILWAY_DEPLOYMENT_ID`
- `RAILWAY_ENVIRONMENT_NAME`
- `RECONCILIATION_DATABASE_URL`
- `RECOVERY_CHECK_WORKER`
- `RECOVERY_COMPOSE_FILE`
- `RECOVERY_COMPOSE_PROJECT`
- `RECOVERY_WORKER_BASE_URL`
- `RECOVERY_WORKER_REDIS_PREFIX`
- `REDIS_PREFIX`
- `REDIS_URL`
- `REHEARSAL_DATABASE_URL`
- `REHEARSAL_TARGET_NONCE`
- `REHEARSAL_WORKER_DATABASE_URL`
- `RELEASE_E2E_EN_EMAIL`
- `RELEASE_E2E_FR_EMAIL`
- `RELEASE_E2E_SERVER_VERSION`
- `RELEASE_E2E_WORKER_PAUSED`
- `RELEASE_FIXTURE_DIRECTORY`
- `REPLACEMENT_APP_DATABASE_URL`
- `REPLACEMENT_E2E_DATABASE_URL`
- `REPLACEMENT_MIGRATOR_DATABASE_URL`
- `REPLACEMENT_REDIS_HOST`
- `REPLACEMENT_S3_ENDPOINT`
- `REPLACEMENT_WORKER_DATABASE_URL`
- `SESSION_ENCRYPTION_KEY`
- `SITE_URL`
- `SMS_HELP_REPLY`
- `TELEMETRY_CERTIFICATION_MARKER`
- `TWILIO_CALLBACK_STATUS_URL`
- `TWILIO_VOICE_WEBHOOK_URL`
- `VERIFY_RLS_BEHAVIOR`
- `WEB_CALL_MAX_DURATION_MS`
- `WEBSITE_IMPORT_E2E`
- `WIDGET_E2E`
- `WORKER_BASE_URL`

## Baseline observations before main checks

The dependency-free image projection test (`node --test .github/build/*.test.mjs`) failed: prepare-image-workspace.mjs rejects the CRLF checkout of pnpm-lock.yaml because its version header check requires LF. Git reports core.autocrlf=true; .editorconfig requests LF. The test also invokes pnpm using execFileSync, which needs platform-specific verification on Windows. Log: work/baseline-build-config.log. Existing assertions have not been changed.

All 81 schema tables have static FORCE RLS evidence in explicit ALTER TABLE statements or named/explicit-array loops. No DISABLE ROW LEVEL SECURITY or NO FORCE ROW LEVEL SECURITY statements were found in migrations. This is not an effective-policy audit. The inventory now identifies the actual FORCE declaration source for each table, replacing the earlier candidate-file list.

AgentToolContext currently supports voice, web_voice, web_chat and sms, but not email. It carries callerPhone, callId and optional transfer/hangup controls. Existing Google Calendar and appointment-verification domain functions are exposed as agent tools. SMTP currently sends transactional templates; a Resend webhook signature verifier already exists. Neither legacy-lmc in the chat workspace nor in the Kyra checkout is present.

Pinned installation completed successfully (exit 0), using pnpm 10.30.3 in CI mode. msgpackr-extract remains an ignored optional build under the existing policy. The four principal baseline commands are now executing sequentially with separate logs.

## Isolation gaps to investigate in Phase 5

- Tenant-owned tables use business_id, not the required tenant_id. Some infrastructure/affiliate ownership is indirect or nullable; the table inventory flags these declarations.
- client.ts falls back to DATABASE_URL when an explicit role URL or role password is absent. Runtime connection-role enforcement must be verified; naming a DatabaseClient role is not proof of the actual PostgreSQL login role.
- 0000_roles.sql sets NOBYPASSRLS for app/worker/dispatcher/readonly roles, but the effective rolsuper and rolbypassrls values have not been queried.
- db:verify-rls already introspects ENABLE/FORCE and missing policies. Its optional behavioral check probes businesses/services and actor spoofing; that is not coverage of all 81 tables or all HTTP routes.
- Auth and OAuth policies allow the auth role broad access. Provider-event/outbox policies and dispatcher functions have special cross-business behavior. These need explicit classification and constrained access tests.

## Baseline command results and first repair

- pnpm test: exit 1, jobs suite cannot resolve the unbuilt contracts package; dependent suites did not complete.
- pnpm lint: exit 0, 17 ESLint warnings in admin.
- pnpm typecheck: exit 0, including scripts and Astro diagnostics.
- pnpm build: exit 1, embed entry uses URL.pathname and yields an invalid Windows drive path.
- Regression test added before the repair: packages/embed/src/build-config.test.ts failed because the configured path did not exist. Replacing pathname with fileURLToPath made the test and the actual widget build pass. Voice code was not modified. Full build retry is in progress; overall baseline remains unverified.

Build retry progressed through landing, domain and agent-core, then admin failed because Windows cmd cannot execute NODE_ENV=production as a command. A targeted admin build with npm_config_shell_emulator=true is now running and has entered Next.js production compilation. The main suite rerun after compiling shared packages has passed providers, jobs, domain, agent-core (76 tests) and worker (93 tests); admin and script results remain pending.

## Current baseline gate

Admin production build PASSED using pnpm shell emulator. The sole admin test failure was a Windows path comparison: normalize node:path.sep to slash before comparing the existing allowed file. Its original assertion is unchanged, and the targeted test now passes. The prior admin run reported 878 passed, 1 failed, 26 skipped; the targeted repair addresses that failure, not the skipped database suites.

Script suite reported 138 passed and 14 failed tests, plus a generate-env import error. Normalizing generate-env.mjs from CRLF to LF made all 3 generator tests pass without semantic source changes. The remaining failures assert POSIX owner-only modes (0600; Windows reports 0666) and symlink behavior (EPERM in this environment). Those security assertions have not been removed, skipped or relaxed. Full baseline is therefore NOT green on this host.

A Linux execution environment is needed to run the unchanged POSIX security tests. PostgreSQL with pgvector and Redis are also required for database-backed verification. Docker/PostgreSQL are not available on PATH; WSL reports not installed. Under the user's baseline gate, the explicit stop condition applies while these security tests cannot pass on the current host.

Final additional checks: worker build exit 0; admin:prerender-check exit 0 (16 routes); widget copy exit 0. All running verification processes have completed. Baseline remains blocked by the 14 POSIX/security test failures, not by a license issue.

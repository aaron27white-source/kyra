# Email worker runtime

`apps/worker/src/index.ts` now starts the dedicated PostgreSQL email consumer alongside the existing worker when enabled. It uses the worker and dispatcher database roles already checked at startup. It does not register email jobs in the voice queue or change the voice controller, agent tools or model defaults.

## Configuration

`LMC_EMAIL_WORKER_ENABLED` accepts only `true` or `false`. It defaults to enabled outside production and disabled in production, preserving existing voice-only deployments. The example environment explicitly enables it. Set it to `true` in an email deployment.

Admin and worker share `getLmcEnvironment` from the providers package. Local development defaults to fake email and model providers even when live provider keys are present. Production requires explicit `LMC_PROVIDER_MODE=real`, HTTPS `LMC_PUBLIC_BASE_URL`, a real sender and receiving domain, signing material, Resend credentials and the existing text-model configuration (`AI_CHAT_*`, with the existing `OPENAI_API_KEY` fallback). Missing or invalid adapter configuration fails initialization rather than falling back to fake production delivery. Production placeholder model credentials are rejected before constructing the model client.

```sh
# With local environment and role-specific database URLs configured:
pnpm dev:worker
```

The new consumer's fake email deliveries are recorded in the tenant's message/outbox data with `fake-email-` provider IDs. They do not send external email. The legacy worker's separate email/SMS/voice/model/calendar bindings have not yet all been switched to fake defaults; completing that audit remains necessary before the complete dev runtime can be described as offline by default. The email consumer itself does not create a calendar transport: booking uses canonical availability records and the existing calendar outbox.

## Consumer lifecycle

The consumer serializes drain iterations and waits 500 ms between them. A task is leased only when it is about to execute; waiting tasks do not accumulate expiring leases behind slow model calls. PostgreSQL row locks, tenant contexts and existing idempotency keys still govern claims and delivery. Database iteration failures mark email readiness false and retry without exposing SQL, credentials or lead content through the status callback. Normal per-job retries remain in the durable queue.

Maintenance startup returns before consumer/provider initialization. Shutdown aborts future claims, lets the current task finish and waits for the email loop before closing database pools. Model requests are bounded to 20 seconds with no SDK retries; email transport requests retain their 10-second bound and durable retry policy. HTTPS remains the default domain-worker requirement; its runtime explicitly permits HTTP only for loopback fake-mode development.

## Delivery diagnostics

An inbound webhook `200` acknowledges provider receipt/deduplication; it does not mean that the model ran or that a reply was sent. For a tenant-scoped incident, inspect `lmc_events` (`email_received`, `email_processing_skipped`, `email_processed`, and `email_job_failed`), then `lmc_jobs` and `lmc_messages` to distinguish acceptance, an intentional pause/suppression, processing retries, and delivery status. Failure events contain only job kind, sanitized failure code/category, attempt number and terminal status—never message text, addresses or credentials. A send job can still be pending after an `email_processed` event.

```sql
SELECT type, metadata, created_at
FROM lmc_events
WHERE tenant_id = $1 AND lead_id = $2
  AND type IN ('email_received', 'email_processing_skipped', 'email_processed', 'email_job_failed')
ORDER BY created_at;

SELECT kind, status, attempts, last_error, available_at
FROM lmc_jobs
WHERE tenant_id = $1 AND lead_id = $2
ORDER BY created_at;

SELECT direction, kind, status, sent_at, created_at
FROM lmc_messages
WHERE tenant_id = $1 AND lead_id = $2
ORDER BY created_at;
```

## Model boundary

The real adapter reuses `createAgentModel`, including the configured provider/model and existing OpenAI `store: false` setting. It passes trusted instructions separately from a JSON user payload containing only the selected business service names/aliases, tone and untrusted conversation data. It does not forward the tenant metadata field or expose tools. Output is capped at 2,048 tokens.

The SDK receives JSON Schema with required properties and nullable unknown facts. This follows the [official OpenAI structured-output requirement for required fields and nullable optional values](https://developers.openai.com/api/docs/guides/structured-outputs). Keeping the SDK boundary in JSON Schema avoids mixing the repository's Zod versions. Both the wire result and normalized decision are then checked against canonical contract schemas. Invalid output, refusal, timeout and provider errors become a sanitized model-unavailable failure; the email channel falls back to human handling.

## Verification and limits

The runtime tests use real PostgreSQL and the production consumer with fake providers, requiring a persisted sent message. They also observe active leases while two leads are processed. Unit tests cover provider mode selection, production opt-in, serial polling, queue failure/recovery and abort behavior. Separate SDK tests run actual structured generation against a model double and check the supplied schema, absence of tools/tenant metadata and rejection of malformed ZIP facts. No live model or email requests were made.

```sh
pnpm --filter @lobbystack/worker exec vitest run src/lmcEmail.test.ts
pnpm --filter @lobbystack/agent-core exec vitest run src/emailModel.test.ts src/emailModel-sdk.test.ts
# Requires the isolated test database and role URLs documented in EMAIL_CAPTURE.md:
pnpm exec vitest run --config tests/lmc/vitest.config.mts tests/lmc/worker-runtime.acceptance.ts
```

The complete hosted deployment, real-provider credential/DNS verification, initial-email forwarding ingestion, full legacy fake defaults, exhaustive tenant audit and one-command full demo remain unfinished. This checkpoint verifies the consumer and its integration hook, not a complete production deployment.

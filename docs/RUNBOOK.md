# LMC operations runbook

For the current email-pilot production profile, private real-provider template, deployment checklist and verified isolated recovery procedure, start with [PILOT_STAGING.md](PILOT_STAGING.md). RELEASE_GATE.md and STATUS.md contain current completion evidence. The generic legacy procedures below do not replace the dedicated pilot profile.

The local PostgreSQL/local-storage rehearsal has now passed, including exact 88-application-table equality, migration-journal preservation, RLS and checksum rejection. It does not establish live provider connectivity, an HTTPS deployment or hosted no-skip CI; those outcomes must be verified separately.

## Prepare and deploy

1. Read STATUS.md, ARCHITECTURE.md and the current tenant-isolation report. Complete
   the remaining release gates, including exhaustive A/B probes, ownership and
   association checks, dependency audit, secret scanning and SAST.
2. Install the pinned pnpm dependencies and run the actual lint, typecheck, tests
   and builds. Run LMC acceptance separately against its dedicated test database;
   its exhaustive test must eventually be green, not excluded or weakened.
3. Prepare an isolated staging deployment at the intended commit. Provision
   PostgreSQL/pgvector, Redis, storage and role-specific secrets through private
   configuration. App/worker/dispatcher/System must not be superusers or BYPASSRLS;
   internal System credentials must be separate from App. Use migration authority
   only for migrations/bootstrap. Keep secret values out of commands/logs/Git.
4. Back up before schema changes. Apply immutable migrations and bootstrap/verify
   roles using the documented database commands. Migration 0073 adds stored
   generated columns to 59 legacy relations; assess table rewrites/locks and use a
   maintenance window rather than assuming a lock-free rollout. Restart all
   affected runtimes after role/context/environment changes. See TENANT_IDENTITY.md.
5. Configure the real public URL, HTTPS proxy, authentication/cookie/domain
   settings, platform sending identity, `LMC_RECEIVING_DOMAIN`, signing secret and
   explicit real email-provider configuration. The `.invalid` demo contacts,
   sender and physical-address fixture are not production business settings.
   Each tenant must configure its actual footer address, service area/services,
   owner, rules and consent handling. See EMAIL_RUNTIME.md and EMAIL_INGESTION.md.
6. Configure/verify actual sender and inbound DNS/MX at the provider, connect signed
   email webhooks, and verify calendar authorization. Real API keys and DNS are
   manual work; no sandbox result here proves live delivery or live Google access.
7. Deploy matching admin/worker versions. Verify login, membership/selected-business
   behavior, anonymous API denial, signed inbound rejection, valid synthetic intake,
   worker readiness, owner summary, requester verification and opt-out using
   controlled authorized recipients. Legacy fake-default auditing is incomplete;
   do not assume every `pnpm dev` provider path is fake because the LMC demo is.
8. Record exact commit, migration version, configuration change identifiers,
   verification results, recovery point and rollback decision. Never record the
   credential values themselves.

Both admin and worker expose `/healthz` (liveness) and `/readyz` (readiness).
The original admin `/api/health/live`, `/api/health/ready` and worker `/health/live`,
`/health/ready` remain available. Liveness reports that the HTTP runtime is alive;
it stays successful when dependencies fail. Admin readiness requires its application
database and storage; worker readiness additionally requires Redis and its runtime
ready flag (including email consumer startup when enabled). A 503 is a deployment
configuration/dependency signal, not a reason to bypass readiness. Health responses
contain global operational metadata only, never tenant records. Admin supports
GET/HEAD plus automatic OPTIONS and rejects mutations; worker retains its existing
all-method behavior. Complete startup/header hardening remains release work.

## Pause and resume safely

For a tenant conversation, use the authorized CRM pause/human reply actions.
Human replies retain the conversation thread and pause AI. Consent/suppression
must not be cleared just to retry work. For an infrastructure incident, stop the
selected deployment's workers and prevent new writes before database recovery.

`LOBBYSTACK_MAINTENANCE_MODE=true` is startup isolation: recreate/restart the
selected runtimes so it takes effect. The worker then keeps health available while
remaining unready and avoiding queues/schedulers/providers. It is not a durable
webhook buffer, write freeze for unrelated systems, or an instantaneous switch for
already running work. Drain/stop active work deliberately and rely on provider retry
only where its actual delivery contract supports it. Resume only after reconciliation.

## Backups

The existing `replacement:backup` / `replacement:restore` scripts are **Compose
specific**: they target the selected project's `lobbystack` database and configured
local storage or MinIO mirror. They are not a generic backup command for the WSL
demo's differently named test database. Verify the actual project/env/storage target
before using them. Choose and measure your own RPO/RTO, schedule and retention.

For a verified Compose deployment, use a new restricted backup directory:

```sh
umask 077
REPLACEMENT_COMPOSE_PROJECT=your-reviewed-project \
REPLACEMENT_ENV_FILE=/absolute/private/deployment.env \
pnpm replacement:backup /absolute/restricted/new-backup-directory
```

The script identifies/stops running admin/worker writers, dumps PostgreSQL in custom
format, copies local storage or mirrors MinIO, creates checksums/manifest, and
restarts the writers it stopped. Plan for that interruption. Artifacts include
message/customer data and encrypted provider material: checksums prove integrity,
not confidentiality. Protect permissions, encrypt stored/transferred backups and
retain them in an independently protected location. The script itself does not
provide encryption or offsite retention. Escrow the required decryption/signing
secrets separately through secret management; do not add `.env` files to Git or
publish them with a report. Check the backup command exit and checksum artifacts.

## Restore test and recovery

Always rehearse against a disposable, explicitly selected Compose project with
separate volumes/bucket and private configuration. The restore command drops and
recreates its `lobbystack` database, flushes its Redis DB, and replaces the selected
storage contents. A wrong project or shared bucket is destructive. These source
guards require explicit project and confirmation flags; they do not establish that
an operator selected a disposable target correctly.

The existing automated drill writes database/storage markers, backs up, removes
them, restores, verifies both markers and retains the backup for inspection:

```sh
CONFIRM_REPLACEMENT_RESTORE_DRILL=1 \
REPLACEMENT_COMPOSE_PROJECT=your-disposable-restore-test \
REPLACEMENT_ENV_FILE=/absolute/private/restore-test.env \
pnpm replacement:restore-drill
```

Record its actual `replacement-restore-postgres: ok` and
`replacement-restore-storage: ok` results, duration and artifacts; these have **not**
been obtained in the current sandbox checkpoint. A marker drill also does not prove
every LMC workflow or external effect. Before release, test a controlled LMC
dataset, role/RLS state, job/message identities, booking/calendar data, suppression,
storage and restart behavior after an isolated restore.

For an approved recovery target and verified backup, the corresponding restore is:

```sh
CONFIRM_REPLACEMENT_RESTORE=1 \
REPLACEMENT_COMPOSE_PROJECT=your-reviewed-recovery-target \
REPLACEMENT_ENV_FILE=/absolute/private/recovery.env \
pnpm replacement:restore /absolute/restricted/verified-backup-directory
```

Keep outbound workers/providers disabled or maintenance isolated while restoring
and reconciling. Database restoration cannot undo emails, calls, calendar events or
other external effects that occurred after the backup. Reconcile provider records,
Message-IDs/idempotency keys, appointments and outbox/job states over that loss
window before replay. An old pending job is not proof that a recipient never got
the email. Respect finite provider idempotency windows; pause uncertain work for
human reconciliation rather than bulk replaying it. Verify actual role flags/RLS
after restore and retain the original encryption key needed by restored data.

The restore script restarts writers it found running. For recovery reconciliation,
preconfigure maintenance/isolation and ensure those restarted processes cannot send
until you deliberately resume. Verify checksums, expected data, storage, readiness,
the LMC workflow and lack of duplicate effects. Record the restoration decision and
measured data loss/recovery duration before reopening normal traffic.

## Incident response

- **Unexpected cross-tenant access:** isolate the affected routes/runtime, preserve
  minimal private evidence, verify actual database roles/contexts and membership/
  key routing, and run the real A/B regression. Revoke affected credentials through
  authorized operations. Do not suppress the test or relabel a leak as a global row.
- **Email loops, unwanted sends or opt-out failure:** pause the tenant/conversation,
  inspect signed-envelope authentication, automatic-mail checks, suppression,
  follow-up generation, consent, pending jobs and actual provider delivery. STOP
  must suppress future sends; do not clear suppression to work around the incident.
- **Uncertain send/retry:** preserve message/job/provider IDs privately, check actual
  delivery and idempotency age, and reconcile before retry. Do not invent a new
  idempotency key for the same uncertain delivery.
- **Booking conflict/calendar outage:** pause automated booking if necessary, compare
  canonical appointment/staff locks, offered slots, busy-block freshness and calendar
  synchronization status. Verify the requester before changes and use human handoff
  for uncertainty; do not manufacture availability.
- **Credential exposure:** stop affected integrations, rotate/revoke with the provider,
  replace private runtime configuration and restart affected services. Plan rotation
  consequences: capture tokens invalidate forms/intake aliases; encryption/HMAC keys
  affect stored encrypted material and existing key/capability verification. Preserve
  required recovery keys securely and avoid logging replacement values.

For every incident record affected tenant/deployment, sanitized timeline, containment,
root cause, exact regression, validation and operator-approved resumption. Run the
offline demo against its separate test database for a baseline workflow check; it
does not verify a recovered production deployment or close the current release gaps.

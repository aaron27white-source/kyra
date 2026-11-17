# Offline email workflow demo

After the local database prerequisites below are configured, run one command from
the repository root:

```sh
pnpm lmc:demo
```

It executes a signed initial email, a prompt reply asking one configured
qualification question, a verified qualification reply, a real canonical appointment,
synchronization through the fake calendar transport, and an owner summary with
history. A **separate unanswered form lead explicitly consents** to follow-ups.
The demo advances its fake clock, sends one follow-up, receives STOP, advances seven
more days and proves no further delivery. The booked lead never gets a follow-up.
This satisfies both the demo sequence and the requirement to stop follow-ups on
booking; it does not make an exception for booked contacts.

The application email handlers run over real temporary loopback HTTP, with the
production domain/worker logic, PostgreSQL, role-specific clients, queue leases,
qualification/booking locks, calendar outbox synchronization and durable messages.
Only external providers and clock are fake. The runner shares the acceptance
fixture to avoid maintaining a second business implementation. It does not start
Next.js, simulate a dashboard login, deploy a site, or establish complete Next/API
tenant-isolation coverage. The original exhaustive audit remains a separate gate.

## Prerequisites

Use the repository's installed Node 22.12+ / pnpm dependencies on Linux or WSL,
and a dedicated localhost PostgreSQL test database with pgvector. Apply migrations
and bootstrap the separate database roles following the README and database role
documentation. This command does not install PostgreSQL or change schema/roles.

Configure these in ignored `.env` / `.env.local`, or a separate private file:

| Variable | Purpose |
| --- | --- |
| `LMC_TEST_DATABASE_URL` | Privileged fixture/migration URL to an isolated local database with a separate `test` name token (for example `lmc_demo_test`). `LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL` is the existing fallback. |
| `LOBBYSTACK_APP_DATABASE_URL` | Separate `lobbystack_app` login to the same host/port/database. |
| `LOBBYSTACK_SYSTEM_DATABASE_URL` | Separate `lobbystack_system` login to that database. |
| `LOBBYSTACK_WORKER_DATABASE_URL` | Separate `lobbystack_worker` login to that database. |
| `LOBBYSTACK_DISPATCHER_DATABASE_URL` | Separate `lobbystack_dispatcher` login to that database. |
| `LMC_PROVIDER_MODE` | Omit or set `fake`. No real provider keys are needed. |

All four runtime logins are checked against their actual PostgreSQL identity and
must have neither superuser nor BYPASSRLS. No privileged runtime fallback is used.
The command refuses production mode, nonlocal/non-test targets, mismatched role
targets and real-provider mode. `test` must be delimited by a name boundary, underscore
or hyphen; names such as `latest` are rejected. URL query keys that can override
the parsed connection destination are rejected; only a single `sslmode` is accepted. The test fixture can generate a transient local
encryption key for its fake calendar token when no key is configured.

To select an existing private configuration file without shell-sourcing it:

```sh
LMC_DEMO_ENV_FILE=/absolute/path/local-demo.env pnpm lmc:demo
```

Inherited environment values take precedence. `.env.local` overrides file values
from `.env`; the explicitly selected private file is read last. No file contents,
connection passwords, signing keys or exception stacks are printed.

Run exclusively against this dedicated test database. A session advisory lock
prevents two demos overlapping; existing due email jobs cause an early refusal.
Other independently started acceptance workers do not share that lock, so do not
run those concurrently. The demo's real worker processes globally due tenant jobs,
just like the application, rather than replacing it with a fake queue.

## Reports and cleanup

```sh
pnpm lmc:demo --json
pnpm lmc:demo --output /existing/directory/report.json
pnpm --silent lmc:demo --json --output /existing/directory/report.json
pnpm lmc:demo --help
```

The default prints eight verified stages. `--json` emits a machine-readable report
(use pnpm `--silent` to suppress its command banner). The report contains synthetic
`.invalid` contacts, the observed first-response latency, booking/calendar results,
follow-up/STOP outcomes, owner summary and redacted conversation transcripts. It
contains no intake/reply/unsubscribe capabilities, job payloads or database URLs.

`--output` refuses to overwrite an existing path and uses restrictive file mode
where supported. It never saves real credentials. Demo business/contact/lead/
appointment/message/job data is removed at completion; the owner user, business
parent and original outbox row IDs are checked after cleanup. Thus it leaves a
report for review, not a persistent dashboard workspace. Error paths also close
the fixture and release the advisory lock/connections.

Errors are nonzero, sanitized codes. `DEMO_TEST_DATABASE_REQUIRED` or
`DEMO_RUNTIME_DATABASE_URLS_REQUIRED` means the local connection configuration is
missing/inconsistent; `DEMO_DATABASE_HAS_PENDING_WORK` means another fixture/workload
needs to finish first. Do not delete someone else's queue to bypass it.
`DEMO_OUTPUT_EXISTS` preserves the existing file; choose a new path.
`DEMO_PRODUCTION_FORBIDDEN` / `DEMO_FAKE_PROVIDERS_REQUIRED` requires a local fake
configuration. Unexpected infrastructure failures are `DEMO_FAILED`; check the
local database/service setup without exposing credentials in shared logs.

## Verification scope

The dedicated acceptance cases verify the full real HTTP/PostgreSQL workflow,
sub-five-second first reply, actual booking/calendar event/owner history,
consented follow-up, no booked-lead touches, STOP, zero later sends and fixture
cleanup. CLI cases execute the advertised package command, check JSON/file
agreement and refusal to clobber an existing report, and reject production/real
mode without leaking a sentinel environment secret. Script typechecking includes
the new runner/entry point. This demo is one deliverable of the full LMC goal;
remaining configuration, isolation, provider defaults and security/CI work stay open.

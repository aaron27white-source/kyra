# Lead My Company

Lead My Company helps service businesses capture, engage, and convert more leads into booked jobs — automatically, 24/7.

LMC is being built for US home-service contractors, starting with roofing businesses in Florida. The implemented email path includes form/direct/owner-forwarded intake, qualification, calendar-backed estimate booking, owner summaries, human handoff and bounded consented follow-ups. Run the offline demo below; see [STATUS](docs/STATUS.md) for the verified pilot gate and remaining manual deployment setup.

Pilot source: [`joaopramalho/kyra`, branch `lmc/v1`](https://github.com/joaopramalho/kyra/tree/lmc/v1).

## Local development

Use Linux or WSL2, Node 22.12 or newer and pnpm 10.30.3. The security tests intentionally depend on POSIX permissions and symbolic links.

For a fresh checkout of the pilot:

```sh
git clone --branch lmc/v1 https://github.com/joaopramalho/kyra.git lead-my-company
cd lead-my-company
```

```sh
corepack prepare pnpm@10.30.3 --activate
pnpm install --frozen-lockfile
pnpm -r --filter './packages/**' build
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

The default test command uses fake collaborators in unit tests and skips explicitly opted-in database tests. It does not send live email or make live voice calls. Do not enter production provider credentials for local tests. The offline email demo constructs fake providers explicitly. Real email adapters are opt-in. Inherited voice/SMS code remains outside the email pilot; its HTTP entry points are closed in production pilot mode.

For integration tests, use an isolated local PostgreSQL database with pgvector and Redis. Never point these tests at production. The repository includes Docker Compose infrastructure:

```sh
docker compose up -d postgres redis
pnpm db:migrate
pnpm --filter @lobbystack/db exec tsx src/cli.ts bootstrap
pnpm db:check
VERIFY_RLS_BEHAVIOR=true pnpm db:verify-rls
pnpm test:reliability
```

Configure local connection URLs using `.env.example` and the database-role documentation. `LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL` must point to a dedicated local database whose name contains `test`. Auth and Redis integration tests have separate explicit opt-ins. Keep secret values in ignored local environment files, never in source control.

Run `pnpm dev` for the dashboard, worker and marketing site, or `pnpm dev:admin` for the dashboard. The dashboard defaults to port 3000. Real domain DNS, provider credentials and production operations are a separate deployment step, not needed for the unit suite.

## Offline email demo

With a dedicated migrated localhost test database and separate runtime-role URLs
configured in ignored local environment files:

```sh
pnpm lmc:demo
```

The single command runs initial email → reply → verified qualification → booking
→ owner summary, then a consented follow-up and STOP on a separate unanswered
lead. It uses real HTTP/PostgreSQL/application logic with fake external providers
and clock, verifies no booked-lead follow-ups or later sends after STOP, and removes
the fixture. `--json` and `--output /existing/directory/report.json` provide a redacted
transcript/report; existing output files are preserved. It does not launch a
persistent dashboard or complete the exhaustive Next/API isolation audit.

See [offline demo setup and verification](docs/OFFLINE_DEMO.md) for the role URLs,
private `LMC_DEMO_ENV_FILE`, safety checks and exact report options.

## Architecture

- `apps/admin`: Next.js dashboard, authentication, APIs and embedded channels.
- `apps/worker`: asynchronous jobs, transactional outbox and the existing live voice controller.
- `apps/landing`: Astro public site.
- `packages/domain`: business workflows and booking logic.
- `packages/db`: PostgreSQL schema, migrations, role-specific clients and RLS.
- `packages/agent-core`: agent tools and voice runtime.
- `packages/providers`: provider adapters.
- `packages/shared/src/brand.ts`: shared LMC name, tagline, URL, colors and provisional logo path.

The existing voice runtime remains intact. Email uses a separate channel adapter while preserving the original voice controller and handler. Internal workspace names and database role names retain `lobbystack` to avoid unnecessary runtime migrations.

## Project status and verification

The email pilot release gate passed actual [GitHub Actions](https://github.com/joaopramalho/kyra/actions/runs/39903817220): all five required jobs succeeded and the downloaded sanitized artifact independently confirmed 2,274 passed / zero failed / zero skipped, with all 46 original acceptance sources included. The unchanged exhaustive case covers 88 application tables and 238 allowlisted API-method combinations. The gate includes build, types, targeted admin/landing lint, static artifact regressions, Gitleaks, strict Semgrep and the production high/critical dependency threshold. Development and lower-severity advisories remain documented. Real domain/provider/legal/hosting configuration is manual; no production deployment or live-provider readiness is claimed.

For the same complete no-skip runner, use a clean Linux/WSL checkout without private checkout env files and a local Docker daemon. Build first and stop any other admin dev preview while this command owns its test HTTP instances:

```sh
pnpm install --frozen-lockfile
pnpm build
node scripts/pilot-ci.mjs
```

The runner creates isolated PostgreSQL/Redis, actual runtime-role credentials and fake external providers, then removes its own resources. The ordinary `pnpm test` profile above retains its explicit integration opt-ins; use the pilot runner for the no-skip release proof.

- [Pilot release gate](docs/RELEASE_GATE.md)
- [Hosted/local CI scope and evidence](docs/PILOT_CI.md)
- [Production profile and backup/restore rehearsal](docs/PILOT_STAGING.md)
- [Tenant configuration CLI](docs/TENANT_CONFIGURATION.md)
- [Separate static public artifact](docs/STATIC_PUBLIC_SITE.md)
- [Production/development advisory triage](docs/DEV_ADVISORIES.md)

- [Reconnaissance and baseline](docs/RECON.md)
- [Implementation status](docs/STATUS.md)
- [Architecture and trust boundaries](docs/ARCHITECTURE.md)
- [Deployment, backup/restore and incident runbook](docs/RUNBOOK.md)
- [Dependency remediation and remaining security findings](docs/SECURITY_REMEDIATION.md)
- [Required CI security scans and reviewed exceptions](docs/SECURITY_SCANNING.md)
- [Website lead capture](docs/EMAIL_CAPTURE.md)
- [Email worker runtime](docs/EMAIL_RUNTIME.md)
- [Initial/forwarded email ingestion](docs/EMAIL_INGESTION.md)
- [Offline email demo](docs/OFFLINE_DEMO.md)
- [Tenant isolation audit](docs/TENANT_ISOLATION_AUDIT.md)
- [Decisions](docs/DECISIONS.md)
- [Historical upstream README](docs/UPSTREAM-README.md)

## Attribution

LMC derives from [Kyra by Aaron White / Key 20 Consultations](https://github.com/aaron27white-source/kyra), itself based on LobbyStack. Preserve [LICENSE](LICENSE), [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Existing authorship and upstream history are retained.

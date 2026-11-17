# Tenant configuration CLI

Run from the repository root in Linux/WSL with Node 22 and pnpm. The trusted operator commands create the initial business/staff, issue Google OAuth authorization, inspect owned setup metadata and configure the business. They expose no additional public endpoint. Authenticated pilot pages remain a separate release-gate requirement.

Copy `docs/examples/tenant.example.json` to a private working directory and replace every `[FILL]` value. The template intentionally fails validation until real identities and approved business details are supplied. Do not commit a populated file. Use a verified business administrator's user UUID and an active staff member and Google calendar connection owned by that same business. Provider access/refresh tokens are never accepted in this JSON.

Validate without connecting to a database:

```sh
pnpm --silent lmc:tenant --config /private/tenant.json --check
```

The execution environment must supply the dedicated App and Auth database credentials used by the application, and the approved sender/base URL/receiving domain. `.env` and `.env.local` are loaded without replacing inherited values; set `LOBBYSTACK_SKIP_ENV_FILES=true` to use only the supplied environment. Both actual database logins are checked even in development. Do not use a migrator/superuser connection as a runtime fallback. Production must use real provider configuration; development/test default to fake providers.

Apply using a new absolute output filename in an operator-controlled private directory:

```sh
pnpm --silent lmc:tenant --config /private/tenant.json --capabilities-file /private/new-tenant-capabilities.json
```

The output file is exclusively created with mode `0600` before any database mutation. An existing file is refused; neither the file nor tenant configuration is overwritten in that case. Standard output contains only status, tenant UUID, service count and synchronization flags. Initial capture credentials are written only to the private file. Keep this file private and back it up securely. The database stores only the capture token hash. Repeated configuration preserves the existing token and cannot recover its plaintext; a new output file then contains a preservation note. A post-commit file-write failure returns `TENANT_CONFIGURED_OUTPUT_FAILED`; inspect the tenant state and use the existing operator token-rotation flow before retrying capture setup.

The operation validates the complete JSON, verified operator, administrator membership, sender identity, owned calendar connection and active staff before writing. Services are upserted by business and slug, retaining stable IDs. Unrelated catalog entries are preserved. Configured services are assigned to the selected staff member. Hours replace the business schedule: day `0` is Sunday, minutes are local wall-clock minutes, omitted weekdays are closed, and overnight intervals are rejected. Repeated identical configuration makes no changes.

Service area, FAQs, escalation, follow-ups and email rules are stored in native email settings. FAQs enter the trusted model classification context; this does not add a free-form FAQ answer engine. Configured escalation keywords pause AI and use the approved handoff reply and existing owner alert. Emergency and injection handling retain precedence. Follow-ups are disabled in the template until explicitly approved.

Booking notice is in minutes and the horizon is one to seven local calendar days, including the current local day. Rules apply both to offered slots and final email booking/rescheduling checks. Requester verification cannot be disabled. Selecting a different calendar or staff member invalidates old busy blocks and sync freshness and queues reconciliation. The CLI never manufactures a successful calendar sync; the worker must complete synchronization before booking becomes available. It does not change voice scheduling.

Integration coverage in `tests/lmc/tenant-config.acceptance.ts` uses real PostgreSQL roles and exercises canonical state, idempotency, foreign-tenant and viewer denial, unverified-operator denial, calendar invalidation, trusted FAQ context, escalation, final booking rules, CLI execution, private file permissions and refusal to overwrite. Provider credentials are not required by these tests.

## Initial setup sequence

1. Register and verify the operator using the allowed authentication flow. Obtain that account UUID from its authenticated session. The CLI does not create accounts, grant platform privileges or bypass email verification. Keep that same account signed in when completing the Google callback.
2. Copy `docs/examples/tenant-bootstrap.example.json` to a private directory. Replace the UUID, name and slug placeholders. Slugs must be unique lowercase letters/digits, with single hyphens between non-empty segments, start with a letter and contain 2–120 characters. Set the business timezone and type.
3. Validate with `--check`, then run bootstrap with a new private output path:

```sh
pnpm --silent lmc:tenant-setup --config /private/bootstrap.json --check
pnpm --silent lmc:tenant-setup --config /private/bootstrap.json --private-output /private/business-setup.json
```

Bootstrap reuses canonical creation: one business, active owner membership, default staff, receptionist profile and initial snapshot job. It makes the business active for the operator. Repeating the same slug and matching details for an authorized business returns the same IDs without duplicating these records. Mismatched details are refused; use the existing update flow for changes. A slug collision with another business is refused. No migration or broader database grant is used.

4. Configure `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` and the same `BETTER_AUTH_SECRET` used by admin (at least 32 characters; short signing values are refused). Register the exact callback `/api/calendar/google/callback` in the Google OAuth app. Production requires HTTPS and the same origin as `APP_BASE_URL`; plain HTTP is permitted only for loopback development/test. Provider credentials go in the private process environment, never the operation JSON.
5. Fill `docs/examples/tenant-calendar-authorize.example.json` with the business UUID returned by bootstrap and the verified administrator UUID, then issue the authorization:

```sh
pnpm --silent lmc:tenant-setup --config /private/authorize.json --private-output /private/google-authorization.json
```

Open the `authorizationUrl` from that private file in the browser where the matching operator is signed in, and consent to the intended Google account. The URL is a bearer capability: do not share, log or commit it. It expires after ten minutes. Only its domain-separated digest and bound user/business identities are stored. The existing callback verifies signature, session identity and one-use consumption before exchanging a real authorization code. Denial or replay cannot connect a calendar. The CLI itself performs no Google network request. Real consent requires the operator and configured provider credentials; local tests do not claim real Google consent.

6. After the callback, use `docs/examples/tenant-inspect.example.json` to retrieve the owned active staff and calendar connection IDs into another private file:

```sh
pnpm --silent lmc:tenant-setup --config /private/inspect.json --private-output /private/calendar-setup.json
```

Inspection returns only business UUID, active staff IDs/names and calendar connection IDs/provider/status/selection. It never returns encrypted or plaintext provider credentials. Select the authorized Google calendar ID (`primary` selects that account's primary calendar), then fill `docs/examples/tenant.example.json` and run `pnpm lmc:tenant` as described above. The worker must finish reconciliation before booking is available.

All setup operations use the same App/Auth role checks and exclusive mode-0600 private output rules. `--check` parses the operation without connecting to a database. An existing output file fails before mutation. Pre-operation failures remove only the file reserved by this invocation. `TENANT_SETUP_PERFORMED_OUTPUT_FAILED` means the operation completed but its output could not be saved: bootstrap can be recovered by repeating its matching seed into a new file; an OAuth state expires and can be reissued. Do not assume the operation rolled back after that error.

The setup acceptance suite covers canonical idempotency, unverified-operator denial, viewer/foreign-tenant denial, actual CLI bootstrap/inspection, private output cleanup/no-overwrite, expiring digest-only OAuth persistence and unsafe/mismatched redirect rejection. The exhaustive HTTP audit also uses the CLI's state issuer and proves actual callback session binding, non-consumption by HEAD/another user, single consumption and replay denial. Provider tokens are still encrypted only by the existing callback.

## Dashboard access after setup

The signed-in operator must be verified, the selected business must be an active membership and the native LMC configuration must be valid before pilot leads/email pages open. Finish the configuration command before relying on dashboard access. During initial calendar authorization the callback may redirect to email settings before configuration exists; that page remains 404 until the seed is complete. Use the trusted `inspect` operation to confirm the owned calendar connection and obtain its IDs, then finish `lmc:tenant`. A callback destination 404 at this intermediate point is not proof that the provider connection failed. Neither the CLI nor page entry marks voice onboarding complete.

Current gate update: actual [hosted pilot CI](https://github.com/joaopramalho/kyra/actions/runs/39903817220) subsequently passed with no skipped tests; see PILOT_CI.md and RELEASE_GATE.md. This supersedes the earlier hosted-CI pending notes in this historical checkpoint. Provider/DNS/legal/host configuration and actual deployment remain manual as described in STATUS.md.

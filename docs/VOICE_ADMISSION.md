# Internal live-call admission

The worker authenticates `/internal/live/attach` with its existing internal service
token. That token grants internal service authority; it is not a tenant credential.
An authenticated caller must still present a consistent durable call identity.

A real-HTTP/PostgreSQL regression first demonstrated that mixing a tenant B business
ID with an active tenant A session/call received 202 through the duplicate-session
path. This proves an authenticated admission inconsistency, not an unauthenticated
endpoint exploit or demonstrated access to another tenant's data.

`verifiedLiveAttach.ts` now wraps the existing voice handler in the production
worker entry. Before snapshot loading or session deduplication, the domain admission
query checks the canonical business, call, OpenAI provider/session, gateway session,
transport, unfinished state and unblocked status. A supplied conversation must match
the call, and any stored conversation must belong to the same business. The query
uses the actual worker role and business transaction. Invalid/absent identities all
receive 404; database failures fail closed with 503.

The wrapper bounds the raw body at 16 KiB, returns 400 for invalid JSON/shape and
413 for oversized input, then replays the validated bytes to the unchanged voice
handler. Existing authentication, disabled-feature and method behavior stays in
that handler. Its controller, snapshot personalization and agent implementation
were not edited. An omitted conversation remains supported by the existing API.

The acceptance test uses the real HTTP server, controller, receptionist agent,
snapshot publication/read, worker-role PostgreSQL transactions and durable call
completion. Only the external OpenAI SDK/WebSocket and Redis transports are fake;
all test credentials are synthetic. Both phone and browser channels start and close
successfully. The test checks cross-tenant/mixed identities before and after valid
attaches, cross-business stored conversation FKs, blocked/ended calls, provider and
session mismatches, invalid bodies, authentication, methods, duplicate controls and
the disabled flag. It observes each business's own greeting and persisted completion.

Validation: the regression changed from 202 versus expected 404 to passing; worker
97 tests, domain 497 tests and agent-core 103 reported tests pass (the last count
includes source/compiled duplicates). Worker/domain and audit typechecks and the
packaged worker build pass. No production database migration or real credential
was needed. Full project completion and exhaustive API isolation remain open.

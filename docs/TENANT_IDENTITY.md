# Canonical tenant identity

Migration 0073 adds a physical `tenant_id uuid NOT NULL` column to 59 legacy
relations: the business root and every relation whose existing `business_id` is
non-null. PostgreSQL stores the column as a generated value of that ownership key
(`id` on businesses). Existing rows are populated automatically, and even a
privileged connection cannot assign a different tenant identity independently.

The existing ownership key remains the source of truth for legacy application
code. Its foreign keys, indexes, and FORCE-RLS predicates continue to apply. The
generated equality makes predicates on `business_id` equivalent to predicates on
`tenant_id`; request transactions still set the same business/tenant UUID in their
established context. No voice handler, tool, or snapshot source was changed.
The seven native email tables already have required tenant keys and policies.
There are now 66 relations with a non-null tenant key in the 88-table inventory.

Raw migrations own these generated columns. They are omitted from legacy ORM
write/read shapes so existing payloads and voice queries retain their current
shape. Future schema-generation or introspection work must preserve the physical
generated expressions and their NOT NULL constraints. Treat these columns as
database-managed identity, never as a second writable tenant selector.

## Validation

The new acceptance test failed against all 59 legacy targets before implementation.
After migration it checks catalog types, stored generation expressions, NOT NULL,
FORCE RLS, policy presence, actual A/B values, and rejected reassignment on every
target. The strongest administrative connection must receive PostgreSQL 428C9
when it attempts reassignment. The independent catalog checker also rejects a
new directly-owned table without the canonical key.

Real app-role CRUD probes still run on all 88 relations, including valid INSERT
positive controls and detection of deliberately permissive policies. The full
domain integration suite passes after this migration, as do the agent-core/voice
tests. Structural identity checks do not replace behavioral authorization tests.

## Rollout

The stored column addition can rewrite existing relations and requires table
locks. Drain traffic and use a maintenance window for an existing production
database; retain the normal verified backup/restore procedure and rehearse the
migration against its database size first. Apply the immutable migration through
the migration CLI, rerun it to confirm the journal recognizes it, and run schema
and behavioral RLS checks before restoring traffic. No new credentials are needed.
Only the isolated local test database has been migrated in this task.

## Remaining ownership work

Five relations mix global and business-scoped rows and still have nullable
`business_id`: `feedback_submissions`, `idempotency_keys`, `outbox_messages`,
`product_events`, and `provider_events`. Their tenant-owned records still need
an explicit storage separation or ownership design. A fabricated fallback tenant
would not resolve that requirement, so this migration does not assign one.

The remaining 17 relations are global or user/OAuth/affiliate scoped candidates:
`accounts`, `sessions`, `users`, `verifications`, `affiliate_clicks`,
`affiliate_commissions`, `affiliate_payout_items`, `affiliate_payout_runs`,
`affiliate_profile_stats`, `affiliate_profiles`, `oauth_access_tokens`,
`oauth_client_assertions`, `oauth_client_resources`, `oauth_clients`,
`oauth_consents`, `oauth_refresh_tokens`, and `oauth_resources`. Their scope and
policies require final review before any exemption from business tenancy is
declared complete. All remain in the independent inventory and CRUD probes.

The full tenant-isolation phase remains incomplete, including these ownership
decisions and the unprobed HTTP routes. This additive migration is one part of the
original requirement, not a declaration that every tenant-owned table is finished.

# Internal database identity

Migration `0072_system_identity.sql` separates trusted internal operations from the
user-facing `lobbystack_app` connection. Setting `app.actor_type=system` on an app
connection must not grant internal authority. The actor function recognizes that
actor only when PostgreSQL `current_user` is `lobbystack_system`.

The internal role inherits app object grants in one direction. It has no
superuser, BYPASSRLS, database creation, role creation, or replication privilege.
The app role must not be a direct or indirect member of the internal role.

`withBusinessTransaction` routes explicitly requested internal operations on a
registered app client through a separately authenticated, short-lived connection.
It verifies the effective role even outside production and requires the same
host, port, and database as the original app connection. Missing credentials or a
different database fail closed. Request data must never select the actor type.

Generate a separate `LOBBYSTACK_SYSTEM_PASSWORD` with `pnpm env:generate` for a new
environment. Existing installations must provision a fresh password explicitly;
do not regenerate the entire environment or rotate unrelated keys. An explicit
`LOBBYSTACK_SYSTEM_DATABASE_URL` can be used instead. It must identify the same
database as the app connection. Neither option may use app or administrator
credentials.

For an existing database, drain and stop application traffic, apply migrations
with the privileged migration connection, and run the DB CLI `bootstrap` with
the new system password provided through the deployment secret store. Configure
the admin runtime with the password or explicit URL, then restart it and verify
startup role assertions before admitting traffic. Fresh Compose volumes provision
the login through `docker/postgres/init/roles.sh`; existing volumes still need the
explicit bootstrap step. No credentials belong in source control or command logs.

Validation must include raw app actor spoofing, rejected `SET ROLE` escalation,
legitimate business creation, and the original tenancy, affiliate, demo, and auth
regressions. A green structural RLS inventory alone does not prove isolation.

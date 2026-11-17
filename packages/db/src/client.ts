import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";

import { getMeter, getTracer, recordException } from "@lobbystack/telemetry/node";

import { rlsContextStatements, type RlsContext } from "./rls/context";
import { schema } from "./schema";
import { instrumentPool } from "./instrumentation";

export type Database = NodePgDatabase<typeof schema>;
export type DatabaseTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export type DatabaseRole =
  | "lobbystack_migrator"
  | "lobbystack_auth"
  | "lobbystack_app"
  | "lobbystack_system"
  | "lobbystack_worker"
  | "lobbystack_dispatcher"
  | "lobbystack_readonly"
  | "lobbystack_finance_export";

export type DatabaseClient = {
  pool: Pool;
  db: Database;
  role: DatabaseRole;
};

// Metadata identifies the connection capability; SQL session settings cannot grant it.
const databaseSources = new WeakMap<Database, { role: DatabaseRole; source: Record<string, string | undefined> }>();

const poolWaitHistogram = getMeter("lobbystack-db").createHistogram("db.pool.wait_ms", {
  unit: "ms",
  description: "Time spent waiting for a PostgreSQL pool connection",
});
const queryDurationHistogram = getMeter("lobbystack-db").createHistogram("db.query.duration_ms", {
  unit: "ms",
  description: "PostgreSQL query duration without bind values",
});
const transactionDurationHistogram = getMeter("lobbystack-db").createHistogram("db.transaction.duration_ms", {
  unit: "ms",
  description: "PostgreSQL transaction duration",
});

function databaseUrl(source: Record<string, string | undefined> = process.env): string {
  const value = source.DATABASE_URL;
  if (!value) {
    throw new Error("DATABASE_URL is required for PostgreSQL access.");
  }
  return value;
}

// Resolves a role's connection string: an explicit `<ROLE>_DATABASE_URL` wins; otherwise, when
// `<ROLE>_PASSWORD` is set, reuse DATABASE_URL's host and database with that role's credentials.
// The migrator never derives: the migrate job holds every role password for `bootstrap`, but it must
// connect with DATABASE_URL as given (the superuser on fresh installs).
export function roleDatabaseUrl(role: DatabaseRole, source: Record<string, string | undefined> = process.env): string {
  const explicit = source[`${role.toUpperCase()}_DATABASE_URL`];
  if (explicit) return explicit;
  if (role === "lobbystack_system" && !source.LOBBYSTACK_SYSTEM_PASSWORD) {
    throw new Error("LOBBYSTACK_SYSTEM_CREDENTIALS_REQUIRED");
  }
  const base = databaseUrl(source);
  const password = role === "lobbystack_migrator" ? undefined : source[`${role.toUpperCase()}_PASSWORD`];
  if (!password) return base;
  const url = new URL(base);
  url.username = role;
  url.password = password;
  return url.toString();
}

function poolConfig(role: DatabaseRole, source: Record<string, string | undefined>): PoolConfig {
  return {
    connectionString: roleDatabaseUrl(role, source),
    application_name: `lobbystack:${role}`,
    max: Number(source[`${role.toUpperCase()}_POOL_MAX`] ?? (role === "lobbystack_dispatcher" ? 4 : 12)),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    keepAlive: true,
  };
}

export function createDatabaseClient(
  role: DatabaseRole,
  source: Record<string, string | undefined> = process.env,
): DatabaseClient {
  const pool = new Pool(poolConfig(role, source));
  instrumentPool(pool, role, { query: queryDurationHistogram, wait: poolWaitHistogram });
  pool.on("error", (error) => {
    recordException(error, { service: "database", operation: "pool_error", role });
  });

  const db = drizzle(pool, { schema });
  databaseSources.set(db, { role, source: { ...source } });
  return { pool, db, role };
}

export function createDatabaseClients(
  source: Record<string, string | undefined> = process.env,
): Record<DatabaseRole, DatabaseClient> {
  return {
    lobbystack_migrator: createDatabaseClient("lobbystack_migrator", source),
    lobbystack_auth: createDatabaseClient("lobbystack_auth", source),
    lobbystack_app: createDatabaseClient("lobbystack_app", source),
    lobbystack_system: createDatabaseClient("lobbystack_system", source),
    lobbystack_worker: createDatabaseClient("lobbystack_worker", source),
    lobbystack_dispatcher: createDatabaseClient("lobbystack_dispatcher", source),
    lobbystack_readonly: createDatabaseClient("lobbystack_readonly", source),
    lobbystack_finance_export: createDatabaseClient("lobbystack_finance_export", source),
  };
}

export async function withBusinessTransaction<T>(
  db: Database,
  context: RlsContext,
  callback: (tx: DatabaseTransaction) => Promise<T>,
  options: { maxRetries?: number } = {},
): Promise<T> {
  const origin = databaseSources.get(db);
  if (context.actorType === "system" && origin?.role === "lobbystack_app") {
    const source = { ...process.env, ...origin.source };
    const appTarget = new URL(roleDatabaseUrl("lobbystack_app", origin.source));
    const systemTarget = new URL(roleDatabaseUrl("lobbystack_system", source));
    if (appTarget.hostname !== systemTarget.hostname || appTarget.port !== systemTarget.port || appTarget.pathname !== systemTarget.pathname) {
      throw new Error("LOBBYSTACK_SYSTEM_DATABASE_MISMATCH");
    }
    const internal = createDatabaseClient("lobbystack_system", source);
    try {
      await assertDatabaseRole(internal, { NODE_ENV: "production" });
      return await withBusinessTransaction(internal.db, context, callback, options);
    } finally {
      await internal.pool.end();
    }
  }
  const maxRetries = options.maxRetries ?? 3;
  const tracer = getTracer("lobbystack-db");

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const startedAt = Date.now();
    const span = tracer.startSpan("db.transaction", {
      attributes: {
        "db.system": "postgresql",
        "db.operation.name": "transaction",
        "lobbystack.actor_type": context.actorType,
        "lobbystack.retry_attempt": attempt,
      },
    });

    try {
      const result = await db.transaction(async (tx) => {
        // An existing transaction may be owned by a privileged migration/test session.
        // SET ROLE here needs PostgreSQL membership; a raw app login cannot elevate.
        let previousRole: string | undefined;
        if (context.actorType === "system" && !origin) {
          const result = await tx.execute<{ role: string }>(sql`select current_user as role`);
          previousRole = result.rows[0]?.role;
          if (!previousRole) throw new Error("MISSING_DATABASE_ROLE");
          await tx.execute(sql`set local role lobbystack_system`);
        }
        for (const statement of rlsContextStatements(context)) {
          await tx.execute(statement);
        }
        const result = await callback(tx);
        if (previousRole) {
          await tx.execute(sql.raw(`set local role "${previousRole.replaceAll('"', '""')}"`));
        }
        return result;
      });
      span.end();
      transactionDurationHistogram.record(Date.now() - startedAt, {
        actor_type: context.actorType,
        outcome: "success",
      });
      return result;
    } catch (error) {
      recordException(error, {
        service: "database",
        operation: "transaction",
        actorType: context.actorType,
      });
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.end();
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (code !== "40001" || attempt >= maxRetries) {
        transactionDurationHistogram.record(Date.now() - startedAt, {
          actor_type: context.actorType,
          outcome: "error",
        });
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
    }
  }

  throw new Error("PostgreSQL transaction retry loop exhausted.");
}

export async function withDispatcherTransaction<T>(
  db: Database,
  callback: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
  return await withBusinessTransaction(db, { actorType: "dispatcher" }, callback);
}

export async function assertDatabaseRole(
  client: DatabaseClient,
  source: Record<string, string | undefined> = process.env,
): Promise<void> {
  if (source.NODE_ENV !== "production" || client.role === "lobbystack_migrator") return;
  const result = await client.pool.query<{ role: string; privileged: boolean }>(`
    select current_user as role,
      (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb) as privileged
    from pg_roles where rolname = current_user
  `);
  const effective = result.rows[0];
  if (!effective || effective.role !== client.role || effective.privileged) {
    throw new Error(`Database role assertion failed: expected unprivileged ${client.role}.`);
  }
}

export async function databaseHealthCheck(client: DatabaseClient): Promise<{
  ok: boolean;
  latencyMs: number;
  role: DatabaseRole;
}> {
  const startedAt = Date.now();
  const span = getTracer("lobbystack-db").startSpan("db.health_check", {
    attributes: { "db.system": "postgresql", "db.operation.name": "health_check" },
  });
  try {
    await client.db.execute(sql`select 1`);
    const latencyMs = Date.now() - startedAt;
    span.end();
    return { ok: true, latencyMs, role: client.role };
  } catch (error) {
    recordException(error, { service: "database", operation: "health_check", role: client.role });
    span.recordException(error instanceof Error ? error : new Error(String(error)));
    span.end();
    return { ok: false, latencyMs: Date.now() - startedAt, role: client.role };
  }
}

export async function closeDatabaseClients(clients: Record<DatabaseRole, DatabaseClient>): Promise<void> {
  await Promise.all(Object.values(clients).map((client) => client.pool.end()));
}

export function newRequestId(): string {
  return randomUUID();
}

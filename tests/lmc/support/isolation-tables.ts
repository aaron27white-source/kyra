import type { openLmcTestDatabase } from "./database";
import type { AuditTable } from "./isolation-inventory";
import {
  quote,
  type FixtureRow,
  type FixtureTenant,
} from "./isolation-fixtures";

function predicate(table: AuditTable, row: FixtureRow, offset = 0) {
  if (!table.primaryKey.length)
    throw new Error(`MISSING_PROBE_PRIMARY_KEY:${table.name}`);
  return {
    sql: table.primaryKey
      .map((column, index) => `${quote(column)}=$${index + 1 + offset}`)
      .join(" and "),
    values: table.primaryKey.map((column) => row[column]),
  };
}

/** Executes against an actual app login, not an administrative SET ROLE connection. Every mutation rolls back. */
export async function probeStoredTables(
  db: ReturnType<typeof openLmcTestDatabase>,
  tables: AuditTable[],
  a: FixtureTenant,
  b: FixtureTenant,
) {
  const failures: string[] = [],
    probed: string[] = [];
  const client = await db.app.pool.connect();
  try {
    for (const table of tables) {
      const own = a.rows.get(table.name),
        foreign = b.rows.get(table.name);
      if (!own || !foreign) {
        failures.push(`UNSEEDED_PROBE:${table.name}`);
        continue;
      }
      const ownWhere = predicate(table, own),
        foreignWhere = predicate(table, foreign);
      // Positive controls come from committed admin-created fixtures, never an empty relation.
      for (const row of [own, foreign]) {
        const where = predicate(table, row);
        const control = await db.admin.pool.query(
          `select 1 from public.${quote(table.name)} where ${where.sql}`,
          where.values,
        );
        if (control.rowCount !== 1)
          throw new Error(`MISSING_PERSISTED_CONTROL:${table.name}`);
      }
      await client.query("begin");
      try {
        const permissions = await client.query<{
          name: string;
          read: boolean;
          write: boolean;
        }>(
          `select a.attname as name,has_column_privilege(current_user,c.oid,a.attnum,'SELECT') as read,has_column_privilege(current_user,c.oid,a.attnum,'UPDATE') as write from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid where n.nspname='public' and c.relname=$1 and a.attnum>0 and not a.attisdropped`,
          [table.name],
        );
        const pkReadable = table.primaryKey.every((column) =>
          permissions.rows.some(
            (permission) => permission.name === column && permission.read,
          ),
        );
        async function context(
          tenantId: string,
          userId: string,
          actor: string,
        ) {
          await client.query(
            `select set_config('app.business_id',$1,true),set_config('app.user_id',$2,true),set_config('app.actor_type',$3,true)`,
            [tenantId, userId, actor],
          );
        }
        async function run(query: string, values: unknown[]) {
          await client.query("savepoint audit_operation");
          try {
            const result = await client.query(query, values);
            await client.query("rollback to savepoint audit_operation");
            await client.query("release savepoint audit_operation");
            return { rows: result.rowCount ?? 0, code: "" };
          } catch (error) {
            await client.query("rollback to savepoint audit_operation");
            await client.query("release savepoint audit_operation");
            return {
              rows: 0,
              code: String(
                (error as { code?: string }).code ?? "UNKNOWN_PROBE_ERROR",
              ),
            };
          }
        }
        await context(a.tenantId, a.userId, "operator");
        const ownRead = await run(
          `select 1 from public.${quote(table.name)} where ${ownWhere.sql}`,
          ownWhere.values,
        );
        if (pkReadable && (ownRead.code || ownRead.rows !== 1))
          failures.push(
            `OWN_READ_NOT_PROVEN:${table.name}:${ownRead.code || ownRead.rows}`,
          );
        if (!pkReadable && ownRead.code !== "42501")
          failures.push(`GRANT_DENIAL_NOT_PROVEN:${table.name}`);
        for (const [tenantId, userId, actor] of [
          [a.tenantId, a.userId, "operator"],
          [b.tenantId, a.userId, "operator"],
          [b.tenantId, a.userId, "worker"],
          [b.tenantId, a.userId, "dispatcher"],
          [b.tenantId, a.userId, "system"],
          [b.tenantId, "", "operator"],
        ]) {
          await context(tenantId!, userId!, actor!);
          const read = await run(
            `select 1 from public.${quote(table.name)} where ${foreignWhere.sql}`,
            foreignWhere.values,
          );
          if (read.rows)
            failures.push(`CROSS_TENANT_READ:${table.name}:${actor}`);
          if (read.code && read.code !== "42501")
            failures.push(`READ_PROBE_ERROR:${table.name}:${read.code}`);
          const writable =
            permissions.rows.find(
              (permission) =>
                permission.write &&
                table.columns.some(
                  (column) =>
                    column.name === permission.name &&
                    !column.generated &&
                    !column.identity,
                ),
            )?.name ??
            table.columns.find(
              (column) => !column.generated && !column.identity,
            )!.name;
          const updateWhere = predicate(table, foreign, 1);
          const update = await run(
            `update public.${quote(table.name)} set ${quote(writable)}=$1 where ${updateWhere.sql} returning 1`,
            [foreign[writable], ...updateWhere.values],
          );
          if (update.rows)
            failures.push(`CROSS_TENANT_UPDATE:${table.name}:${actor}`);
          if (update.code && update.code !== "42501")
            failures.push(`UPDATE_PROBE_ERROR:${table.name}:${update.code}`);
          const deletion = await run(
            `delete from public.${quote(table.name)} where ${foreignWhere.sql} returning 1`,
            foreignWhere.values,
          );
          if (deletion.rows)
            failures.push(`CROSS_TENANT_DELETE:${table.name}:${actor}`);
          if (deletion.code && deletion.code !== "42501")
            failures.push(`DELETE_PROBE_ERROR:${table.name}:${deletion.code}`);
        }
        probed.push(table.name);
      } finally {
        await client.query("rollback");
      }
    }
  } finally {
    client.release();
  }
  return { failures: [...new Set(failures)], probed };
}

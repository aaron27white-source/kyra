import type { openLmcTestDatabase } from "./database";
import type { AuditTable } from "./isolation-inventory";
import {
  buildIsolationRow,
  fixtureDependencies,
  quote,
  seedIsolationFixtures,
  type FixtureRow,
} from "./isolation-fixtures";

function parentTables(target: AuditTable, catalog: AuditTable[]) {
  const names = new Set<string>();
  function visit(table: AuditTable) {
    for (const name of fixtureDependencies(table)) {
      if (name === target.name)
        throw new Error(`CYCLIC_INSERT_FIXTURE:${target.name}`);
      if (names.has(name)) continue;
      const parent = catalog.find((candidate) => candidate.name === name);
      if (!parent) throw new Error(`MISSING_INSERT_PARENT:${name}`);
      names.add(name);
      visit(parent);
    }
  }
  visit(target);
  return catalog.filter((table) => names.has(table.name));
}

function insert(table: AuditTable, row: FixtureRow, returning = false) {
  const columns = table.columns.filter(
    (column) =>
      !column.generated && !column.identity && row[column.name] !== undefined,
  );
  return {
    text: `insert into public.${quote(table.name)} (${columns.map((column) => quote(column.name)).join(",")}) values (${columns.map((_, index) => `$${index + 1}`).join(",")})${returning ? " returning *" : ""}`,
    values: columns.map((column) =>
      /^(json|jsonb)$/.test(column.type) && row[column.name] !== null
        ? JSON.stringify(row[column.name])
        : row[column.name],
    ),
  };
}

/** Each target gets fresh committed parents and an absent target row. Unique/FK errors never count as authorization denial. */
export async function probeTableInserts(
  db: ReturnType<typeof openLmcTestDatabase>,
  tables: AuditTable[],
) {
  const failures: string[] = [],
    probed: string[] = [];
  for (const table of tables) {
    let fixtures: Awaited<ReturnType<typeof seedIsolationFixtures>> | undefined;
    try {
      fixtures = await seedIsolationFixtures(db, parentTables(table, tables));
      if (fixtures.failures.length) {
        failures.push(
          ...fixtures.failures.map(
            (value) => `INSERT_PARENT:${table.name}:${value}`,
          ),
        );
        continue;
      }
      const candidate = buildIsolationRow(table, fixtures.b);
      // Prove the exact row passes all constraints, then remove it before app probes.
      const control = await db.admin.pool.connect();
      let valid: FixtureRow | undefined;
      try {
        await control.query("begin");
        const statement = insert(table, candidate, true);
        valid = (
          await control.query<FixtureRow>(statement.text, statement.values)
        ).rows[0];
      } finally {
        await control.query("rollback");
        control.release();
      }
      if (!valid) throw new Error("NO_VALID_INSERT_CONTROL");
      const statement = insert(table, valid);
      // Round trip the fully materialized payload as well, rather than relying on different defaults.
      const positive = await db.admin.pool.connect();
      try {
        await positive.query("begin");
        await positive.query(statement.text, statement.values);
      } finally {
        await positive.query("rollback");
        positive.release();
      }
      const client = await db.app.pool.connect();
      try {
        for (const [tenant, user, actor] of [
          [fixtures.a.tenantId, fixtures.a.userId, "operator"],
          [fixtures.b.tenantId, fixtures.a.userId, "operator"],
          [fixtures.b.tenantId, fixtures.a.userId, "system"],
          [fixtures.b.tenantId, fixtures.a.userId, "worker"],
          [fixtures.b.tenantId, fixtures.a.userId, "dispatcher"],
          [fixtures.b.tenantId, "", "operator"],
        ]) {
          await client.query("begin");
          try {
            await client.query(
              `select set_config('app.business_id',$1,true),set_config('app.user_id',$2,true),set_config('app.actor_type',$3,true)`,
              [tenant, user, actor],
            );
            const result = await client.query(statement.text, statement.values);
            failures.push(
              `CROSS_TENANT_INSERT:${table.name}:${actor}:${result.rowCount}`,
            );
          } catch (error) {
            const code = String((error as { code?: string }).code ?? "UNKNOWN");
            if (code !== "42501")
              failures.push(`INSERT_PROBE_ERROR:${table.name}:${code}`);
          } finally {
            await client.query("rollback");
          }
        }
      } finally {
        client.release();
      }
      probed.push(table.name);
    } catch (error) {
      const detail = error as { code?: string; message?: string };
      failures.push(
        `INVALID_INSERT_CONTROL:${table.name}:${detail.code ?? (detail.message?.startsWith("DEPENDENCY:") ? detail.message : "FIXTURE_ERROR")}`,
      );
    } finally {
      await fixtures?.cleanup();
    }
  }
  return { failures: [...new Set(failures)], probed };
}

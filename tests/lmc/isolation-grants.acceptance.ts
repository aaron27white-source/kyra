import { it, expect } from "vitest";
import { openLmcTestDatabase } from "./support/database";
it("checks that column grants cannot mask cross-tenant mutation probes", async () => {
  const db = openLmcTestDatabase();
  try {
    const result = await db.admin.pool.query(
      `select c.relname as name, has_any_column_privilege('lobbystack_app',c.oid,'UPDATE') as updates, has_table_privilege('lobbystack_app',c.oid,'DELETE') as deletes, bool_and(has_column_privilege('lobbystack_app',c.oid,a.attnum,'SELECT')) as pkread from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_constraint k on k.conrelid=c.oid and k.contype='p' join pg_attribute a on a.attrelid=c.oid and a.attnum=any(k.conkey) where n.nspname='public' group by c.oid,c.relname having (has_any_column_privilege('lobbystack_app',c.oid,'UPDATE') or has_table_privilege('lobbystack_app',c.oid,'DELETE')) and not bool_and(has_column_privilege('lobbystack_app',c.oid,a.attnum,'SELECT'))`,
    );
    expect(result.rows).toEqual([]);
    // Materialized INSERT controls must not include a forbidden column that could mask bad RLS.
    const inserts = await db.admin.pool.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid where n.nspname='public' and c.relkind in ('r','p') and a.attnum>0 and not a.attisdropped and a.attgenerated='' and a.attidentity='' group by c.oid,c.relname having has_any_column_privilege('lobbystack_app',c.oid,'INSERT') and not bool_and(has_column_privilege('lobbystack_app',c.oid,a.attnum,'INSERT'))`,
    );
    expect(inserts.rows).toEqual([]);
  } finally {
    await db.close();
  }
});

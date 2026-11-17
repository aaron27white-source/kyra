import { probeTableInserts } from "./support/isolation-inserts";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { openLmcTestDatabase } from "./support/database";
import {
  readIsolationCatalog,
  checkCatalogProtection,
} from "./support/isolation-inventory";
import { quote, seedIsolationFixtures } from "./support/isolation-fixtures";
import { probeStoredTables } from "./support/isolation-tables";

it("checks persisted A/B reads, updates, deletes and actor/context spoofing on every application table", async () => {
  const db = openLmcTestDatabase();
  let fixtures: Awaited<ReturnType<typeof seedIsolationFixtures>> | undefined;
  try {
    const catalog = await readIsolationCatalog(db);
    fixtures = await seedIsolationFixtures(db, catalog.tables);
    expect(fixtures.failures).toEqual([]);
    const result = await probeStoredTables(
      db,
      catalog.tables,
      fixtures.a,
      fixtures.b,
    );
    expect(result.failures).toEqual([]);
    expect(result.probed.sort()).toEqual(
      catalog.tables.map((table) => table.name).sort(),
    );
  } finally {
    await fixtures?.cleanup();
    await db.close();
  }
});
it("detects real cross-tenant behavior even when an added table has FORCE RLS and an existing permissive policy", async () => {
  const db = openLmcTestDatabase(),
    name = `audit_mutant_${randomUUID().replace(/-/g, "")}`;
  let fixtures: Awaited<ReturnType<typeof seedIsolationFixtures>> | undefined;
  try {
    await db.admin.pool.query(
      `create table public.${quote(name)} (id uuid primary key default gen_random_uuid(),tenant_id uuid not null)`,
    );
    await db.admin.pool.query(
      `alter table public.${quote(name)} enable row level security; alter table public.${quote(name)} force row level security; create policy unsafe on public.${quote(name)} using (true) with check (true); grant select,insert,update,delete on public.${quote(name)} to lobbystack_app`,
    );
    const catalog = await readIsolationCatalog(db);
    expect(checkCatalogProtection(catalog)).toEqual([]);
    fixtures = await seedIsolationFixtures(db, catalog.tables);
    expect(fixtures.failures).toEqual([]);
    const result = await probeStoredTables(
      db,
      catalog.tables.filter((table) => table.name === name),
      fixtures.a,
      fixtures.b,
    );
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`CROSS_TENANT_READ:${name}`),
        expect.stringContaining(`CROSS_TENANT_UPDATE:${name}`),
        expect.stringContaining(`CROSS_TENANT_DELETE:${name}`),
      ]),
    );
    const inserts = await probeTableInserts(
      db,
      catalog.tables.filter((table) => table.name === name),
    );
    expect(inserts.failures).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`CROSS_TENANT_INSERT:${name}`),
      ]),
    );
  } finally {
    try {
      await fixtures?.cleanup();
    } finally {
      await db.admin.pool.query(`drop table if exists public.${quote(name)}`);
      await db.close();
    }
  }
});

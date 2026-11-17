import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { businesses, businessMemberships, createDatabaseClient, users, withBusinessTransaction } from "@lobbystack/db";

const url = process.env.LMC_TEST_DATABASE_URL ?? process.env.LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL;
if (!url) throw new Error("Set LMC_TEST_DATABASE_URL to an isolated local test database.");
const target = new URL(url);
if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) || !/test/i.test(target.pathname)) throw new Error("LMC tests require an isolated local test database.");
for (const key of ["LOBBYSTACK_APP_DATABASE_URL", "LOBBYSTACK_WORKER_DATABASE_URL", "LOBBYSTACK_DISPATCHER_DATABASE_URL"]) {
  if (!process.env[key]) throw new Error(`${key} is required; no privileged runtime fallback is permitted.`);
  const roleTarget = new URL(process.env[key]!);
  if (roleTarget.hostname !== target.hostname || roleTarget.pathname !== target.pathname || roleTarget.port !== target.port) throw new Error("All runtime roles must target the same isolated test database.");
}
const admin = createDatabaseClient("lobbystack_migrator", { DATABASE_URL: url });
const app = createDatabaseClient("lobbystack_app");
const worker = createDatabaseClient("lobbystack_worker");
const dispatcher = createDatabaseClient("lobbystack_dispatcher");
const tables = ["lmc_settings", "lmc_leads", "lmc_messages", "lmc_events", "lmc_suppressions", "lmc_rate_windows", "lmc_jobs"] as const;
const tenantA = randomUUID(), tenantB = randomUUID(), userA = randomUUID();

beforeAll(async () => {
  // Fail before writing fixtures when migrations have not created every table.
  for (const table of tables) expect((await admin.db.execute(sql`select to_regclass(${`public.${table}`}) as name`)).rows[0]?.name).toBe(table);
  await admin.db.insert(businesses).values([tenantA, tenantB].map(id => ({ id, slug: `lmc-storage-${id}`, name: id, timezone: "America/New_York", businessType: "service_company" })));
  await admin.db.insert(users).values({ id: userA, email: `${userA}@example.invalid`, normalizedEmail: `${userA}@example.invalid` });
  await admin.db.insert(businessMemberships).values({ businessId: tenantA, userId: userA, role: "business_owner" });
  for (const tenant of [tenantA, tenantB]) {
    const leadId = randomUUID();
    await admin.db.execute(sql`insert into lmc_settings(tenant_id, config, capture_token_hash) values (${tenant}, ${JSON.stringify({ fixture: tenant })}::jsonb, ${randomBytes(32).toString("hex")})`);
    await admin.db.execute(sql`insert into lmc_leads(id, tenant_id, email, reply_token_hash) values (${leadId}, ${tenant}, ${`${tenant}@example.invalid`}, ${randomBytes(32).toString("hex")})`);
    await admin.db.execute(sql`insert into lmc_messages(tenant_id, lead_id, direction, kind, message_id, to_email, subject, body) values (${tenant}, ${leadId}, 'assistant', 'reply', ${`<${randomUUID()}@example.invalid>`}, ${`${tenant}@example.invalid`}, 'Secret', ${tenant})`);
    await admin.db.execute(sql`insert into lmc_events(tenant_id, lead_id, type, external_id, metadata) values (${tenant}, ${leadId}, 'fixture', ${randomUUID()}, ${JSON.stringify({ secret: tenant })}::jsonb)`);
    await admin.db.execute(sql`insert into lmc_suppressions(tenant_id, email, reason) values (${tenant}, ${`${tenant}@example.invalid`}, 'opt_out')`);
    await admin.db.execute(sql`insert into lmc_rate_windows(tenant_id, scope_key, window_start, count) values (${tenant}, 'fixture', now(), 1)`);
    await admin.db.execute(sql`insert into lmc_jobs(tenant_id, lead_id, kind, dedupe_key, payload) values (${tenant}, ${leadId}, 'send', ${randomUUID()}, ${JSON.stringify({ secret: tenant })}::jsonb)`);
  }
});

afterAll(async () => {
  await admin.db.execute(sql`delete from businesses where id in (${tenantA}, ${tenantB})`);
  await admin.db.execute(sql`delete from users where id = ${userA}`);
  await Promise.all([admin, app, worker, dispatcher].map(client => client.pool.end()));
});

describe("LMC PostgreSQL persistence boundaries", () => {
  it("enforces tenant_id NOT NULL, FORCE RLS and write policies on every new table", async () => {
    const rows = await admin.db.execute<{ name: string; enabled: boolean; forced: boolean; not_null: boolean; checked: boolean }>(sql`
      select c.relname as name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
        a.attnotnull as not_null,
        exists(select 1 from pg_policy p where p.polrelid=c.oid and p.polwithcheck is not null) as checked
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      join pg_attribute a on a.attrelid=c.oid and a.attname='tenant_id'
      where n.nspname='public' and c.relname in (${sql.join(tables.map(table => sql`${table}`), sql`, `)})
    `);
    expect(rows.rows).toHaveLength(tables.length);
    for (const row of rows.rows) expect(row, row.name).toMatchObject({ enabled: true, forced: true, not_null: true, checked: true });
  });
  it("uses restricted app/worker/dispatcher logins, never the test migrator", async () => {
    for (const client of [app, worker, dispatcher]) {
      const row = (await client.db.execute(sql`select current_user as name, rolsuper, rolbypassrls from pg_roles where rolname=current_user`)).rows[0];
      expect(row).toMatchObject({ name: client.role, rolsuper: false, rolbypassrls: false });
    }
  });
  it.each(tables)("keeps tenant B rows invisible and immutable to tenant A on %s", async (table) => {
    await withBusinessTransaction(app.db, { businessId: tenantA, userId: userA, actorType: "operator" }, async tx => {
      const identifier = sql.identifier(table);
      expect((await tx.execute(sql`select * from ${identifier}`)).rows).toHaveLength(1);
      expect((await tx.execute(sql`select * from ${identifier} where tenant_id=${tenantB}`)).rows).toEqual([]);
      expect((await tx.execute(sql`update ${identifier} set tenant_id=tenant_id where tenant_id=${tenantB} returning tenant_id`)).rows).toEqual([]);
      expect((await tx.execute(sql`delete from ${identifier} where tenant_id=${tenantB} returning tenant_id`)).rows).toEqual([]);
    });
    await withBusinessTransaction(worker.db, { businessId: tenantA, actorType: "worker" }, async tx => {
      expect((await tx.execute(sql`select * from ${sql.identifier(table)} where tenant_id=${tenantB}`)).rows).toEqual([]);
    });
  });
  it("rejects cross-tenant inserts even with an otherwise valid foreign key", async () => {
    await expect(withBusinessTransaction(app.db, { businessId: tenantA, userId: userA, actorType: "operator" }, tx => tx.execute(sql`insert into lmc_leads(tenant_id,email,reply_token_hash) values (${tenantB},'cross@example.invalid',${randomBytes(32).toString("hex")})`))).rejects.toThrow();
  });
  it("lets the dispatcher discover only queue metadata, never message payloads", async () => {
    await withBusinessTransaction(dispatcher.db, { actorType: "dispatcher" }, async tx => {
      expect((await tx.execute(sql`select tenant_id from lmc_jobs where tenant_id in (${tenantA},${tenantB})`)).rows).toHaveLength(2);
    });
    await expect(withBusinessTransaction(dispatcher.db, { actorType: "dispatcher" }, tx => tx.execute(sql`select payload from lmc_jobs`))).rejects.toThrow();
    await withBusinessTransaction(dispatcher.db, { businessId: tenantA, actorType: "dispatcher" }, async tx => {
      expect((await tx.execute(sql`select tenant_id from lmc_jobs where tenant_id=${tenantB}`)).rows).toEqual([]);
    });
  });
});

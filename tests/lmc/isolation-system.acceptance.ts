import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  businesses,
  enqueueOutbox,
  withBusinessTransaction,
} from "@lobbystack/db";
import { createBusiness } from "../../packages/domain/src/server/tenancy";
import { openLmcTestDatabase } from "./support/database";
import { readIsolationCatalog } from "./support/isolation-inventory";
import { seedIsolationFixtures } from "./support/isolation-fixtures";

it("separates internal system operations from raw app credentials and preserves business creation", async () => {
  const db = openLmcTestDatabase();
  let fixture: Awaited<ReturnType<typeof seedIsolationFixtures>> | undefined;
  let created: string | undefined;
  try {
    fixture = await seedIsolationFixtures(
      db,
      (await readIsolationCatalog(db)).tables,
    );
    expect(fixture.failures).toEqual([]);
    const role = await withBusinessTransaction(
      db.app.db,
      {
        userId: fixture.a.userId,
        businessId: fixture.a.tenantId,
        actorType: "system",
      },
      (tx) => tx.execute<{ name: string }>(sql`select current_user as name`),
    );
    expect(role.rows[0]?.name).toBe("lobbystack_system");
    const client = await db.app.pool.connect();
    try {
      await client.query("begin");
      await expect(
        client.query("set local role lobbystack_system"),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await client.query("rollback");
      client.release();
    }
    const result = await createBusiness(
      { db: db.app.db },
      {
        userId: fixture.a.userId,
        name: "Audit onboarding",
        timezone: "UTC",
        businessType: "service_company",
      },
    );
    created = result.businessId;
    const visible = await withBusinessTransaction(
      db.app.db,
      { userId: fixture.a.userId, businessId: created, actorType: "operator" },
      (tx) =>
        tx
          .select({ id: businesses.id })
          .from(businesses)
          .where(eq(businesses.id, created!)),
    );
    expect(visible).toEqual([{ id: created }]);
  } finally {
    if (created)
      await db.admin.db.delete(businesses).where(eq(businesses.id, created));
    await fixture?.cleanup();
    await db.close();
  }
});

it("preserves global auth-email outbox deduplication and atomic rollback with the separate internal login", async () => {
  const db = openLmcTestDatabase();
  const dedupeKey = `audit-auth:${randomUUID()}`;
  const rollback = new Error("rollback synthetic auth outbox");
  try {
    await expect(
      withBusinessTransaction(
        db.app.db,
        { actorType: "system" },
        async (tx) => {
          const input = {
            topic: "email.send",
            aggregateType: "auth_email",
            aggregateId: randomUUID(),
            dedupeKey,
            payload: {
              to: "audit@example.invalid",
              template: "verify_email",
              variables: { code: "synthetic-only" },
            },
            availableAt: new Date("2099-01-01T00:00:00Z"),
          };
          const first = await enqueueOutbox(tx, input);
          expect(await enqueueOutbox(tx, input)).toBe(first);
          throw rollback;
        },
      ),
    ).rejects.toBe(rollback);
    const rows = await db.admin.pool.query(
      "select 1 from outbox_messages where dedupe_key=$1",
      [dedupeKey],
    );
    expect(rows.rowCount).toBe(0);
  } finally {
    await db.close();
  }
});

import { expect, it } from "vitest";
import { refreshBusinessSnapshot } from "@lobbystack/domain";
import { openLmcTestDatabase } from "./support/database";
import { createLmcHarness } from "./support/harness";

it("removes the email fixture's actual outbox rows before deleting its business parent", async () => {
  const db = openLmcTestDatabase(),
    h = await createLmcHarness({ now: "2030-01-09T03:40:00.000Z" });
  let closed = false,
    ids: string[] = [];
  try {
    await refreshBusinessSnapshot(
      { db: h.workerDatabase },
      { businessId: h.tenantId },
    );
    ids = (
      await db.admin.pool.query<{ id: string }>(
        "select id from outbox_messages where business_id=$1",
        [h.tenantId],
      )
    ).rows.map((row) => row.id);
    expect(ids.length).toBeGreaterThan(0);
    await h.close();
    closed = true;
    expect(
      (
        await db.admin.pool.query(
          "select id from outbox_messages where id=any($1::uuid[])",
          [ids],
        )
      ).rows,
    ).toEqual([]);
  } finally {
    if (!closed) await h.close();
    if (ids.length)
      await db.admin.pool.query(
        "delete from outbox_messages where id=any($1::uuid[])",
        [ids],
      );
    await db.close();
  }
});

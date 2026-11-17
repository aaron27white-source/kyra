import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { openLmcTestDatabase } from "./support/database";
import { withHttpAudit } from "./support/isolation-http";

it("removes late committed fixture outbox work when an HTTP audit fails during teardown", async () => {
  const db = openLmcTestDatabase(),
    writer = await db.admin.pool.connect();
  const jobId = randomUUID(),
    sentinel = new Error("deliberate audit fixture failure");
  let task: Promise<void> | undefined, tenant: string | undefined;
  try {
    await expect(
      withHttpAudit(
        process.env.LMC_TEST_HTTP_BASE_URL ?? "http://localhost:3000",
        async ({ a }) => {
          tenant = a.tenantId;
          await writer.query("begin");
          await writer.query(
            "select id from businesses where id=$1 for key share",
            [tenant],
          );
          const pid = (
            await writer.query<{ id: number }>("select pg_backend_pid() as id")
          ).rows[0]!.id;
          // This writer commits only once cleanup is actually blocked on its parent lock.
          task = (async () => {
            try {
              let blocked = false;
              for (let attempt = 0; attempt < 250; attempt += 1) {
                const row = await db.admin.pool.query<{ blocked: boolean }>(
                  "select exists(select 1 from pg_stat_activity where $1::int=any(pg_blocking_pids(pid))) as blocked",
                  [pid],
                );
                if (row.rows[0]?.blocked) {
                  blocked = true;
                  break;
                }
                await new Promise((resolve) => setTimeout(resolve, 20));
              }
              if (!blocked)
                throw new Error("FIXTURE_CLEANUP_LOCK_NOT_OBSERVED");
              await writer.query(
                "insert into outbox_messages (id,business_id,topic,aggregate_type,dedupe_key,payload,available_at) values ($1,$2,'audit.fixture','audit',$3,'{}'::jsonb,'2099-01-01'::timestamptz)",
                [jobId, tenant, `audit:${jobId}`],
              );
              await writer.query("commit");
            } finally {
              await writer.query("rollback");
            }
          })();
          throw sentinel;
        },
      ),
    ).rejects.toBe(sentinel);
    await task;
    const remaining = await db.admin.pool.query(
      "select 1 from outbox_messages where id=$1",
      [jobId],
    );
    const business = await db.admin.pool.query(
      "select 1 from businesses where id=$1",
      [tenant],
    );
    expect(remaining.rowCount).toBe(0);
    expect(business.rowCount).toBe(0);
  } finally {
    await task?.catch(() => undefined);
    await writer.query("rollback");
    writer.release();
    await db.admin.pool.query("delete from outbox_messages where id=$1", [
      jobId,
    ]);
    await db.close();
  }
}, 120_000);

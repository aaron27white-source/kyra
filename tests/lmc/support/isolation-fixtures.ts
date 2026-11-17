import { randomBytes, randomUUID } from "node:crypto";
import type { openLmcTestDatabase } from "./database";
import type { AuditColumn, AuditTable } from "./isolation-inventory";

export type FixtureRow = Record<string, unknown>;
export type FixtureTenant = {
  tenantId: string;
  userId: string;
  tag: string;
  rows: Map<string, FixtureRow>;
};
export const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
const owner = new Set([
  "business_id",
  "tenant_id",
  "referred_business_id",
  "reference_id",
]);
function context(): FixtureTenant {
  return {
    tenantId: randomUUID(),
    userId: randomUUID(),
    tag: randomUUID(),
    rows: new Map(),
  };
}

function valueFor(
  table: AuditTable,
  column: AuditColumn,
  tenant: FixtureTenant,
): unknown {
  const name = column.name;
  if (owner.has(name)) return tenant.tenantId;
  if (name.endsWith("user_id")) return tenant.userId;
  if (name === "id" && table.name === "businesses") return tenant.tenantId;
  if (name === "id" && table.name === "users") return tenant.userId;
  if (name === "role")
    return table.name === "business_memberships" ? "business_owner" : "viewer";
  if (name === "timezone") return "UTC";
  if (name === "country_code") return "US";
  if (name === "currency") return "usd";
  if (name === "day_of_week") return 1;
  if (name === "open_minutes") return 540;
  if (name === "close_minutes") return 1020;
  if (
    name.includes("token_hash") ||
    name === "key_hash" ||
    name === "request_fingerprint"
  )
    return randomBytes(32).toString("hex");
  if (/email$/.test(name) || name === "normalized_email")
    return `${tenant.tag}@example.invalid`;
  if (/phone|e164/.test(name))
    return `+1500555${(parseInt(tenant.tag.slice(0, 6), 16) % 1_000_000).toString().padStart(6, "0")}`;
  if (table.name === "affiliate_payout_runs" && name === "period_key")
    return `a-${BigInt(`0x${tenant.tag.replaceAll("-", "").slice(0, 16)}`).toString(36)}`;
  if (/period_key|month_key/.test(name))
    return `${5000 + (parseInt(tenant.tag.slice(0, 4), 16) % 4000)}-01`;
  if (name === "channel" || name === "source_channel") return "sms";
  if (name === "source_type") return "upload";
  if (name === "transfer_mode") return "never";
  if (name === "purpose") return "call_recording";
  if (column.enumValues.length) return column.enumValues[0];
  // CHECK enum literals are catalog data, not guessed application values.
  const check = table.checks.find(
    (check) =>
      check.expression.includes(`(${name})`) &&
      check.expression.includes("ANY") &&
      check.expression.includes("ARRAY["),
  );
  const literal = check?.expression.match(/ARRAY\['((?:[^']|'')*)'/)?.[1];
  if (literal !== undefined) return literal.replace(/''/g, "'");
  if (column.type === "uuid") return randomUUID();
  if (column.type === "boolean") return false;
  if (
    /^(smallint|integer|bigint|numeric|real|double precision)/.test(column.type)
  )
    return 1;
  if (/^timestamp|^date$/.test(column.type))
    return new Date(
      name === "ends_at" ? "2030-01-14T15:00:00Z" : "2030-01-14T14:00:00Z",
    );
  if (column.type.endsWith("[]")) return [];
  if (column.type === "jsonb" || column.type === "json") return {};
  if (column.type === "bytea") return randomBytes(32);
  if (/^(text|character varying|character)/.test(column.type)) {
    const max = Number(column.type.match(/\((\d+)\)/)?.[1] ?? 200);
    return `audit-${tenant.tag}-${table.name}-${name}`.slice(0, max);
  }
  throw new Error(`UNSUPPORTED_FIXTURE_TYPE:${table.name}:${name}`);
}

function initialFixtureValues(
  table: AuditTable,
  tenant: FixtureTenant,
): FixtureRow {
  const values: FixtureRow = {};
  for (const column of table.columns) {
    if (column.generated || column.identity) continue;
    const scoped =
      owner.has(column.name) ||
      column.name.endsWith("user_id") ||
      ((table.name === "users" || table.name === "businesses") &&
        column.name === "id");
    if (!scoped && (column.default !== null || column.nullable)) continue;
    values[column.name] = valueFor(table, column, tenant);
  }
  return values;
}

export function fixtureDependencies(table: AuditTable): string[] {
  const values = initialFixtureValues(table, context());
  return table.foreignKeys
    .filter(
      (key) =>
        key.columns.every((name) => owner.has(name)) ||
        key.columns.some(
          (name) => !owner.has(name) && values[name] !== undefined,
        ),
    )
    .map((key) => key.target);
}

export function buildIsolationRow(table: AuditTable, tenant: FixtureTenant) {
  const values = initialFixtureValues(table, tenant);
  let dependency: string | undefined;
  for (const key of table.foreignKeys) {
    const needed =
      key.columns.every((name) => owner.has(name)) ||
      key.columns.some(
        (name) => !owner.has(name) && values[name] !== undefined,
      );
    if (!needed) continue;
    const target = tenant.rows.get(key.target);
    if (!target) {
      dependency = key.target;
      break;
    }
    for (const [index, name] of key.columns.entries())
      values[name] = target[key.targetColumns[index]!];
  }
  if (dependency) throw new Error(`DEPENDENCY:${dependency}`);
  // Keep durable queues dormant; these rows are storage probes, not delivery work.
  const terminal: Record<string, string> = {
    lmc_jobs: "done",
    notifications: "sent",
    operator_notification_deliveries: "sent",
    website_ingestion_jobs: "completed",
    prospect_demos: "revoked",
    onboarding_phone_verifications: "canceled",
    onboarding_number_claim_events: "released",
    missed_calls: "handled",
  };
  if (terminal[table.name]) values.status = terminal[table.name];
  if (table.name === "lmc_settings") values.enabled = false;
  if (table.name === "outbox_messages") values.published_at = new Date();
  return values;
}

/** Seeds only synthetic rows in the explicitly guarded local test DB. Never disables constraints or RLS. */
export async function seedIsolationFixtures(
  db: ReturnType<typeof openLmcTestDatabase>,
  tables: AuditTable[],
) {
  const a = context(),
    b = context(),
    failures: string[] = [];
  const inserted: { table: AuditTable; row: FixtureRow }[] = [];
  const client = await db.admin.pool.connect();
  await client.query("begin");
  try {
    for (const tenant of [a, b]) {
      let pending = [...tables];
      const errors = new Map<string, string>();
      while (pending.length) {
        let progress = false;
        const next: AuditTable[] = [];
        for (const table of pending) {
          try {
            const values = buildIsolationRow(table, tenant);
            const columns = Object.keys(values);
            await client.query("savepoint audit_fixture");
            try {
              const result = await client.query<FixtureRow>(
                `insert into public.${quote(table.name)} (${columns.map(quote).join(",")}) values (${columns.map((_, index) => `$${index + 1}`).join(",")}) returning *`,
                columns.map((name) => values[name]),
              );
              const row = result.rows[0];
              if (!row) throw new Error("FIXTURE_INSERT_RETURNED_NO_ROW");
              tenant.rows.set(table.name, row);
              inserted.push({ table, row });
              progress = true;
              errors.delete(table.name);
              await client.query("release savepoint audit_fixture");
            } catch (error) {
              await client.query("rollback to savepoint audit_fixture");
              await client.query("release savepoint audit_fixture");
              const detail = error as { code?: string; constraint?: string };
              errors.set(
                table.name,
                `${detail.code ?? "INSERT_FAILED"}:${detail.constraint ?? "unknown"}`,
              );
              next.push(table);
            }
          } catch (error) {
            errors.set(
              table.name,
              error instanceof Error && error.message.startsWith("DEPENDENCY:")
                ? error.message
                : "FIXTURE_VALUES_UNSUPPORTED",
            );
            next.push(table);
          }
        }
        if (!progress) {
          failures.push(
            ...next.map(
              (table) =>
                `UNSEEDED_${tenant === a ? "A" : "B"}:${table.name}:${errors.get(table.name)}`,
            ),
          );
          break;
        }
        pending = next;
      }
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  return {
    a,
    b,
    failures,
    async cleanup() {
      const cleanup = await db.admin.pool.connect();
      try {
        await cleanup.query("begin");
        for (const { table, row } of [...inserted].reverse()) {
          if (!table.primaryKey.length)
            throw new Error(`MISSING_FIXTURE_PRIMARY_KEY:${table.name}`);
          await cleanup.query(
            `delete from public.${quote(table.name)} where ${table.primaryKey.map((column, index) => `${quote(column)}=$${index + 1}`).join(" and ")}`,
            table.primaryKey.map((column) => row[column]),
          );
        }
        await cleanup.query("commit");
      } catch (error) {
        await cleanup.query("rollback");
        throw error;
      } finally {
        cleanup.release();
      }
    },
  };
}

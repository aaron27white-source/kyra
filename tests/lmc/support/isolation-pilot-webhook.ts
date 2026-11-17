import { createHmac, randomUUID } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { LmcProviderEvent } from "@lobbystack/contracts";
import { loadLmcTestInboundFixture } from "../../../packages/providers/src/lmc-test-inbound-fixture";
import type { HttpAuditContext } from "./isolation-http";
import { scopedSnapshot } from "./isolation-pilot-guards";

export async function probePilotWebhookContext(context: HttpAuditContext) {
  const configuredPath = process.env.LMC_FAKE_INBOUND_FIXTURE_FILE;
  if (!configuredPath) throw new Error("PILOT_WEBHOOK_PRIVATE_FIXTURE_REQUIRED");
  const path = configuredPath;
  const registry = loadLmcTestInboundFixture(path, process.env);
  const references: string[] = [];
  const { a, b, cookieA, cookieB, base, check, probed, db } = context;
  function save() {
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ secret: registry.secret.toString("hex"), events: [...registry.events].map(([reference,event]) => ({ reference,event })) }), { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  }
  async function post(reference: string, cookie: string, foreign: typeof a, valid = true) {
    const rawBody = JSON.stringify({ reference, tenantId: foreign.tenantId, event: { tenantId: foreign.tenantId, email: { from: "override@example.invalid" } } });
    const id = `fake_${randomUUID()}`, timestamp = String(Math.floor(Date.now()/1000));
    const signature = createHmac("sha256", registry.secret).update(`${id}.${timestamp}.${rawBody}`).digest("base64");
    return fetch(new URL("/api/webhooks/lmc-email", base), { method: "POST", redirect: "error", signal: AbortSignal.timeout(15000), headers: { cookie, "content-type": "application/json", "svix-id": id, "svix-timestamp": timestamp, "svix-signature": valid ? `v1,${signature}` : "v1,invalid", "x-business-id": foreign.tenantId, "x-user-id": foreign.ownerId, "x-actor-type": "system" }, body: rawBody });
  }
  try {
    for (const [own, foreign, cookie, foreignKey] of [[a,b,cookieB,"b"],[b,a,cookieA,"a"]] as const) {
      const reference = randomUUID(), email = `${randomUUID()}@example.invalid`, token = new URL(own.captureUrl).pathname.split("/").at(-1)!;
      const event: LmcProviderEvent = { kind: "message", id: randomUUID(), email: { from: email, to: `lead+${token}@inbound.example.invalid`, subject: "Signed pilot roof inquiry", text: "Roof repair in ZIP 33101", headers: { "Message-ID": `<${randomUUID()}@example.invalid>` }, authentication: { spf: "pass", dkim: "pass", dmarc: "pass", aligned: true }, attachments: [] } };
      references.push(reference); registry.events.set(reference,event); save();
      const before = await scopedSnapshot(context);
      const forged = await post(reference,cookie,foreign,false);
      check(forged.status === 401, `PILOT_WEBHOOK_BAD_SIGNATURE:${forged.status}`);
      await forged.arrayBuffer();
      check(isDeepStrictEqual(before,await scopedSnapshot(context)), "PILOT_WEBHOOK_BAD_SIGNATURE_PERSISTED");
      const foreignBefore = await scopedSnapshot(context,foreignKey);
      const response = await post(reference,cookie,foreign);
      const result = await response.json() as { received?: boolean };
      check(response.status === 200 && result.received === true, `PILOT_WEBHOOK_SIGNED_STATUS:${response.status}`);
      async function persisted() {
        return (await db.admin.pool.query<{ id: string; tenant_id: string; messages: number; jobs: number }>("select l.id,l.tenant_id,(select count(*)::int from lmc_messages m where m.tenant_id=l.tenant_id and m.lead_id=l.id) as messages,(select count(*)::int from lmc_jobs j where j.tenant_id=l.tenant_id and j.lead_id=l.id and j.kind='process') as jobs from lmc_leads l where l.tenant_id=$1 and l.email=$2",[own.tenantId,email])).rows;
      }
      const rows = await persisted();
      check(rows.length === 1 && rows[0]?.tenant_id === own.tenantId && rows[0]?.messages === 1 && rows[0]?.jobs === 1, "PILOT_WEBHOOK_SIGNED_CANONICAL_PERSISTENCE");
      const duplicate = await post(reference,cookie,foreign);
      check(duplicate.status === 200, `PILOT_WEBHOOK_DUPLICATE:${duplicate.status}`);
      await duplicate.arrayBuffer();
      check(isDeepStrictEqual(rows,await persisted()), "PILOT_WEBHOOK_DUPLICATE_PERSISTED");
      check(isDeepStrictEqual(foreignBefore,await scopedSnapshot(context,foreignKey)), "PILOT_WEBHOOK_FOREIGN_TENANT_CHANGED");
    }
    probed.push("POST /api/webhooks/lmc-email");
  } finally {
    for(const reference of references)registry.events.delete(reference);
    save();
  }
}

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { appointments, businesses, calls, contacts, services, staff } from "@lobbystack/db";
import { renewVoicePresenceGateway } from "@lobbystack/jobs";
import { PILOT_ADMIN_ROUTES } from "@lobbystack/shared";
import type { HttpAuditContext } from "./isolation-http";

/** Exercises every voice-capable pilot API method with two isolated tenant sessions. */
export async function probePilotVoiceContext(context: HttpAuditContext) {
  const { db, a, b, cookieA, cookieB, request, check, probed } = context;
  await db.admin.db.update(businesses).set({ lmcVoiceEnabled: true, status: "active" }).where(eq(businesses.id, a.tenantId));
  await db.admin.db.update(businesses).set({ lmcVoiceEnabled: false, status: "active" }).where(eq(businesses.id, b.tenantId));

  async function options(pattern: string, path = pattern) {
    const expected = [...PILOT_ADMIN_ROUTES.find((entry) => entry.pattern === pattern)!.methods].sort();
    const response = await request(path, cookieA, a.tenantId, "OPTIONS");
    const allow = (response.headers.get("allow") ?? "").split(/[, ]+/).filter(Boolean).sort();
    check(response.status === 204 && await response.text() === "" && JSON.stringify(allow) === JSON.stringify(expected), `PILOT_VOICE_OPTIONS:${pattern}:${response.status}`);
    probed.push(`OPTIONS ${pattern}`);
  }

  async function head(pattern: string, path = pattern, expectedStatus = 200) {
    const own = await request(path, cookieA, a.tenantId, "HEAD");
    check(own.status === expectedStatus && await own.text() === "", `PILOT_VOICE_HEAD:${pattern}:${own.status}`);
    const disabled = await request(path, cookieB, b.tenantId, "HEAD");
    check(disabled.status === 404 && await disabled.text() === "", `PILOT_VOICE_HEAD_DISABLED:${pattern}:${disabled.status}`);
    probed.push(`HEAD ${pattern}`);
  }

  const agentPath = "/api/agent";
  const agentA = await request(agentPath, cookieA, a.tenantId);
  const agentText = await agentA.text();
  check(agentA.status === 200 && agentText.includes(a.tenantId) && !agentText.includes(b.tenantId), `PILOT_VOICE_AGENT_READ:${agentA.status}`);
  const agentB = await request(agentPath, cookieB, b.tenantId);
  check(agentB.status === 404, `PILOT_VOICE_AGENT_DISABLED:${agentB.status}`);
  await agentB.arrayBuffer();
  probed.push("GET /api/agent");
  await head(agentPath);
  await options(agentPath);
  const agentPatch = await request(agentPath, cookieA, a.tenantId, "PATCH", {}, { greeting: "Tenant A inbound greeting" });
  check(agentPatch.status === 200, `PILOT_VOICE_AGENT_PATCH:${agentPatch.status}`);
  await agentPatch.arrayBuffer();
  probed.push("PATCH /api/agent");

  const rulesPath = "/api/rules";
  const rulesA = await request(rulesPath, cookieA, a.tenantId);
  check(rulesA.status === 200, `PILOT_VOICE_RULES_READ:${rulesA.status}`);
  await rulesA.arrayBuffer();
  const rulesB = await request(rulesPath, cookieB, b.tenantId);
  check(rulesB.status === 404, `PILOT_VOICE_RULES_DISABLED:${rulesB.status}`);
  await rulesB.arrayBuffer();
  probed.push("GET /api/rules");
  await head(rulesPath);
  await options(rulesPath);
  const createRule = await request(rulesPath, cookieA, a.tenantId, "POST", {}, { title: "Pilot voice audit", content: "Tenant A only" });
  const ruleId = await createRule.json() as string;
  check(createRule.status === 201 && typeof ruleId === "string", `PILOT_VOICE_RULE_CREATE:${createRule.status}`);
  probed.push("POST /api/rules");
  const updateRule = await request(rulesPath, cookieA, a.tenantId, "PATCH", {}, { ruleId, title: "Pilot voice audit updated" });
  check(updateRule.status === 200, `PILOT_VOICE_RULE_UPDATE:${updateRule.status}`);
  await updateRule.arrayBuffer();
  probed.push("PATCH /api/rules");
  const deleteRule = await request(rulesPath, cookieA, a.tenantId, "DELETE", {}, { ruleId });
  check(deleteRule.status === 200, `PILOT_VOICE_RULE_DELETE:${deleteRule.status}`);
  await deleteRule.arrayBuffer();
  probed.push("DELETE /api/rules");

  const numberPath = "/api/lmc/voice/number";
  const numberA = await request(numberPath, cookieA, a.tenantId);
  const numberBody = await numberA.json() as { phoneNumber?: unknown };
  check(numberA.status === 200 && numberBody.phoneNumber === null, `PILOT_VOICE_NUMBER_READ:${numberA.status}`);
  const numberB = await request(numberPath, cookieB, b.tenantId);
  check(numberB.status === 404, `PILOT_VOICE_NUMBER_DISABLED:${numberB.status}`);
  await numberB.arrayBuffer();
  probed.push("GET /api/lmc/voice/number");
  await head(numberPath);
  await options(numberPath);

  const callAId = randomUUID();
  const callBId = randomUUID();
  const callAProviderId = `pilot-a-${randomUUID()}`;
  const callBProviderId = `pilot-b-${randomUUID()}`;
  await db.admin.db.insert(calls).values([
    { id: callAId, businessId: a.tenantId, providerCallId: callAProviderId, transport: "voice", status: "completed", startedAt: new Date(), endedAt: new Date() },
    { id: callBId, businessId: b.tenantId, providerCallId: callBProviderId, transport: "voice", status: "completed", startedAt: new Date(), endedAt: new Date() },
  ]);

  const callsPath = "/api/calls";
  const callList = await request(callsPath, cookieA, a.tenantId);
  const callListText = await callList.text();
  check(callList.status === 200 && callListText.includes(callAProviderId) && !callListText.includes(callBProviderId), `PILOT_VOICE_CALL_LIST_ISOLATION:${callList.status}`);
  const disabledCallList = await request(callsPath, cookieB, b.tenantId);
  check(disabledCallList.status === 404, `PILOT_VOICE_CALL_LIST_DISABLED:${disabledCallList.status}`);
  await disabledCallList.arrayBuffer();
  probed.push("GET /api/calls");
  await head(callsPath);
  await options(callsPath);

  const activePath = "/api/calls/active";
  // The active-call endpoint fails closed when no live gateway heartbeat exists.
  // Register a synthetic gateway in the isolated CI Redis to exercise the healthy path.
  await renewVoicePresenceGateway(`isolation-audit-${randomUUID()}`);
  const active = await request(activePath, cookieA, a.tenantId);
  check(active.status === 200, `PILOT_VOICE_CALLS_ACTIVE:${active.status}`);
  await active.arrayBuffer();
  const disabledActive = await request(activePath, cookieB, b.tenantId);
  check(disabledActive.status === 404, `PILOT_VOICE_CALLS_ACTIVE_DISABLED:${disabledActive.status}`);
  await disabledActive.arrayBuffer();
  probed.push("GET /api/calls/active");
  await head(activePath);
  await options(activePath);

  const detailPattern = "/api/calls/[callId]";
  const detailPath = `${callsPath}/${callAId}`;
  const detail = await request(detailPath, cookieA, a.tenantId);
  const detailText = await detail.text();
  check(detail.status === 200 && detailText.includes(callAProviderId), `PILOT_VOICE_CALL_DETAIL:${detail.status}`);
  const crossTenant = await request(`${callsPath}/${callBId}`, cookieA, a.tenantId);
  check(crossTenant.status === 404, `PILOT_VOICE_CALL_DETAIL_CROSS_TENANT:${crossTenant.status}`);
  await crossTenant.arrayBuffer();
  probed.push(`GET ${detailPattern}`);
  await head(detailPattern, detailPath);
  await options(detailPattern, detailPath);

  const recordingPattern = "/api/calls/[callId]/recording";
  const recordingPath = `${detailPath}/recording`;
  const recording = await request(recordingPath, cookieA, a.tenantId);
  check(recording.status === 409, `PILOT_VOICE_RECORDING_NOT_AVAILABLE:${recording.status}`);
  await recording.arrayBuffer();
  const foreignRecording = await request(`${callsPath}/${callBId}/recording`, cookieA, a.tenantId);
  check(foreignRecording.status === 404, `PILOT_VOICE_RECORDING_CROSS_TENANT:${foreignRecording.status}`);
  await foreignRecording.arrayBuffer();
  probed.push(`GET ${recordingPattern}`);
  await head(recordingPattern, recordingPath, 409);
  await options(recordingPattern, recordingPath);

  const webhookPath = "/api/webhooks/openai/live";
  const webhook = await request(webhookPath, "", "", "POST", {}, {});
  check(webhook.status === 404, `PILOT_VOICE_WEBHOOK_DISABLED:${webhook.status}`);
  await webhook.arrayBuffer();
  probed.push("POST /api/webhooks/openai/live");
  await options(webhookPath);

  // Both tenants must have the voice capability enabled so this probes data
  // isolation rather than merely observing the capability's 404 boundary.
  await db.admin.db.update(businesses).set({ lmcVoiceEnabled: true }).where(eq(businesses.id, b.tenantId));
  try {
    const [contactA] = await db.admin.db.select({ id: contacts.id }).from(contacts).where(eq(contacts.businessId, a.tenantId)).limit(1);
    const [serviceA] = await db.admin.db.select({ id: services.id }).from(services).where(eq(services.businessId, a.tenantId)).limit(1);
    const [staffA] = await db.admin.db.select({ id: staff.id }).from(staff).where(eq(staff.businessId, a.tenantId)).limit(1);
    const [contactB] = await db.admin.db.select({ id: contacts.id }).from(contacts).where(eq(contacts.businessId, b.tenantId)).limit(1);
    const [serviceB] = await db.admin.db.select({ id: services.id }).from(services).where(eq(services.businessId, b.tenantId)).limit(1);
    const [staffB] = await db.admin.db.select({ id: staff.id }).from(staff).where(eq(staff.businessId, b.tenantId)).limit(1);
    check(Boolean(contactA?.id && serviceA?.id && staffA?.id && contactB?.id && serviceB?.id && staffB?.id), "PILOT_VOICE_APPOINTMENT_FIXTURE_DEPENDENCY_MISSING");
    const appointmentStartsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const appointmentEndsAt = new Date(appointmentStartsAt.getTime() + 60 * 60 * 1000);
    const appointmentIds = [randomUUID(), randomUUID()];
    if (contactA?.id && serviceA?.id && staffA?.id && contactB?.id && serviceB?.id && staffB?.id) {
      await db.admin.db.insert(appointments).values([
        { id: appointmentIds[0], businessId: a.tenantId, contactId: contactA.id, serviceId: serviceA.id, staffId: staffA.id, startsAt: appointmentStartsAt, endsAt: appointmentEndsAt, timezone: "UTC", status: "confirmed", sourceChannel: "voice" },
        { id: appointmentIds[1], businessId: b.tenantId, contactId: contactB.id, serviceId: serviceB.id, staffId: staffB.id, startsAt: appointmentStartsAt, endsAt: appointmentEndsAt, timezone: "UTC", status: "confirmed", sourceChannel: "voice" },
      ]);
    }
    const appointmentA = { id: appointmentIds[0]! };
    const appointmentB = { id: appointmentIds[1]! };
    if (appointmentA?.id && appointmentB?.id) {
      const [listAResponse, listBResponse] = await Promise.all([
        request("/api/appointments", cookieA, a.tenantId),
        request("/api/appointments", cookieB, b.tenantId),
      ]);
      const [listA, listB] = await Promise.all([
        listAResponse.json() as Promise<{ appointments?: Array<{ id: string }> }>,
        listBResponse.json() as Promise<{ appointments?: Array<{ id: string }> }>,
      ]);
      check(listAResponse.status === 200 && listA.appointments?.some((item) => item.id === appointmentA.id) && !listA.appointments?.some((item) => item.id === appointmentB.id), `PILOT_VOICE_APPOINTMENT_LIST_A:${listAResponse.status}`);
      check(listBResponse.status === 200 && listB.appointments?.some((item) => item.id === appointmentB.id) && !listB.appointments?.some((item) => item.id === appointmentA.id), `PILOT_VOICE_APPOINTMENT_LIST_B:${listBResponse.status}`);
      probed.push("GET /api/appointments");
      const [headA, headB] = await Promise.all([
        request("/api/appointments", cookieA, a.tenantId, "HEAD"),
        request("/api/appointments", cookieB, b.tenantId, "HEAD"),
      ]);
      check(headA.status === 200 && await headA.text() === "", `PILOT_VOICE_APPOINTMENT_HEAD_A:${headA.status}`);
      check(headB.status === 200 && await headB.text() === "", `PILOT_VOICE_APPOINTMENT_HEAD_B:${headB.status}`);
      probed.push("HEAD /api/appointments");
      await options("/api/appointments");

      const appointmentPath = `/api/appointments/${appointmentA.id}`;
      const foreignUpdate = await request(appointmentPath, cookieB, b.tenantId, "PATCH", {}, { serviceLocation: { line1: "12 Main Street", city: "Austin", postalCode: "78701", country: "US" } });
      check(foreignUpdate.status === 404, `PILOT_VOICE_APPOINTMENT_CROSS_TENANT:${foreignUpdate.status}`);
      await foreignUpdate.arrayBuffer();
      const ownUpdate = await request(appointmentPath, cookieA, a.tenantId, "PATCH", {}, { serviceLocation: { line1: "12 Main Street", city: "Austin", postalCode: "78701", country: "US" } });
      check(ownUpdate.status === 200, `PILOT_VOICE_APPOINTMENT_LOCATION_UPDATE:${ownUpdate.status}`);
      await ownUpdate.arrayBuffer();
      probed.push("PATCH /api/appointments/[appointmentId]");
      await options("/api/appointments/[appointmentId]", appointmentPath);
    }
  } finally {
    await db.admin.db.update(businesses).set({ lmcVoiceEnabled: false }).where(eq(businesses.id, b.tenantId));
  }
}

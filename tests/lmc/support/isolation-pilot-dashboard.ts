import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { businesses, contacts, receptionistProfiles, users } from "@lobbystack/db";
import { PILOT_ADMIN_ROUTES } from "@lobbystack/shared";
import type { HttpAuditContext } from "./isolation-http";

function policyMethods(path: string) {
  const policy = PILOT_ADMIN_ROUTES.find((entry) => entry.pattern === path);
  if (!policy) throw new Error(`PILOT_DASHBOARD_POLICY_MISSING:${path}`);
  return [...policy.methods].sort();
}
/**
 * Exercises every capability-gated dashboard method through the real pilot
 * proxy and authenticated HTTP stack. Mutations are made only against tenant
 * A while tenant B is used as the isolation control.
 */
export async function probePilotDashboardContext(context: HttpAuditContext) {
  const { db, a, b, cookieA, cookieB, request, check, probed } = context;

  await db.admin.db.update(users).set({ activeBusinessId: a.tenantId }).where(eq(users.id, a.ownerId));
  await db.admin.db.update(users).set({ activeBusinessId: b.tenantId }).where(eq(users.id, b.ownerId));
  await db.admin.db.update(businesses).set({ status: "active" }).where(eq(businesses.id, a.tenantId));
  await db.admin.db.update(businesses).set({ status: "active" }).where(eq(businesses.id, b.tenantId));

  async function options(pattern: string, path = pattern) {
    const expected = policyMethods(pattern);
    for (const [cookie, tenant] of [["", b.tenantId], [cookieA, a.tenantId]] as const) {
      const response = await request(path, cookie, tenant, "OPTIONS");
      const allow = (response.headers.get("allow") ?? "").split(/[, ]+/).filter(Boolean).sort();
      check(response.status === 204 && (await response.text()) === "" && JSON.stringify(allow) === JSON.stringify(expected) && !response.headers.has("set-cookie"), `PILOT_DASHBOARD_OPTIONS:${pattern}:${response.status}`);
    }
    probed.push(`OPTIONS ${pattern}`);
  }

  async function head(pattern: string, path = pattern) {
    const response = await request(path, cookieA, a.tenantId, "HEAD");
    check(response.status === 200 && (await response.text()) === "", `PILOT_DASHBOARD_HEAD:${pattern}:${response.status}`);
    const foreign = await request(path, cookieA, b.tenantId, "HEAD");
    check(foreign.status === 404 && (await foreign.text()) === "", `PILOT_DASHBOARD_HEAD_FOREIGN:${pattern}:${foreign.status}`);
    probed.push(`HEAD ${pattern}`);
  }

  const beforeB = await db.admin.pool.query<{ name: string }>("select name from businesses where id=$1", [b.tenantId]);
  const profile = await request("/api/businesses", cookieA, a.tenantId, "PATCH", {}, { name: "Tenant A capability profile" });
  check(profile.status === 200, `PILOT_DASHBOARD_PROFILE_PATCH:${profile.status}`);
  await profile.arrayBuffer();
  const afterB = await db.admin.pool.query<{ name: string }>("select name from businesses where id=$1", [b.tenantId]);
  check(beforeB.rows[0]?.name === afterB.rows[0]?.name, "PILOT_DASHBOARD_PROFILE_CHANGED_TENANT_B");
  probed.push("PATCH /api/businesses");

  const catalogA = await request("/api/catalog", cookieA, a.tenantId);
  const catalogAText = await catalogA.text();
  const catalogB = await request("/api/catalog", cookieB, b.tenantId);
  const catalogBText = await catalogB.text();
  check(catalogA.status === 200 && catalogB.status === 200 && catalogAText.includes(a.tenantId) && !catalogAText.includes(b.tenantId) && catalogBText.includes(b.tenantId) && !catalogBText.includes(a.tenantId), "PILOT_DASHBOARD_CATALOG_ISOLATION");
  probed.push("GET /api/catalog");
  await head("/api/catalog");
  await options("/api/catalog");

  const intakePolicy = { serviceType: "onsite", fields: { serviceAddress: "required" } } as const;
  const profileBeforeB = await db.admin.db.select({ intakePolicy: receptionistProfiles.intakePolicy }).from(receptionistProfiles).where(eq(receptionistProfiles.businessId, b.tenantId)).limit(1);
  const businessIntakeUpdate = await request("/api/catalog", cookieA, a.tenantId, "PATCH", {}, { intakePolicy });
  check(businessIntakeUpdate.status === 200, `PILOT_DASHBOARD_INTAKE_POLICY_PATCH:${businessIntakeUpdate.status}`);
  await businessIntakeUpdate.arrayBuffer();
  const [profileAfterA, profileAfterB] = await Promise.all([
    db.admin.db.select({ intakePolicy: receptionistProfiles.intakePolicy }).from(receptionistProfiles).where(eq(receptionistProfiles.businessId, a.tenantId)).limit(1),
    db.admin.db.select({ intakePolicy: receptionistProfiles.intakePolicy }).from(receptionistProfiles).where(eq(receptionistProfiles.businessId, b.tenantId)).limit(1),
  ]);
  const savedPolicy = profileAfterA[0]?.intakePolicy as { serviceType?: unknown; fields?: { serviceAddress?: unknown } } | null | undefined;
  check(savedPolicy?.serviceType === intakePolicy.serviceType && savedPolicy.fields?.serviceAddress === intakePolicy.fields.serviceAddress, "PILOT_DASHBOARD_INTAKE_POLICY_NOT_PERSISTED");
  check(JSON.stringify(profileAfterB[0]?.intakePolicy ?? null) === JSON.stringify(profileBeforeB[0]?.intakePolicy ?? null), "PILOT_DASHBOARD_INTAKE_POLICY_CHANGED_TENANT_B");
  probed.push("PATCH /api/catalog");

  const serviceCreate = await request("/api/catalog", cookieA, a.tenantId, "POST", {}, { name: "Audit service", slug: `audit-${randomUUID()}`, durationMinutes: 45 });
  const servicePayload = await serviceCreate.json() as { serviceId?: string };
  check(serviceCreate.status === 201 && typeof servicePayload.serviceId === "string", `PILOT_DASHBOARD_SERVICE_CREATE:${serviceCreate.status}`);
  probed.push("POST /api/catalog");
  if (!servicePayload.serviceId) throw new Error("PILOT_DASHBOARD_SERVICE_ID_MISSING");
  const servicePath = `/api/catalog/${servicePayload.serviceId}`;
  const foreignService = await request(servicePath, cookieB, b.tenantId, "PATCH", {}, { name: "foreign" });
  check(foreignService.status === 404, `PILOT_DASHBOARD_SERVICE_FOREIGN:${foreignService.status}`);
  await foreignService.arrayBuffer();
  const servicePatch = await request(servicePath, cookieA, a.tenantId, "PATCH", {}, { name: "Audit service updated" });
  check(servicePatch.status === 200, `PILOT_DASHBOARD_SERVICE_PATCH:${servicePatch.status}`);
  await servicePatch.arrayBuffer();
  probed.push("PATCH /api/catalog/[serviceId]");
  await options("/api/catalog/[serviceId]", servicePath);

  const hoursA = await request("/api/business-hours", cookieA, a.tenantId);
  const hoursB = await request("/api/business-hours", cookieB, b.tenantId);
  const hoursBText = await hoursB.text();
  check(hoursA.status === 200 && hoursB.status === 200, "PILOT_DASHBOARD_HOURS_READ");
  await hoursA.arrayBuffer();
  probed.push("GET /api/business-hours");
  await head("/api/business-hours");
  await options("/api/business-hours");
  const hoursWrite = await request("/api/business-hours", cookieA, a.tenantId, "PUT", {}, { hours: [{ dayOfWeek: 1, openMinutes: 480, closeMinutes: 960 }] });
  check(hoursWrite.status === 200, `PILOT_DASHBOARD_HOURS_WRITE:${hoursWrite.status}`);
  await hoursWrite.arrayBuffer();
  const hoursBAfter = await request("/api/business-hours", cookieB, b.tenantId);
  check(hoursBAfter.status === 200 && await hoursBAfter.text() === hoursBText, "PILOT_DASHBOARD_HOURS_CHANGED_TENANT_B");
  probed.push("PUT /api/business-hours");

  const knowledgeA = await request("/api/knowledge", cookieA, a.tenantId);
  const knowledgeAText = await knowledgeA.text();
  const knowledgeB = await request("/api/knowledge", cookieB, b.tenantId);
  const knowledgeBText = await knowledgeB.text();
  check(knowledgeA.status === 200 && knowledgeB.status === 200 && !knowledgeAText.includes(b.tenantId) && !knowledgeBText.includes(a.tenantId), "PILOT_DASHBOARD_KNOWLEDGE_ISOLATION");
  probed.push("GET /api/knowledge");
  await head("/api/knowledge");
  await options("/api/knowledge");
  const documentCreate = await request("/api/knowledge", cookieA, a.tenantId, "POST", {}, {
    title: "Audit document",
    sourceType: "website",
    sourceUrl: `https://${randomUUID()}.example.invalid/help`,
  });
  const documentPayload = await documentCreate.json() as { documentId?: string };
  check(documentCreate.status === 201 && typeof documentPayload.documentId === "string", `PILOT_DASHBOARD_DOCUMENT_CREATE:${documentCreate.status}`);
  probed.push("POST /api/knowledge");
  if (!documentPayload.documentId) throw new Error("PILOT_DASHBOARD_DOCUMENT_ID_MISSING");
  const documentPath = `/api/knowledge/${documentPayload.documentId}`;
  for (const method of ["GET", "HEAD"] as const) {
    const own = await request(documentPath, cookieA, a.tenantId, method);
    check(own.status === 200 && (method !== "HEAD" || await own.text() === ""), `PILOT_DASHBOARD_DOCUMENT_${method}:${own.status}`);
    if (method === "GET") await own.arrayBuffer();
    const foreign = await request(documentPath, cookieB, b.tenantId, method);
    check(foreign.status === 404, `PILOT_DASHBOARD_DOCUMENT_FOREIGN_${method}:${foreign.status}`);
    await foreign.arrayBuffer();
    probed.push(`${method} /api/knowledge/[documentId]`);
  }
  await options("/api/knowledge/[documentId]", documentPath);
  const documentPatch = await request(documentPath, cookieA, a.tenantId, "PATCH", {}, { active: false });
  check(documentPatch.status === 200, `PILOT_DASHBOARD_DOCUMENT_PATCH:${documentPatch.status}`);
  await documentPatch.arrayBuffer();
  probed.push("PATCH /api/knowledge/[documentId]");

  const snippetsA = await request("/api/knowledge/snippets", cookieA, a.tenantId);
  const snippetsAText = await snippetsA.text();
  const snippetsB = await request("/api/knowledge/snippets", cookieB, b.tenantId);
  const snippetsBText = await snippetsB.text();
  check(snippetsA.status === 200 && snippetsB.status === 200 && !snippetsAText.includes(b.tenantId) && !snippetsBText.includes(a.tenantId), "PILOT_DASHBOARD_SNIPPETS_ISOLATION");
  probed.push("GET /api/knowledge/snippets");
  await head("/api/knowledge/snippets");
  await options("/api/knowledge/snippets");
  const snippetCreate = await request("/api/knowledge/snippets", cookieA, a.tenantId, "POST", {}, { title: "Audit snippet", content: "Tenant A only" });
  const snippetPayload = await snippetCreate.json() as { snippetId?: string };
  check(snippetCreate.status === 201 && typeof snippetPayload.snippetId === "string", `PILOT_DASHBOARD_SNIPPET_CREATE:${snippetCreate.status}`);
  probed.push("POST /api/knowledge/snippets");
  if (!snippetPayload.snippetId) throw new Error("PILOT_DASHBOARD_SNIPPET_ID_MISSING");
  const snippetPath = `/api/knowledge/snippets/${snippetPayload.snippetId}`;
  const snippetPatch = await request(snippetPath, cookieA, a.tenantId, "PATCH", {}, { content: "Tenant A updated" });
  check(snippetPatch.status === 200, `PILOT_DASHBOARD_SNIPPET_PATCH:${snippetPatch.status}`);
  await snippetPatch.arrayBuffer();
  const foreignSnippet = await request(snippetPath, cookieB, b.tenantId, "PATCH", {}, { content: "foreign" });
  check(foreignSnippet.status === 404, `PILOT_DASHBOARD_SNIPPET_FOREIGN:${foreignSnippet.status}`);
  await foreignSnippet.arrayBuffer();
  probed.push("PATCH /api/knowledge/snippets/[snippetId]");
  await options("/api/knowledge/snippets/[snippetId]", snippetPath);

  const uploadCreate = await request("/api/uploads", cookieA, a.tenantId, "POST", {}, { businessId: b.tenantId, purpose: "knowledge", fileName: "foreign.pdf", contentType: "application/pdf", length: 1, checksum: "audit" });
  check(uploadCreate.status === 400, `PILOT_DASHBOARD_UPLOAD_CREATE_FOREIGN:${uploadCreate.status}`);
  await uploadCreate.arrayBuffer();
  probed.push("POST /api/uploads");
  const uploadFinalize = await request("/api/uploads", cookieA, a.tenantId, "PUT", {}, { businessId: b.tenantId, objectId: randomUUID(), length: 1, checksum: "audit", contentType: "application/pdf" });
  check(uploadFinalize.status === 400, `PILOT_DASHBOARD_UPLOAD_FINALIZE_FOREIGN:${uploadFinalize.status}`);
  await uploadFinalize.arrayBuffer();
  probed.push("PUT /api/uploads");
  await options("/api/uploads");

  const contactAId = randomUUID();
  const contactBId = randomUUID();
  await db.admin.db.insert(contacts).values([
    { id: contactAId, businessId: a.tenantId, email: "dashboard-a@example.invalid" },
    { id: contactBId, businessId: b.tenantId, email: "dashboard-b@example.invalid" },
  ]);
  const contactsA = await request("/api/contacts", cookieA, a.tenantId);
  const contactsAText = await contactsA.text();
  const contactsB = await request("/api/contacts", cookieB, b.tenantId);
  const contactsBText = await contactsB.text();
  check(contactsA.status === 200 && contactsB.status === 200 && contactsAText.includes(contactAId) && !contactsAText.includes(contactBId) && contactsBText.includes(contactBId) && !contactsBText.includes(contactAId), "PILOT_DASHBOARD_CONTACTS_ISOLATION");
  probed.push("GET /api/contacts");
  await head("/api/contacts");
  await options("/api/contacts");
  const contactPath = `/api/contacts/${contactAId}`;
  for (const method of ["GET", "HEAD"] as const) {
    const own = await request(contactPath, cookieA, a.tenantId, method);
    check(own.status === 200 && (method !== "HEAD" || await own.text() === ""), `PILOT_DASHBOARD_CONTACT_${method}:${own.status}`);
    if (method === "GET") await own.arrayBuffer();
    const foreign = await request(contactPath, cookieB, b.tenantId, method);
    check(foreign.status === 404, `PILOT_DASHBOARD_CONTACT_FOREIGN_${method}:${foreign.status}`);
    await foreign.arrayBuffer();
    probed.push(`${method} /api/contacts/[contactId]`);
  }
  await options("/api/contacts/[contactId]", contactPath);
  const contactPatch = await request(contactPath, cookieA, a.tenantId, "PATCH", {}, { smsBlocked: true });
  check(contactPatch.status === 200, `PILOT_DASHBOARD_CONTACT_PATCH:${contactPatch.status}`);
  await contactPatch.arrayBuffer();
  probed.push("PATCH /api/contacts/[contactId]");

  const contactDelete = await request(contactPath, cookieA, a.tenantId, "DELETE", {}, {});
  check(contactDelete.status === 200, `PILOT_DASHBOARD_CONTACT_DELETE:${contactDelete.status}`);
  await contactDelete.arrayBuffer();
  probed.push("DELETE /api/contacts/[contactId]");
  const snippetDelete = await request(snippetPath, cookieA, a.tenantId, "DELETE", {}, {});
  check(snippetDelete.status === 200, `PILOT_DASHBOARD_SNIPPET_DELETE:${snippetDelete.status}`);
  await snippetDelete.arrayBuffer();
  probed.push("DELETE /api/knowledge/snippets/[snippetId]");
  const documentDelete = await request(documentPath, cookieA, a.tenantId, "DELETE", {}, {});
  check(documentDelete.status === 200, `PILOT_DASHBOARD_DOCUMENT_DELETE:${documentDelete.status}`);
  await documentDelete.arrayBuffer();
  probed.push("DELETE /api/knowledge/[documentId]");
  const serviceDelete = await request(servicePath, cookieA, a.tenantId, "DELETE", {}, {});
  check(serviceDelete.status === 200, `PILOT_DASHBOARD_SERVICE_DELETE:${serviceDelete.status}`);
  await serviceDelete.arrayBuffer();
  probed.push("DELETE /api/catalog/[serviceId]");

  const forgedCatalog = await request(`/api/catalog?businessId=${b.tenantId}`, cookieA, b.tenantId);
  check(forgedCatalog.status === 404, `PILOT_DASHBOARD_FORGED_ACTIVE_TENANT:${forgedCatalog.status}`);
  await forgedCatalog.arrayBuffer();

  await db.admin.db.update(businesses).set({ status: "draft" }).where(eq(businesses.id, a.tenantId));
  const draftContacts = await request("/api/contacts", cookieA, a.tenantId);
  check(draftContacts.status === 404, `PILOT_DASHBOARD_DRAFT_CONTACTS:${draftContacts.status}`);
  await draftContacts.arrayBuffer();
  const draftCatalog = await request("/api/catalog", cookieA, a.tenantId);
  check(draftCatalog.status === 200, `PILOT_DASHBOARD_DRAFT_CONFIGURATION:${draftCatalog.status}`);
  await draftCatalog.arrayBuffer();
  await db.admin.db.update(businesses).set({ status: "active" }).where(eq(businesses.id, a.tenantId));
}

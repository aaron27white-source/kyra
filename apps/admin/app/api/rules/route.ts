import { NextResponse } from "next/server";
import { z } from "zod";

import { createAgentRule, deleteAgentRule, listAgentRules, refreshBusinessSnapshot, reorderAgentRules, updateAgentRule } from "@lobbystack/domain";
import { asApiResponse, readJson, withOperatorTransaction } from "@/lib/api-helpers";
import { createDomainContext, createWorkerDomainContext } from "@/lib/domain-context";

const createSchema = z.object({ title: z.string().trim().min(1).max(160), content: z.string().trim().min(1).max(10_000), active: z.boolean().optional() });
const updateSchema = z.object({ ruleId: z.string().uuid(), title: z.string().trim().min(1).max(160).optional(), content: z.string().trim().min(1).max(10_000).optional(), active: z.boolean().optional() });
const reorderSchema = z.object({ ruleIds: z.array(z.string().uuid()).max(100) });
const deleteSchema = z.object({ ruleId: z.string().uuid() });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function refreshRulesSnapshot(businessId: string): Promise<void> {
  try {
    await refreshBusinessSnapshot(createWorkerDomainContext(), { businessId });
  } catch {
    // A durable snapshot.refresh job was queued with the rule mutation.
    // Keep the previous published snapshot available until the retry succeeds.
    console.error(JSON.stringify({ event: "voice.rules.snapshot_refresh_failed", businessId, reasonCode: "refresh_failed" }));
  }
}

export async function GET(request: Request) {
  try {
    return NextResponse.json(await withOperatorTransaction(request, async ({ session, businessId }) => await listAgentRules(createDomainContext(), { userId: session.user.id, businessId }), { pilotCapability: "voice" }));
  } catch (error) { return asApiResponse(error); }
}

export async function POST(request: Request) {
  try {
    const body = createSchema.parse(await readJson(request));
    const result = await withOperatorTransaction(request, async ({ session, businessId }) => ({ businessId, ruleId: await createAgentRule(createDomainContext(), { userId: session.user.id, businessId, title: body.title, content: body.content, ...(body.active === undefined ? {} : { active: body.active }) }) }), { pilotCapability: "voice" });
    await refreshRulesSnapshot(result.businessId);
    return NextResponse.json(result.ruleId, { status: 201 });
  } catch (error) { return asApiResponse(error); }
}

export async function PATCH(request: Request) {
  try {
    const body = await readJson(request);
    let businessId: string;
    if (typeof body === "object" && body !== null && "ruleIds" in body) {
      const input = reorderSchema.parse(body);
      businessId = await withOperatorTransaction(request, async ({ session, businessId }) => { await reorderAgentRules(createDomainContext(), { ...input, userId: session.user.id, businessId }); return businessId; }, { minimumRole: "business_admin", pilotCapability: "voice" });
    } else {
      const input = updateSchema.parse(body);
      businessId = await withOperatorTransaction(request, async ({ session, businessId }) => { await updateAgentRule(createDomainContext(), { userId: session.user.id, businessId, ruleId: input.ruleId, ...(input.title === undefined ? {} : { title: input.title }), ...(input.content === undefined ? {} : { content: input.content }), ...(input.active === undefined ? {} : { active: input.active }) }); return businessId; }, { minimumRole: "business_admin", pilotCapability: "voice" });
    }
    await refreshRulesSnapshot(businessId);
    return NextResponse.json({ ok: true });
  } catch (error) { return asApiResponse(error); }
}

export async function DELETE(request: Request) {
  try {
    const input = deleteSchema.parse(await readJson(request));
    const businessId = await withOperatorTransaction(request, async ({ session, businessId }) => { await deleteAgentRule(createDomainContext(), { ...input, userId: session.user.id, businessId }); return businessId; }, { minimumRole: "business_admin", pilotCapability: "voice" });
    await refreshRulesSnapshot(businessId);
    return NextResponse.json({ ok: true });
  } catch (error) { return asApiResponse(error); }
}

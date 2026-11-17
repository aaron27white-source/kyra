import { NextResponse } from "next/server";

import { createService, listCatalog, updateBusinessIntakePolicy } from "@lobbystack/domain";
import { serviceIntakePolicySchema, type ServiceIntakePolicy } from "@lobbystack/shared";
import { asApiResponse, readJson, requireOperatorBusiness } from "@/lib/api-helpers";
import { createDomainContext } from "@/lib/domain-context";

export const dynamic = "force-dynamic";

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw new Error(`${field} is invalid.`);
  }
  return value.trim();
}

export async function GET(request: Request) {
  try {
    const { session, businessId } = await requireOperatorBusiness(request, { pilotCapability: "services" });
    const url = new URL(request.url);
    return NextResponse.json(await listCatalog(createDomainContext(), { userId: session.user.id, businessId, ...(url.searchParams.get("search") ? { search: url.searchParams.get("search")! } : {}), ...(url.searchParams.get("limit") ? { limit: Number(url.searchParams.get("limit")) } : {}), ...(url.searchParams.get("offset") ? { offset: Number(url.searchParams.get("offset")) } : {}) }));
  } catch (error) {
    return asApiResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { session, businessId } = await requireOperatorBusiness(request, { pilotCapability: "services" });
    const body = await readJson(request);
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("A service object is required.");
    const input = body as Record<string, unknown>;
    if (input.businessId !== undefined && input.businessId !== businessId) throw new Error("businessId does not match the active workspace.");
    const durationMinutes = typeof input.durationMinutes === "number" ? input.durationMinutes : Number(input.durationMinutes);
    if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 1_440) throw new Error("durationMinutes is invalid.");
    if (input.active !== undefined && typeof input.active !== "boolean") throw new Error("active is invalid.");
    const name = requiredString(input.name, "name", 160);
    const slug = requiredString(input.slug ?? name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), "slug", 160);
    const description = input.description === undefined || input.description === null ? undefined : requiredString(input.description, "description", 2_000);
    const intakePolicy = input.intakePolicy === undefined ? undefined : serviceIntakePolicySchema.parse(input.intakePolicy) as unknown as ServiceIntakePolicy;
    const serviceId = await createService(createDomainContext(), { userId: session.user.id, businessId, name, slug, durationMinutes, ...(typeof input.active === "boolean" ? { active: input.active } : {}), ...(description ? { description } : {}), ...(intakePolicy ? { intakePolicy } : {}) });
    return NextResponse.json({ serviceId }, { status: 201 });
  } catch (error) {
    return asApiResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const { session, businessId } = await requireOperatorBusiness(request, { pilotCapability: "services" });
    const body = await readJson(request);
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("A business intake policy is required.");
    const input = body as Record<string, unknown>;
    if (input.businessId !== undefined && input.businessId !== businessId) throw new Error("businessId does not match the active workspace.");
    const intakePolicy = serviceIntakePolicySchema.parse(input.intakePolicy) as unknown as ServiceIntakePolicy;
    await updateBusinessIntakePolicy(createDomainContext(), { userId: session.user.id, businessId, intakePolicy });
    return NextResponse.json({ ok: true });
  } catch (error) { return asApiResponse(error); }
}

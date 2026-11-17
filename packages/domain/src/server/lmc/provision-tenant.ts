import { and, asc, eq } from "drizzle-orm";
import { lmcTenantBootstrapSchema, lmcTenantIdentitySchema } from "@lobbystack/contracts";
import { businesses, calendarConnections, staff, users, withBusinessTransaction, type Database } from "@lobbystack/db";
import { requireBusinessMembership } from "../../authz";
import { createBusiness, listUserBusinesses } from "../tenancy";

type Context = { database: Database; authDatabase: Database };

async function requireVerifiedOperator(context: Context, userId: string) {
  const [user] = await context.authDatabase.select({ verified: users.emailVerified }).from(users).where(eq(users.id,userId)).limit(1);
  if (!user?.verified) throw new Error("TENANT_OPERATOR_NOT_VERIFIED");
}

/** Operator-only metadata; encrypted credentials never leave the database. */
export async function inspectLmcTenantSetup(context: Context, raw: unknown) {
  const seed = lmcTenantIdentitySchema.parse(raw);
  await requireVerifiedOperator(context,seed.userId);
  return withBusinessTransaction(context.database,{businessId:seed.tenantId,userId:seed.userId,actorType:"operator"},async tx=>{
    await requireBusinessMembership(tx,{businessId:seed.tenantId,userId:seed.userId,minimumRole:"business_admin"});
    const [business] = await tx.select({id:businesses.id}).from(businesses).where(eq(businesses.id,seed.tenantId)).limit(1);
    if (!business) throw new Error("TENANT_NOT_AVAILABLE");
    const members = await tx.select({staffId:staff.id,name:staff.name}).from(staff).where(and(eq(staff.businessId,seed.tenantId),eq(staff.active,true))).orderBy(asc(staff.id));
    const calendars = await tx.select({connectionId:calendarConnections.id,provider:calendarConnections.provider,status:calendarConnections.status,staffId:calendarConnections.staffId,selectedCalendarId:calendarConnections.selectedCalendarId}).from(calendarConnections).where(eq(calendarConnections.businessId,seed.tenantId)).orderBy(asc(calendarConnections.id));
    return {tenantId:seed.tenantId,staff:members,calendars};
  });
}

/** Uses canonical creation, including owner membership, default staff and initial snapshot job. */
export async function bootstrapLmcTenant(context: Context, raw: unknown) {
  const seed = lmcTenantBootstrapSchema.parse(raw);
  await requireVerifiedOperator(context,seed.userId);
  const existing = (await listUserBusinesses(context.database,seed.userId)).find(business=>business.slug===seed.slug);
  let tenantId: string;
  if (existing) {
    tenantId=existing.businessId;
    await withBusinessTransaction(context.database,{businessId:tenantId,userId:seed.userId,actorType:"operator"},async tx=>{
      await requireBusinessMembership(tx,{businessId:tenantId,userId:seed.userId,minimumRole:"business_admin"});
      const [business] = await tx.select({name:businesses.name,timezone:businesses.timezone,businessType:businesses.businessType}).from(businesses).where(eq(businesses.id,tenantId)).limit(1);
      if (!business || business.name!==seed.name || business.timezone!==seed.timezone || business.businessType!==seed.businessType) throw new Error("TENANT_BOOTSTRAP_MISMATCH");
    });
  } else {
    tenantId=(await createBusiness({db:context.database},seed)).businessId;
  }
  return {...await inspectLmcTenantSetup(context,{tenantId,userId:seed.userId}),created:!existing};
}

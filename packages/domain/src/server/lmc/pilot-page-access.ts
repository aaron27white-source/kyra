import { eq } from "drizzle-orm";
import { lmcBusinessSettingsSchema, lmcTenantIdentitySchema } from "@lobbystack/contracts";
import { businesses, lmcSettings, users, withBusinessTransaction, type Database } from "@lobbystack/db";
import type { PilotDashboardCapability } from "@lobbystack/shared";
import { AuthorizationError, requireBusinessMembership } from "../../authz";

export type LmcPilotPageAccess = {
  tenantId: string;
  capabilities: PilotDashboardCapability[];
};

export function resolveLmcPilotDashboardCapabilities(input: {
  businessStatus: string;
  voiceEnabled?: boolean;
}): PilotDashboardCapability[] {
  const configuration: PilotDashboardCapability[] = [
    "leads",
    "email_settings",
    "business_profile",
    "services",
    "knowledge",
    "integrations",
  ];
  // Draft workspaces can be configured before activation. Contacts are an
  // operational/PII surface and open only after activation (or while paused
  // for repair), when the operator still has an active tenant membership.
  const available: PilotDashboardCapability[] = input.businessStatus === "draft" ? configuration : [...configuration, "contacts"];
  if (input.voiceEnabled) available.push("voice");
  return available;
}

export async function resolveLmcPilotPageAccess(context:{database:Database;authDatabase:Database},userId:string):Promise<LmcPilotPageAccess|null>{
  const identity=lmcTenantIdentitySchema.shape.userId.safeParse(userId);
  if(!identity.success)return null;
  const [user]=await context.authDatabase.select({verified:users.emailVerified,activeBusinessId:users.activeBusinessId}).from(users).where(eq(users.id,identity.data)).limit(1);
  if(!user?.verified||!user.activeBusinessId)return null;
  const tenantId=user.activeBusinessId;
  return withBusinessTransaction(context.database,{businessId:tenantId,userId:identity.data,actorType:"operator"},async tx=>{
    try{await requireBusinessMembership(tx,{businessId:tenantId,userId:identity.data,minimumRole:"viewer"});}
    catch(error){if(error instanceof AuthorizationError)return null;throw error;}
    const [settings] = await tx.select({config:lmcSettings.config}).from(lmcSettings).where(eq(lmcSettings.tenantId,tenantId)).limit(1);
    const [business] = await tx.select({status:businesses.status,voiceEnabled:businesses.lmcVoiceEnabled}).from(businesses).where(eq(businesses.id,tenantId)).limit(1);
    if(!settings||!business||!lmcBusinessSettingsSchema.safeParse(settings.config).success)return null;
    // A paused tenant still needs settings access; API roles and scheduling
    // freshness/verification rules continue to govern every actual operation.
    return {tenantId,capabilities:resolveLmcPilotDashboardCapabilities({businessStatus:business.status,voiceEnabled:business.voiceEnabled})};
  });
}

/** Verified invitees remain on setup-required while their owned pilot workspace is incomplete. */
export async function isLmcPilotSetupRequired(context:{database:Database;authDatabase:Database},userId:string):Promise<boolean>{
  const identity=lmcTenantIdentitySchema.shape.userId.safeParse(userId);
  if(!identity.success)return false;
  const [user]=await context.authDatabase.select({verified:users.emailVerified,activeBusinessId:users.activeBusinessId}).from(users).where(eq(users.id,identity.data)).limit(1);
  if(!user?.verified)return false;
  if(!user.activeBusinessId)return true;
  return await withBusinessTransaction(context.database,{businessId:user.activeBusinessId,userId:identity.data,actorType:"operator"},async tx=>{
    try{
      await requireBusinessMembership(tx,{businessId:user.activeBusinessId!,userId:identity.data,minimumRole:"business_owner"});
      const [workspace]=await tx.select({status:businesses.status,onboardingStage:businesses.onboardingStage}).from(businesses).where(eq(businesses.id,user.activeBusinessId!)).limit(1);
      if(workspace?.status!=="draft"||workspace.onboardingStage!=="managed_draft")return false;
      const [settings]=await tx.select({config:lmcSettings.config}).from(lmcSettings).where(eq(lmcSettings.tenantId,user.activeBusinessId!)).limit(1);
      return !settings||!lmcBusinessSettingsSchema.safeParse(settings.config).success;
    }
    catch(error){if(error instanceof AuthorizationError)return false;throw error;}
  });
}

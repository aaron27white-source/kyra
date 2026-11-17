import { eq } from "drizzle-orm";
import { expect,it } from "vitest";
import { assertDatabaseRole,businesses,businessMemberships,createDatabaseClient,lmcSettings,users } from "@lobbystack/db";
import { createLmcHarness } from "./support/harness";
import { openLmcTestDatabase } from "./support/database";
import { resolveLmcPilotPageAccess } from "../../packages/domain/src/server/lmc/pilot-page-access";

it("requires actual verified identity, active membership, canonical active tenant and valid LMC configuration for page access",async()=>{
  const a=await createLmcHarness({now:"2030-01-09T03:40:00Z"}),b=await createLmcHarness({now:"2030-01-09T03:40:00Z"}),db=openLmcTestDatabase(),auth=createDatabaseClient("lobbystack_auth");
  const context={database:db.app.db,authDatabase:auth.db};
  try{
    await assertDatabaseRole(db.app,{NODE_ENV:"production"});await assertDatabaseRole(auth,{NODE_ENV:"production"});
    await db.admin.db.update(users).set({activeBusinessId:a.tenantId}).where(eq(users.id,a.ownerId));
    expect(await resolveLmcPilotPageAccess(context,a.ownerId)).toBeNull();
    await db.admin.db.update(users).set({emailVerified:true}).where(eq(users.id,a.ownerId));
    expect(await resolveLmcPilotPageAccess(context,a.ownerId)).toEqual({tenantId:a.tenantId,capabilities:["leads","email_settings","business_profile","services","knowledge","integrations","contacts"]});
    await db.admin.db.update(users).set({activeBusinessId:b.tenantId}).where(eq(users.id,a.ownerId));
    expect(await resolveLmcPilotPageAccess(context,a.ownerId)).toBeNull();
    await db.admin.db.update(users).set({activeBusinessId:a.tenantId}).where(eq(users.id,a.ownerId));
    const [saved]=await db.admin.db.select().from(lmcSettings).where(eq(lmcSettings.tenantId,a.tenantId));
    await db.admin.pool.query("update lmc_settings set config=$1::jsonb where tenant_id=$2",["{}",a.tenantId]);
    expect(await resolveLmcPilotPageAccess(context,a.ownerId)).toBeNull();
    await db.admin.db.update(lmcSettings).set({config:saved!.config,enabled:false}).where(eq(lmcSettings.tenantId,a.tenantId));
    expect(await resolveLmcPilotPageAccess(context,a.ownerId)).toEqual({tenantId:a.tenantId,capabilities:["leads","email_settings","business_profile","services","knowledge","integrations","contacts"]});
    await db.admin.db.update(businesses).set({status:"draft"}).where(eq(businesses.id,a.tenantId));
    expect((await resolveLmcPilotPageAccess(context,a.ownerId))?.capabilities).not.toContain("contacts");
    await db.admin.db.update(businesses).set({status:"active"}).where(eq(businesses.id,a.tenantId));
    const viewer=await a.addViewer();await db.admin.db.update(users).set({emailVerified:true,activeBusinessId:a.tenantId}).where(eq(users.id,viewer));
    expect(await resolveLmcPilotPageAccess(context,viewer)).toMatchObject({tenantId:a.tenantId});
    await db.admin.db.update(businessMemberships).set({status:"revoked"}).where(eq(businessMemberships.userId,viewer));
    expect(await resolveLmcPilotPageAccess(context,viewer)).toBeNull();
  }finally{await b.close();await a.close();await db.close();await auth.pool.end();}
});

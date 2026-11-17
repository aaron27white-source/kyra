import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(fileURLToPath(new URL("../../migrations/0074_superadmin_foundation.sql", import.meta.url)), "utf8");
const managedClients = readFileSync(fileURLToPath(new URL("../../migrations/0075_superadmin_managed_clients.sql", import.meta.url)), "utf8");
const activation = readFileSync(fileURLToPath(new URL("../../migrations/0076_superadmin_activation.sql", import.meta.url)), "utf8");
const inboundVoice = readFileSync(fileURLToPath(new URL("../../migrations/0078_lmc_inbound_voice.sql", import.meta.url)), "utf8");

describe("Super Admin foundation migration", () => {
  it("keeps MFA secrets auth-only and audit events system-only", () => {
    expect(migration).toContain("FOR ALL TO lobbystack_auth");
    expect(migration).toContain("ALTER TABLE public.two_factors FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("FOR ALL TO lobbystack_system");
    expect(migration).not.toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON public.two_factors TO lobbystack_app");
  });

  it("tracks managed activation only after verified ownership and a fresh selected calendar", () => {
    expect(activation).toContain("draft.tenant_id IS NOT NULL AND owner.user_id IS NULL");
    expect(activation).toContain("c.owner_user_id=owner.user_id");
    expect(activation).toContain("c.selected_calendar_id IS NOT NULL");
    expect(activation).toContain("c.last_synced_at >= now() - interval '24 hours'");
    expect(activation).toContain("app.superadmin_managed_owner(p_tenant_id uuid)");
    expect(activation).toContain("u.normalized_email=d.owner_email");
    expect(activation).toContain("REVOKE ALL ON FUNCTION app.superadmin_managed_owner(uuid) FROM PUBLIC");
    expect(activation).toContain("GRANT EXECUTE ON FUNCTION app.superadmin_overview() TO lobbystack_app");
  });

  it("revokes public execution for every privileged function", () => {
    const privilegedMigrations = `${migration}\n${managedClients}\n${activation}`;
    for (const signature of [
      "app.is_verified_platform_admin(uuid)",
      "app.superadmin_clients(text, integer, integer)",
      "app.superadmin_managed_owner(uuid)",
      "app.superadmin_overview()",
      "app.bootstrap_platform_admin(text, uuid)",
    ]) expect(privilegedMigrations).toContain(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`);
  });

  it("requires verified identity, MFA, and the dedicated system login for bootstrap", () => {
    expect(migration).toContain("platform_role = 'platform_admin'");
    expect(migration).toContain("AND email_verified");
    expect(migration).toContain("AND two_factor_enabled");
    expect(migration).toContain("session_user <> 'lobbystack_system'");
    expect(migration).toContain("A platform administrator already exists.");
    expect(migration).toContain("'platform_admin.bootstrap'");
  });
});

describe("LMC inbound voice migration", () => {
  it("defaults tenant enablement off and resolves only active, voice-enabled assigned numbers", () => {
    expect(inboundVoice).toContain("lmc_voice_enabled boolean NOT NULL DEFAULT false");
    expect(inboundVoice).toContain("p.status = 'active'");
    expect(inboundVoice).toContain("p.voice_enabled");
    expect(inboundVoice).toContain("s.enabled");
    expect(inboundVoice).toContain("b.deployment_mode = 'cloud'");
    expect(inboundVoice).toContain("b.status = 'active'");
    expect(inboundVoice).toContain("AND b.lmc_voice_enabled");
    expect(inboundVoice).toContain("REVOKE ALL ON FUNCTION app.resolve_lmc_live_business_by_phone(text) FROM PUBLIC");
  });
});

describe("managed client migration", () => {
  it("keeps drafts and idempotency records behind FORCE RLS and the system role", () => {
    expect(managedClients).toContain("ALTER TABLE public.lmc_tenant_drafts FORCE ROW LEVEL SECURITY");
    expect(managedClients).toContain("ALTER TABLE public.platform_admin_operations FORCE ROW LEVEL SECURITY");
    expect(managedClients).toContain("TO lobbystack_system");
    expect(managedClients).not.toContain("ON public.lmc_tenant_drafts TO lobbystack_app");
  });
});

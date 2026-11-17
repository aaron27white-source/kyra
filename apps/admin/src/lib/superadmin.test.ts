import { describe, expect, it } from "vitest";

import { assertSuperAdminIdentity, SuperAdminAccessError } from "./superadmin";

describe("Super Admin identity policy", () => {
  it.each([
    [{ platformRole: "operator", emailVerified: true, twoFactorEnabled: true }, "Platform administrator"],
    [{ platformRole: "platform_admin", emailVerified: false, twoFactorEnabled: true }, "verified identity"],
    [{ platformRole: "platform_admin", emailVerified: true, twoFactorEnabled: false }, "Multi-factor"],
  ])("denies incomplete privileged identity %#", (identity, message) => {
    expect(() => assertSuperAdminIdentity(identity)).toThrow(message);
    try { assertSuperAdminIdentity(identity); } catch (error) { expect(error).toBeInstanceOf(SuperAdminAccessError); expect((error as SuperAdminAccessError).status).toBe(403); }
  });

  it("allows only a verified platform admin with MFA", () => {
    expect(() => assertSuperAdminIdentity({ platformRole: "platform_admin", emailVerified: true, twoFactorEnabled: true })).not.toThrow();
  });
});

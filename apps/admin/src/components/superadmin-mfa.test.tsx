// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SuperAdminMfaChallenge, SuperAdminMfaSetup } from "./superadmin-mfa";

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation }));

beforeEach(() => {
  window.history.replaceState(null, "", "/internal/mfa");
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("Super Admin MFA", () => {
  it("verifies a six-digit challenge without trusting the device", async () => {
    window.history.replaceState(null, "", "/internal/mfa?returnTo=%2Finternal%2Fclients");
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ status: true }));
    render(<SuperAdminMfaChallenge />);
    await userEvent.type(screen.getByLabelText("Authenticator code"), "12ab3456");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(fetch).toHaveBeenCalledWith("/api/auth/two-factor/verify-totp", expect.objectContaining({ body: JSON.stringify({ code: "123456", trustDevice: false }) }));
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith("/internal/clients"));
  });

  it("supports a single-use recovery code", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ status: true }));
    render(<SuperAdminMfaChallenge />);
    await userEvent.click(screen.getByRole("button", { name: "Use a recovery code" }));
    await userEvent.type(screen.getByLabelText("Recovery code"), "backup-fixture");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(fetch).toHaveBeenCalledWith("/api/auth/two-factor/verify-backup-code", expect.objectContaining({ body: JSON.stringify({ code: "backup-fixture", trustDevice: false }) }));
  });

  it("requires password confirmation, displays recovery codes, and verifies enrollment", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({ totpURI: "otpauth://totp/Lead%20My%20Company:admin?secret=FIXTURESECRET", backupCodes: ["backup-one", "backup-two"] }))
      .mockResolvedValueOnce(Response.json({ status: true }));
    render(<SuperAdminMfaSetup />);
    await userEvent.type(screen.getByLabelText("Password"), "Admin-password-1!");
    await userEvent.click(screen.getByRole("button", { name: "Set up authenticator" }));
    expect(await screen.findByText("FIXTURESECRET")).toBeTruthy();
    expect(screen.getByText("backup-one")).toBeTruthy();
    await userEvent.type(screen.getByLabelText("Authenticator code"), "654321");
    await userEvent.click(screen.getByRole("button", { name: "Finish setup" }));
    expect(fetch).toHaveBeenNthCalledWith(1, "/api/auth/two-factor/enable", expect.objectContaining({ body: JSON.stringify({ password: "Admin-password-1!", method: "totp" }) }));
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith("/internal"));
  });
});

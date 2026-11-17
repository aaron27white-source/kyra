// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import type { ManagedClientReadiness } from "@lobbystack/domain";
import { ManagedClientActivation } from "./managed-client-activation";

const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const readiness: ManagedClientReadiness = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  voiceEnabled: false,
  status: "draft",
  onboardingStage: "managed_draft",
  checks: {
    draft: true,
    verifiedOwner: true,
    calendarAuthorized: true,
    calendarSelected: true,
    calendarFresh: true,
    senderConfigured: false,
  },
  calendar: {
    status: "connected",
    account: "owner@example.com",
    selected: true,
    lastSyncedAt: new Date("2026-10-26T08:00:00.000Z"),
    error: null,
  },
  canActivate: false,
};

it("identifies email delivery as the remaining operator step", () => {
  render(<ManagedClientActivation initial={readiness} />);

  expect(screen.getByText("Calendar setup is complete. Email delivery is the remaining admin step.")).toBeTruthy();
  expect(screen.getByText(/LMC_EMAIL_WORKER_ENABLED=true/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Activate client" }).hasAttribute("disabled")).toBe(true);
});

it("removes the email warning when the provider and sender are ready", () => {
  render(<ManagedClientActivation initial={{ ...readiness, checks: { ...readiness.checks, senderConfigured: true }, canActivate: true }} />);

  expect(screen.queryByText("Calendar setup is complete. Email delivery is the remaining admin step.")).toBeNull();
  expect(screen.getByRole("button", { name: "Activate client" }).hasAttribute("disabled")).toBe(false);
});

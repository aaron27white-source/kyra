// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { ManagedOwnerSetup } from "./managed-owner-setup";

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("marks a selected, freshly synchronized calendar complete and explains the admin handoff", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({
    tenantId: "00000000-0000-4000-8000-000000000001",
    connection: {
      id: "00000000-0000-4000-8000-000000000002",
      externalAccountId: "owner@example.com",
      selectedCalendarId: "primary",
      status: "connected",
      lastSyncedAt: "2026-10-26T08:00:00.000Z",
    },
    calendars: [{ id: "primary", summary: "Lead My Company", accessRole: "owner", selected: true }],
    discoveryError: null,
  })));

  render(<ManagedOwnerSetup />);

  expect(await screen.findByText("Calendar setup complete")).toBeTruthy();
  expect(screen.getByText(/pilot administrator is finishing email setup and activation/i)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Calendar saved" }).hasAttribute("disabled")).toBe(true);
});

it("leaves setup for leads when activation makes the owner setup endpoint unavailable", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Not found." }, { status: 404 })));

  render(<ManagedOwnerSetup />);

  await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/leads"));
  expect(router.refresh).toHaveBeenCalledOnce();
});

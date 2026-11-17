// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveLmcLeadsSurface } from "./live-lmc-leads-surface";
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ i18n: { language: "en" }, t: (key: string) => key }),
}));
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
  vi.unstubAllGlobals();
});
function setup(role = "business_owner") {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  clients.push(client);
  client.setQueryData(["businesses"], {
    businesses: [{ businessId: "business", active: true, role }],
  });
  const lead = {
    id: "lead-1",
    email: "ana@example.invalid",
    name: "Ana",
    subject: "Roof repair",
    status: "qualifying",
    reason: null,
    qualification: { zip: "33101" },
    aiPaused: false,
    consentFollowups: true,
    followupCount: 0,
    updatedAt: "2030-01-09T03:40:00Z",
  };
  let attempts = 0;
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      attempts++;
      return Response.json(
        attempts === 1 ? { error: "temporary" } : { id: "message" },
        { status: attempts === 1 ? 503 : 200 },
      );
    }
    if (init?.method === "PATCH") return Response.json({ paused: true });
    if (url.includes("/api/leads/lead-1"))
      return Response.json({
        lead,
        messages: [
          {
            id: "message-1",
            direction: "lead",
            body: "<img src=x onerror=alert(1)>",
            status: "received",
            createdAt: "2030-01-09T03:40:00Z",
          },
        ],
        events: [],
        nextBefore: null,
        role,
      });
    return Response.json({
      items: [lead],
      summary: { qualifying: 1 },
      hasNext: false,
      role,
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider client={client}>
      <LiveLmcLeadsSurface />
    </QueryClientProvider>,
  );
  return { client, fetchMock };
}
describe("email lead workspace", () => {
  it("renders inbound text safely and keeps the same idempotency key when retrying a human reply", async () => {
    const { fetchMock } = setup();
    await userEvent.click(await screen.findByRole("button", { name: "Ana" }));
    expect(
      await screen.findByText("<img src=x onerror=alert(1)>"),
    ).toBeTruthy();
    expect(document.querySelector("img[src=x]")).toBeNull();
    await userEvent.type(
      screen.getByLabelText("reply"),
      "I will help you personally.",
    );
    await userEvent.click(screen.getByRole("button", { name: "send" }));
    await screen.findByText("sendFailed");
    await userEvent.click(screen.getByRole("button", { name: "send" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([, init]) => init?.method === "POST"),
      ).toHaveLength(2),
    );
    const bodies = fetchMock.mock.calls
      .filter(([, init]) => init?.method === "POST")
      .map(([, init]) => JSON.parse(init!.body as string));
    expect(bodies[0].requestId).toBe(bodies[1].requestId);
    expect(bodies[0].text).toBe("I will help you personally.");
  });
  it("allows viewers to read but provides no reply or pause controls", async () => {
    setup("viewer");
    await userEvent.click(await screen.findByRole("button", { name: "Ana" }));
    await screen.findByText("<img src=x onerror=alert(1)>");
    expect(screen.queryByRole("button", { name: "send" })).toBeNull();
    expect(screen.queryByRole("button", { name: "pause" })).toBeNull();
  });
  it("sends pause requests with the selected workspace and no lead-provided tenant", async () => {
    const { fetchMock } = setup();
    await userEvent.click(await screen.findByRole("button", { name: "Ana" }));
    await userEvent.click(await screen.findByRole("button", { name: "pause" }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH"),
      ).toBe(true),
    );
    const call = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "PATCH",
    )!;
    expect(call[0]).toBe("/api/leads/lead-1/automation?businessId=business");
    expect(JSON.parse(call[1]!.body as string)).toEqual({ paused: true });
  });
  it("clears the selected conversation and reply draft when changing workspace", async () => {
    const { client } = setup();
    await userEvent.click(await screen.findByRole("button", { name: "Ana" }));
    await userEvent.type(
      await screen.findByLabelText("reply"),
      "Private draft for the first workspace",
    );
    act(() =>
      client.setQueryData(["businesses"], {
        businesses: [
          {
            businessId: "another-business",
            active: true,
            role: "business_owner",
          },
        ],
      }),
    );
    await screen.findByText("selectLead");
    expect(screen.queryByLabelText("reply")).toBeNull();
    expect(screen.queryByText("<img src=x onerror=alert(1)>")).toBeNull();
    await userEvent.click(await screen.findByRole("button", { name: "Ana" }));
    expect(
      ((await screen.findByLabelText("reply")) as HTMLTextAreaElement).value,
    ).toBe("");
  });
});

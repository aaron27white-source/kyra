// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { LiveLmcSettingsSurface } from "./live-lmc-settings-surface";
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  clients.forEach((client) => client.clear());
  clients.length = 0;
  vi.unstubAllGlobals();
});
function setup(role = "business_owner") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  clients.push(client);
  client.setQueryData(["businesses"], {
    businesses: [{ businessId: "business", active: true, role }],
  });
  const config = {
    ownerEmail: "owner@example.invalid",
    fromEmail: "sender@example.invalid",
    physicalAddress: "123 Main St, Miami FL",
    serviceAreaZips: ["33101"],
    serviceAreaCities: ["Miami"],
    services: [{ id: "service", name: "Roof repair", aliases: ["repair"] }],
    emergencyKeywords: ["active leak"],
    emergencyText: "Please contact our emergency team immediately.",
    priceInformation: "",
    tone: "professional",
    confidenceThreshold: 0.8,
    tools: ["availability", "handoff"],
    followups: {
      enabled: false,
      maxTouches: 3,
      delaysHours: [24, 72, 168],
      dailyCap: 100,
    },
  };
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
    Response.json(
      init?.method === "PUT"
        ? { config, enabled: false }
        : {
            config,
            enabled: false,
            catalog: [{ id: "service", name: "Roof repair" }],
            senderEmail: "sender@example.invalid",
            providerMode: "fake",
            role,
          },
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider client={client}>
      <LiveLmcSettingsSurface />
    </QueryClientProvider>,
  );
  return { fetchMock };
}
it("keeps comma-separated drafts editable and saves canonical service aliases and the platform sender", async () => {
  const { fetchMock } = setup();
  const cities = await screen.findByLabelText("emailSettings.cities");
  await userEvent.clear(cities);
  await userEvent.type(cities, "Miami, Tampa,");
  expect((cities as HTMLInputElement).value).toBe("Miami, Tampa,");
  expect(
    (screen.getByLabelText("emailSettings.sender") as HTMLInputElement)
      .readOnly,
  ).toBe(true);
  await userEvent.click(
    screen.getByRole("button", { name: "emailSettings.save" }),
  );
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "PUT"),
    ).toBe(true),
  );
  const [url, init] = fetchMock.mock.calls.find(
    ([, init]) => init?.method === "PUT",
  )!;
  const body = JSON.parse(init!.body as string);
  expect(url).toContain("businessId=business");
  expect(body.config.serviceAreaCities).toEqual(["Miami", "Tampa"]);
  expect(body.config.services[0].aliases).toEqual(["repair"]);
  expect(body.config.fromEmail).toBe("sender@example.invalid");
});
it("renders read-only configuration for viewers without save or rotate actions", async () => {
  setup("viewer");
  const owner = await screen.findByLabelText("emailSettings.owner");
  expect(owner.closest("fieldset")?.disabled).toBe(true);
  expect(
    screen.queryByRole("button", { name: "emailSettings.save" }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", { name: "emailSettings.rotate" }),
  ).toBeNull();
});

it("requires acknowledging invalidation before replacing the capture token", async () => {
  const { fetchMock } = setup();
  const rotate = await screen.findByRole("button", {
    name: "emailSettings.rotate",
  });
  expect((rotate as HTMLButtonElement).disabled).toBe(true);
  fetchMock.mockImplementation(async () =>
    Response.json({
      captureToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    }),
  );
  await userEvent.click(screen.getByLabelText("emailSettings.rotateWarning"));
  await userEvent.click(rotate);
  await waitFor(() =>
    expect(
      (screen.getByLabelText("emailSettings.token") as HTMLInputElement).value,
    ).toBe("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
  );
  expect(
    fetchMock.mock.calls.some(
      ([url, init]) =>
        url === "/api/lmc/settings/capture-token?businessId=business" &&
        init?.method === "POST",
    ),
  ).toBe(true);
  expect(
    (screen.getByLabelText("emailSettings.snippet") as HTMLTextAreaElement)
      .value,
  ).toContain(
    'data-capture-token="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"',
  );
});

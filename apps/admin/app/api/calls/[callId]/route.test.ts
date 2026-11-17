import { afterEach, describe, expect, it, vi } from "vitest";
import { OPTIONS } from "./route";

afterEach(() => vi.unstubAllEnvs());

describe("OPTIONS /api/calls/[callId]", () => {
  it("does not advertise the legacy PATCH method during the pilot", async () => {
    vi.stubEnv("LMC_PILOT_MODE", "true");
    const response = OPTIONS();
    expect(response.status).toBe(204);
    expect(response.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
    expect(await response.text()).toBe("");
  });

  it("advertises the legacy PATCH method outside pilot mode", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("LMC_PILOT_MODE", "false");
    const response = OPTIONS();
    expect(response.status).toBe(204);
    expect(response.headers.get("allow")).toBe("GET, HEAD, PATCH, OPTIONS");
    expect(await response.text()).toBe("");
  });
});

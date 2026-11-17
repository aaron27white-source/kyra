import { demoSnapshot } from "@lobbystack/shared";
import { describe, expect, it } from "vitest";

import { buildPhoneSessionConfig, LIVE_MODEL } from "./session";

describe("GPT-Live phone session configuration", () => {
  it("builds the installed SDK's client-delegated, stored voice session shape", () => {
    const config = buildPhoneSessionConfig(demoSnapshot);
    expect(config).toMatchObject({
      type: "live",
      model: LIVE_MODEL,
      audio: { output: { voice: "marin" } },
      delegation: { type: "client" },
      store: true,
    });
    expect(config.instructions).toContain("Do not introduce yourself or repeat the greeting");
  });
});

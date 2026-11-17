import { describe, expect, it } from "vitest";

import { generateEnv } from "./generate-env.mjs";

describe("generateEnv", () => {
  it("replaces placeholder secrets and keeps other lines", () => {
    let counter = 0;
    const { output, generated } = generateEnv(
      ["# comment", "POSTGRES_PASSWORD=replace-with-a-long-local-password", "POSTGRES_PORT=15433", "OPENAI_API_KEY="].join("\n"),
      () => `secret-${++counter}`,
    );

    expect(output).toBe(["# comment", "POSTGRES_PASSWORD=secret-1", "POSTGRES_PORT=15433", "OPENAI_API_KEY="].join("\n"));
    expect(generated).toEqual(["POSTGRES_PASSWORD"]);
  });

  it("clears provider credentials instead of generating them", () => {
    const { output, generated } = generateEnv("TWILIO_AUTH_TOKEN=replace-with-twilio-auth-token\nPOLAR_WEBHOOK_SECRET=replace-with-polar-webhook-secret");

    expect(output).toBe("TWILIO_AUTH_TOKEN=\nPOLAR_WEBHOOK_SECRET=");
    expect(generated).toEqual([]);
  });

  it("generates production-length secrets by default", () => {
    const { output } = generateEnv("BETTER_AUTH_SECRET=replace-with-at-least-32-random-characters");

    expect(output).toMatch(/^BETTER_AUTH_SECRET=[0-9a-f]{64}$/);
  });

  it("generates distinct app and internal system credentials", () => {
    const { output, generated } = generateEnv(
      "LOBBYSTACK_APP_PASSWORD=replace-with-app-password\nLOBBYSTACK_SYSTEM_PASSWORD=replace-with-system-password",
    );
    const values = Object.fromEntries(output.split("\n").map((line) => line.split("=")));
    expect(values.LOBBYSTACK_APP_PASSWORD).toMatch(/^[0-9a-f]{64}$/);
    expect(values.LOBBYSTACK_SYSTEM_PASSWORD).toMatch(/^[0-9a-f]{64}$/);
    expect(values.LOBBYSTACK_SYSTEM_PASSWORD).not.toBe(values.LOBBYSTACK_APP_PASSWORD);
    expect(generated).toEqual(["LOBBYSTACK_APP_PASSWORD", "LOBBYSTACK_SYSTEM_PASSWORD"]);
  });

  it("generates credentials from a Windows CRLF environment template", () => {
    const { output, generated } = generateEnv(
      "LOBBYSTACK_SYSTEM_PASSWORD=replace-with-system-password\r\nADMIN_PORT=13000\r\n",
      () => "generated-password",
    );
    expect(output).toBe("LOBBYSTACK_SYSTEM_PASSWORD=generated-password\nADMIN_PORT=13000\n");
    expect(generated).toEqual(["LOBBYSTACK_SYSTEM_PASSWORD"]);
  });
});

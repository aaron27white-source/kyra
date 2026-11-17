import { describe, expect, it } from "vitest";

import { BOOTSTRAP_CONFIRMATION, parseBootstrapArguments } from "./superadmin-bootstrap";

describe("superadmin bootstrap arguments", () => {
  it("requires an explicit one-time confirmation", () => {
    expect(() => parseBootstrapArguments(["--email=admin@example.com"])).toThrow("one-time promotion");
  });

  it("normalizes a valid email without accepting role input", () => {
    expect(parseBootstrapArguments(["--email=Admin@Example.com", `--confirm=${BOOTSTRAP_CONFIRMATION}`])).toEqual({ email: "admin@example.com" });
  });

  it("rejects malformed email input", () => {
    expect(() => parseBootstrapArguments(["--email=invalid", `--confirm=${BOOTSTRAP_CONFIRMATION}`])).toThrow("valid --email");
  });
});

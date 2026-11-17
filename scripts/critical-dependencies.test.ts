import { createRequire } from "node:module";
import { expect, it } from "vitest";

// Resolve the transitive copies actually used by our CLI and local MCP tooling.
const root = createRequire(import.meta.url);
const cli = createRequire(root.resolve("concurrently"));
const mcp = createRequire(root.resolve("next-devtools-mcp"));
const sdk = createRequire(
  mcp.resolve("@modelcontextprotocol/sdk/server/index.js"),
);
const express = createRequire(sdk.resolve("express"));
const shellQuote = cli("shell-quote") as {
  quote: (tokens: unknown[]) => string;
};
const proxyAddress = express("proxy-addr") as {
  compile: (subnet: string) => (address: string) => boolean;
};

it("rejects a line terminator following a shell comment instead of producing injectable CLI text", () => {
  for (const terminator of ["\n", "\r", "\u2028", "\u2029"]) {
    // No shell execution: exercise the quoting function only.
    expect(() =>
      shellQuote.quote([
        "echo",
        "ok",
        { comment: "comment" },
        `value${terminator}untrusted`,
      ]),
    ).toThrow(TypeError);
  }
  expect(shellQuote.quote(["echo", "ordinary value"])).toBe(
    "echo 'ordinary value'",
  );
});

it("does not trust an arbitrary IPv4 client through a short IPv4-mapped IPv6 proxy subnet", () => {
  expect(proxyAddress.compile("::ffff:10.0.0.0/8")("192.0.2.1")).toBe(false);
  const valid = proxyAddress.compile("::ffff:10.0.0.0/104");
  expect(valid("10.1.2.3")).toBe(true);
  expect(valid("192.0.2.1")).toBe(false);
});

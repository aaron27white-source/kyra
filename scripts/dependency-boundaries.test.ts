import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const root = createRequire(import.meta.url);
const mcp = createRequire(root.resolve("next-devtools-mcp"));
const sdk = createRequire(
  mcp.resolve("@modelcontextprotocol/sdk/server/index.js"),
);
const ajv = createRequire(sdk.resolve("ajv"));
const uri = ajv("fast-uri") as {
  serialize: (input: Record<string, unknown>) => string;
};
const landing = createRequire(
  new URL("../apps/landing/package.json", import.meta.url),
);
const react = createRequire(landing.resolve("@astrojs/react"));
const devalue = (await import(
  pathToFileURL(react.resolve("devalue")).href
)) as {
  stringify: (input: unknown) => string;
  parse: (input: string) => unknown;
};

it("cannot turn an untrusted port into a different URI authority", () => {
  const fixedHost = "trusted.example.invalid";
  const valid = new URL(
    uri.serialize({
      scheme: "http",
      host: fixedHost,
      port: 8080,
      path: "/app",
    }),
  );
  expect(valid.hostname).toBe(fixedHost);
  expect(valid.port).toBe("8080");
  let built: string;
  try {
    built = uri.serialize({
      scheme: "http",
      host: fixedHost,
      port: "@127.0.0.1:8124",
      path: "/app",
    });
  } catch {
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(built);
  } catch {
    return;
  }
  expect(parsed.hostname).toBe(fixedHost);
});

it.each(["explicit backing buffer", "Node allocation pool"])(
  "serializes a Node Buffer view without neighboring tenant memory: %s",
  (allocation) => {
    const neighbor = "other-tenant-private-fixture";
    const prefix = Buffer.from(neighbor + "/");
    const owned = Buffer.from("roof");
    const backing = new Uint8Array(Buffer.concat([prefix, owned, prefix]));
    const view =
      allocation === "explicit backing buffer"
        ? Buffer.from(backing.buffer, prefix.byteLength, owned.byteLength)
        : Buffer.from(backing).subarray(
            prefix.byteLength,
            prefix.byteLength + owned.byteLength,
          );
    const roundTrip = devalue.parse(devalue.stringify(view)) as Uint8Array;
    expect(Buffer.from(roundTrip).toString()).toBe("roof");
    expect(Buffer.from(roundTrip.buffer).includes(Buffer.from(neighbor))).toBe(
      false,
    );
  },
);

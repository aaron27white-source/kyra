import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { describe, expect, it } from "vitest";
import config from "../vite.config";

describe("embed build entry", () => {
  it("resolves an existing native absolute source path", () => {
    const entry = config.build && config.build.lib && config.build.lib.entry;
    expect(typeof entry).toBe("string");
    expect(isAbsolute(entry as string)).toBe(true);
    expect(existsSync(entry as string)).toBe(true);
  });
});

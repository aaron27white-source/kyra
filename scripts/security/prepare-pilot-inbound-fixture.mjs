import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";

// Explicit local test setup only; never overwrite/rotate an in-use registry.
const target = process.argv[2];
if (!target || !isAbsolute(target) || process.platform === "win32") {
  throw new Error("Provide a new absolute private fixture filename in WSL/Linux.");
}
writeFileSync(target, JSON.stringify({ secret: randomBytes(32).toString("hex"), events: [] }) + "\n", { flag: "wx", mode: 0o600 });
console.log("Private test fixture created; no credentials printed.");

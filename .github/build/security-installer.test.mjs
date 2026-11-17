import { execFileSync } from "node:child_process";
import { test } from "node:test";

test("security installer enforces checksum, safe extraction and existing-content protection", () => {
  execFileSync(
    "python3",
    ["-m", "unittest", "discover", "-s", "scripts/security", "-p", "test_*.py"],
    { stdio: "pipe" },
  );
});

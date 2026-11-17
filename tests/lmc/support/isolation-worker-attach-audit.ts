import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const file = "tests/lmc/isolation-worker-attach.acceptance.ts";

/** Keep SDK transport mocks in an isolated process, never in the admin audit process. */
export async function probeWorkerAttach() {
  const directory = await mkdtemp(join(tmpdir(), "lmc-worker-attach-audit-"));
  try {
    const output = join(directory, "vitest.json");
    const environment = { ...process.env };
    for (const key of ["VITEST", "VITEST_WORKER_ID", "VITEST_POOL_ID"])
      delete environment[key];
    await promisify(execFile)(
      process.execPath,
      [
        join(root, "node_modules/vitest/vitest.mjs"),
        "run",
        "--config",
        "tests/lmc/vitest.config.mts",
        file,
        "--reporter=json",
        "--outputFile",
        output,
      ],
      { cwd: root, env: environment, timeout: 45_000, maxBuffer: 1024 * 1024 },
    );
    const report = JSON.parse(await readFile(output, "utf8")) as {
      success?: boolean;
      numTotalTests?: number;
      numPassedTests?: number;
      testResults?: Array<{
        name?: string;
        status?: string;
        assertionResults?: Array<{ status?: string }>;
      }>;
    };
    const suite = report.testResults?.[0];
    if (
      report.success !== true ||
      report.numTotalTests !== 1 ||
      report.numPassedTests !== 1 ||
      report.testResults?.length !== 1 ||
      suite?.name !== resolve(root, file) ||
      suite.status !== "passed" ||
      suite.assertionResults?.length !== 1 ||
      suite.assertionResults[0]?.status !== "passed"
    )
      throw new Error("INVALID_WORKER_ATTACH_PROOF");
    // Only these explicit method/path pairs are asserted by the production HTTP test.
    return {
      probed: ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"].map(
        (method) => `worker:${method} /internal/live/attach`,
      ),
      failures: [] as string[],
    };
  } catch {
    // Failure, timeout, missing/partial/malformed output must never count as coverage.
    return {
      probed: [] as string[],
      failures: ["WORKER_ATTACH_HTTP_PROBE_FAILED"],
    };
  } finally {
    if (
      dirname(resolve(directory)) !== resolve(tmpdir()) ||
      !basename(directory).startsWith("lmc-worker-attach-audit-")
    )
      throw new Error("UNSAFE_WORKER_AUDIT_CLEANUP");
    await rm(directory, { recursive: true, force: true });
  }
}

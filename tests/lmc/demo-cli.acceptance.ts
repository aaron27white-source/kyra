import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const environment = () => {
  const env = { ...process.env };
  for (const key of ["VITEST", "VITEST_WORKER_ID", "VITEST_POOL_ID"])
    delete env[key];
  return env;
};
it("runs the advertised single command and returns a redacted machine-readable complete demo", async () => {
  const directory = mkdtempSync(join(tmpdir(), "lmc-demo-cli-")),
    output = join(directory, "report.json");
  try {
    const { stdout } = await promisify(execFile)(
      "pnpm",
      ["--silent", "lmc:demo", "--json", "--output", output],
      {
        cwd: root,
        env: environment(),
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      },
    );
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(
      JSON.parse(stdout),
    );
    const report = JSON.parse(stdout);
    expect(report.steps).toHaveLength(8);
    expect(report.cleanup).toEqual({
      businessRemoved: true,
      outboxRemoved: true,
    });
    expect(report.booking.count).toBe(1);
    expect(report.followups.futureSends).toBe(0);
    expect(stdout).not.toMatch(
      /postgres(?:ql)?:\/\/|(?:reply|lead|forward)\+[A-Za-z0-9_-]{43}@|\/api\/lmc\/unsubscribe\//,
    );
    writeFileSync(output, "Existing user report");
    await expect(
      promisify(execFile)(
        "pnpm",
        ["--silent", "lmc:demo", "--json", "--output", output],
        { cwd: root, env: environment(), timeout: 15_000 },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("DEMO_OUTPUT_EXISTS"),
    });
    expect(readFileSync(output, "utf8")).toBe("Existing user report");
  } finally {
    if (
      dirname(resolve(directory)) !== resolve(tmpdir()) ||
      !basename(directory).startsWith("lmc-demo-cli-")
    )
      throw new Error("UNSAFE_DEMO_TEST_CLEANUP");
    rmSync(directory, { recursive: true, force: true });
  }
}, 40_000);

it.each([
  { NODE_ENV: "production", code: "DEMO_PRODUCTION_FORBIDDEN" },
  { LMC_PROVIDER_MODE: "real", code: "DEMO_FAKE_PROVIDERS_REQUIRED" },
  {
    LMC_TEST_DATABASE_URL:
      "postgresql://synthetic-user:synthetic-password@localhost/latest",
    code: "DEMO_LOCAL_TEST_DATABASE_REQUIRED",
  },
  {
    LMC_TEST_DATABASE_URL:
      "postgresql://synthetic-user:synthetic-password@localhost/lmc_test?host=remote.example.invalid",
    code: "DEMO_LOCAL_TEST_DATABASE_REQUIRED",
  },
])(
  "refuses unsafe demo mode before any workflow runs: $code",
  async (override) => {
    const { code, ...variables } = override;
    try {
      await promisify(execFile)("pnpm", ["--silent", "lmc:demo", "--json"], {
        cwd: root,
        env: {
          ...environment(),
          ...variables,
          INTERNAL_SERVICE_TOKEN: "synthetic-demo-sentinel-never-print",
        },
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      throw new Error("UNSAFE_DEMO_SUCCEEDED");
    } catch (error) {
      const result = error as Error & {
        code?: number;
        stdout?: string;
        stderr?: string;
      };
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(code);
      expect(`${result.stdout}${result.stderr}`).not.toContain(
        "synthetic-demo-sentinel-never-print",
      );
      expect(`${result.stdout}${result.stderr}`).not.toMatch(
        /postgres(?:ql)?:\/\//,
      );
      expect(result.stdout).toBe("");
    }
  },
  40_000,
);

import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadLocalEnv } from "./load-local-env.mjs";
import { LmcDemoError, runLmcDemo } from "./lmc/demo";

const usage = `Usage: pnpm lmc:demo [--json] [--output report.json]

Runs initial email -> reply -> qualification -> booking -> owner summary,
then one consented follow-up and STOP on a separate unanswered lead.
Uses real HTTP/PostgreSQL, fake providers/clock, and removes its fixture afterward.

Required: an isolated localhost database with a separate 'test' name token (e.g. lmc_demo_test), migrations,
LMC_TEST_DATABASE_URL (or LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL), and separate
LOBBYSTACK_APP_DATABASE_URL, LOBBYSTACK_SYSTEM_DATABASE_URL,
LOBBYSTACK_WORKER_DATABASE_URL, LOBBYSTACK_DISPATCHER_DATABASE_URL targeting it.

Reads .env and .env.local; optional LMC_DEMO_ENV_FILE selects a private env file.
Inherited environment values win. Production/real-provider modes are refused.
Run exclusively against that test database; do not overlap acceptance workers.
--output writes a redacted report and refuses to overwrite an existing file.
See docs/OFFLINE_DEMO.md. No real provider keys are needed.`;

async function main() {
  let json = false,
    output: string | undefined;
  const args = process.argv.slice(2).filter((value) => value !== "--");
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      console.log(usage);
      return;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (
      arg === "--output" &&
      output === undefined &&
      args[index + 1] &&
      !args[index + 1]!.startsWith("--")
    ) {
      output = resolve(args[++index]!);
      continue;
    }
    throw new LmcDemoError("DEMO_USAGE");
  }
  try {
    const privateFile = process.env.LMC_DEMO_ENV_FILE;
    if (privateFile && !existsSync(privateFile))
      throw new Error("missing private environment file");
    loadLocalEnv([".env", ".env.local", ...(privateFile ? [privateFile] : [])]);
  } catch {
    throw new LmcDemoError("DEMO_ENV_FILE_UNREADABLE");
  }
  if (output && existsSync(output))
    throw new LmcDemoError("DEMO_OUTPUT_EXISTS");
  const report = await runLmcDemo();
  const serialized = JSON.stringify(report, null, 2) + "\n";
  if (output) {
    try {
      await writeFile(output, serialized, { flag: "wx", mode: 0o600 });
    } catch (error) {
      throw new LmcDemoError(
        (error as { code?: string }).code === "EEXIST"
          ? "DEMO_OUTPUT_EXISTS"
          : "DEMO_OUTPUT_UNAVAILABLE",
      );
    }
  }
  if (json) console.log(serialized.trimEnd());
  else {
    console.log(
      "Lead My Company — offline email demo (fake providers, real PostgreSQL)",
    );
    report.steps.forEach((step, index) =>
      console.log(`${index + 1}. ${step.detail}`),
    );
    console.log(
      `Verified: ${report.booking.count} booking; ${report.followups.touches} consented follow-up; no sends after STOP; fixture removed.`,
    );
    if (output) console.log("Redacted report saved to the requested path.");
  }
}

void main().catch((error: unknown) => {
  let code = "DEMO_FAILED";
  if (error instanceof LmcDemoError && /^DEMO_[A-Z0-9_]+$/.test(error.code))
    code = error.code;
  else if (error instanceof Error) {
    if (error.message === "LMC_TEST_DATABASE_URL is required.")
      code = "DEMO_TEST_DATABASE_REQUIRED";
    else if (error.message === "Use an isolated local test database.")
      code = "DEMO_LOCAL_TEST_DATABASE_REQUIRED";
    else if (
      error.message === "Runtime test roles must use the isolated database." ||
      ["APP", "SYSTEM", "WORKER", "DISPATCHER"].some(
        (role) =>
          error.message ===
          `LOBBYSTACK_${role}_DATABASE_URL is required; no privileged fallback is allowed.`,
      )
    )
      code = "DEMO_RUNTIME_DATABASE_URLS_REQUIRED";
  }
  // Never print exception stacks, DSNs, submitted content or environment values.
  console.error(`${code}. See docs/OFFLINE_DEMO.md or pnpm lmc:demo --help.`);
  process.exitCode = 1;
});

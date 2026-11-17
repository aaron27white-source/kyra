import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { summarizeVitestFailures, verifyVitestReport } from "./pilot-ci-report.mjs";
import { pilotAcceptanceContexts } from "./pilot-ci-contexts.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
if (process.platform !== "linux") throw new Error("PILOT_CI_REQUIRES_LINUX_OR_WSL");
if (process.env.DOCKER_HOST) throw new Error("PILOT_CI_REQUIRES_LOCAL_DOCKER");
for (const directory of [root, join(root, "apps/admin")]) {
  if (readdirSync(directory).some(name => /^\.env(?:\.|$)/.test(name) && !name.endsWith(".example"))) throw new Error("PILOT_CI_REFUSES_PRIVATE_CHECKOUT_ENV_FILES");
}
if (!existsSync(join(root, "apps/admin/.next/BUILD_ID"))) throw new Error("PILOT_CI_BUILD_FIRST");
const privateRoot = mkdtempSync(join(tmpdir(), "lmc-pilot-ci-"));
const token = randomUUID();
const label = `com.lmc.pilot-ci=${token}`;
const summaryFile = resolve(process.env.PILOT_CI_SUMMARY_FILE || join(root, ".tmp", `pilot-ci-summary-${token}.json`));
mkdirSync(resolve(summaryFile, ".."), { recursive: true });
if (existsSync(summaryFile)) throw new Error("PILOT_CI_REQUIRES_NEW_SUMMARY_FILE");
const generatedTypes = join(root, "apps/admin/next-env.d.ts");
const originalTypes = readFileSync(generatedTypes, "utf8");
const docker = args => execFileSync("docker", ["--context", "default", ...args], { stdio: "pipe", encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim();
if (!docker(["context", "inspect", "default", "--format", "{{.Endpoints.docker.Host}}"]).startsWith("unix://")) throw new Error("PILOT_CI_REQUIRES_LOCAL_DOCKER");
const tracked = execFileSync("git", ["-c", "core.quotePath=false", "ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, stdio: "pipe", encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim().split("\n");
const isTest = path => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path);
const inventory = JSON.parse(execFileSync("pnpm", ["-r", "list", "--depth", "-1", "--json"], { cwd: root, stdio: "pipe", encoding: "utf8" })).filter(item => resolve(item.path) !== resolve(root));
const summary = { complete: false, hostedExecutionVerified: false, reportedGitHubRun: process.env.GITHUB_ACTIONS === "true" ? { repository: process.env.GITHUB_REPOSITORY, runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT, commit: process.env.GITHUB_SHA } : null, results: [], failedPhase: null, cleanup: false };
const environment = { ...process.env };
for (const name of Object.keys(environment)) {
  if (/PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|DATABASE_URL$/.test(name) || /^(?:AWS_|AZURE_|GOOGLE_|TWILIO_|POLAR_|RESEND_|SMTP_|POSTHOG_|OTEL_|ACTIONS_)/.test(name)) delete environment[name];
}
for (const name of ["APP_BASE_URL", "AUTH_TRUSTED_ORIGINS", "LMC_PUBLIC_BASE_URL", "LMC_PILOT_MODE", "LMC_FAKE_INBOUND_FIXTURE_FILE", "LIVE_PROTOTYPE_ENABLED", "REQUIRE_EMAIL_VERIFICATION", "SSH_AUTH_SOCK"]) delete environment[name];
Object.assign(environment, { NODE_ENV: "test", LOBBYSTACK_SKIP_ENV_FILES: "true", LMC_PROVIDER_MODE: "fake", LMC_FORM_INTEGRATION_TEST: "1", CI: "true" });
const secrets = Object.fromEntries(["POSTGRES_PASSWORD", ...["MIGRATOR", "AUTH", "APP", "SYSTEM", "WORKER", "DISPATCHER", "READONLY", "FINANCE_EXPORT"].map(role => `LOBBYSTACK_${role}_PASSWORD`), "BETTER_AUTH_SECRET", "INTERNAL_SERVICE_SECRET", "INTERNAL_SERVICE_TOKEN", "WIDGET_SESSION_SECRET", "ENCRYPTION_KEY", "OTP_HASH_SECRET", "LOCAL_STORAGE_SIGNING_SECRET", "LMC_SIGNING_SECRET"].map(name => [name, randomBytes(32).toString("hex")]));
Object.assign(environment, secrets);
if (process.env.GITHUB_ACTIONS === "true") for (const value of Object.values(secrets)) console.log("::add-mask::" + value);
const pgEnv = join(privateRoot, "postgres.env");
writeFileSync(pgEnv, `POSTGRES_DB=lmc_pilot_test\nPOSTGRES_PASSWORD=${secrets.POSTGRES_PASSWORD}\n`, { mode: 0o600, flag: "wx" });
let server;
let phase = "initialize";
let index = 0;
const delay = ms => new Promise(done => setTimeout(done, ms));
async function step(name, command, args, env = environment, cwd = root) {
  phase = name;
  console.log("Pilot CI phase: " + name);
  const fd = openSync(join(privateRoot, `phase-${index++}.log`), "wx", 0o600);
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  const [code] = await once(child, "exit");
  if (code !== 0) throw new Error("PILOT_CI_COMMAND_FAILED");
}
// Positional inputs retain every independent source test and avoid accidentally
// executing generated dist copies as a second, stale test inventory.
async function vitest(name, cwd, expectedFiles, args, env = environment) {
  const report = join(privateRoot, `report-${index}.json`);
  try {
    await step(name, "pnpm", ["exec", "vitest", "run", ...args, ...expectedFiles.map(file => resolve(root, file)), "--fileParallelism=false", "--maxWorkers=1", "--reporter=default", "--reporter=json", "--outputFile=" + report, ...(expectedFiles.length ? [] : ["--passWithNoTests"])], env, cwd);
  } catch (error) {
    try {
      const failed = summarizeVitestFailures(JSON.parse(readFileSync(report, "utf8")), { root });
      if (failed.length) {
        const failedTests = failed.reduce((count, file) => count + file.tests.length, 0);
        summary.results.push({ phase: name, tests: failedTests, passed: 0, skipped: 0, failed: failedTests, failures: failed });
      }
    } catch {}
    throw error;
  }
  const result = verifyVitestReport(JSON.parse(readFileSync(report, "utf8")), { root, expectedFiles, allowEmpty: expectedFiles.length === 0 });
  summary.results.push({ phase: name, ...result });
  console.log(`${name}: ${result.passed} passed; ${result.skipped} skipped.`);
}
async function waitForHealth(base) {
  for (let attempt = 0; attempt < 90; attempt++) {
    if (server.exitCode !== null) throw new Error("PILOT_CI_OWNED_HTTP_SERVER_EXITED");
    try { const response = await fetch(base + "/healthz", { signal: AbortSignal.timeout(1000) }); const ready = response.status === 200; await response.arrayBuffer(); if (ready) return; } catch {}
    await delay(500);
  }
  throw new Error("PILOT_CI_HTTP_NOT_READY");
}
try {
  phase = "infrastructure";
  const postgres = "lmc-ci-pg-" + token;
  const redis = "lmc-ci-redis-" + token;
  docker(["run", "-d", "--name", postgres, "--label", label, "--env-file", pgEnv, "--publish", "127.0.0.1::5432", "pgvector/pgvector:pg16@sha256:7b822b0aac60967beb1ea5e576b8602c94c300a157d187f385ae3e0da199b90a"]);
  docker(["run", "-d", "--name", redis, "--label", label, "--publish", "127.0.0.1::6379", "redis:7.4-alpine@sha256:57e4255cc971b1c8d6f8a6ca283ac01bc3ecdd914273ef6bfaede87aaecd6541"]);
  const port = (name, containerPort) => {
    const match = /^127\.0\.0\.1:(\d+)$/.exec(docker(["port", name, containerPort]));
    if (!match) throw new Error("PILOT_CI_NONLOCAL_CONTAINER_PORT");
    return match[1];
  };
  const databasePort = port(postgres, "5432/tcp");
  const url = (user, password) => { const target = new URL(`postgres://127.0.0.1:${databasePort}/lmc_pilot_test`); target.username = user; target.password = password; return target.toString(); };
  environment.DATABASE_URL = url("postgres", secrets.POSTGRES_PASSWORD);
  for (const role of ["APP", "AUTH", "SYSTEM", "WORKER", "DISPATCHER", "READONLY", "FINANCE_EXPORT"]) environment[`LOBBYSTACK_${role}_DATABASE_URL`] = url("lobbystack_" + role.toLowerCase(), secrets[`LOBBYSTACK_${role}_PASSWORD`]);
  for (const name of ["LMC_TEST_DATABASE_URL", "LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL", "LOBBYSTACK_AUTH_TEST_DATABASE_URL"]) environment[name] = environment.DATABASE_URL;
  environment.REDIS_URL = environment.REDIS_TEST_URL = environment.LOBBYSTACK_TEST_REDIS_URL = "redis://127.0.0.1:" + port(redis, "6379/tcp");
  environment.VERIFY_RLS_BEHAVIOR = "true";
  for (let attempt = 0; ; attempt++) {
    try { docker(["exec", postgres, "pg_isready", "-U", "postgres", "-d", "lmc_pilot_test"]); break; } catch { if (attempt >= 60) throw new Error("PILOT_CI_DATABASE_NOT_READY"); await delay(500); }
  }
  for (let pass = 1; pass <= 2; pass++) {
    await step("migrate-" + pass, "pnpm", ["db:migrate"]);
    await step("bootstrap-" + pass, "pnpm", ["--filter", "@lobbystack/db", "exec", "tsx", "src/cli.ts", "bootstrap"]);
  }
  await step("database-health", "pnpm", ["db:check"]);
  await step("database-rls", "pnpm", ["db:verify-rls"]);
  for (const workspace of inventory) {
    const prefix = relative(root, workspace.path).replaceAll("\\", "/") + "/";
    const files = tracked.filter(path => path.startsWith(prefix) && isTest(path));
    const manifest = JSON.parse(readFileSync(join(workspace.path, "package.json"), "utf8"));
    if (!manifest.scripts?.test) { if (files.length) throw new Error("PILOT_CI_TEST_FILES_WITHOUT_COMMAND"); continue; }
    if (!manifest.scripts.test.startsWith("vitest run")) throw new Error("PILOT_CI_UNREVIEWED_TEST_COMMAND");
    await vitest("workspace-" + manifest.name, workspace.path, files, []);
  }
  await vitest("scripts", root, tracked.filter(path => path.startsWith("scripts/") && path.endsWith(".test.ts")), ["--config", "scripts/vitest.config.ts"]);
  const listener = createServer();
  await new Promise(done => listener.listen(0, "127.0.0.1", done));
  const appPort = listener.address().port;
  await new Promise(done => listener.close(done));
  const base = `http://127.0.0.1:${appPort}`;
  summary.httpTestOrigin = base;
  const fixture = join(privateRoot, "inbound.json");
  await step("inbound-fixture", process.execPath, ["scripts/security/prepare-pilot-inbound-fixture.mjs", fixture]);
  const httpEnvironment = { ...environment, OTEL_SDK_DISABLED: "true", ADMIN_PORT: String(appPort), APP_BASE_URL: base, AUTH_TRUSTED_ORIGINS: base, LMC_PUBLIC_BASE_URL: base, LMC_PILOT_MODE: "true", LMC_FAKE_INBOUND_FIXTURE_FILE: fixture, LMC_TEST_HTTP_BASE_URL: base, TURNSTILE_SECRET_KEY: "" };
  const contexts = pilotAcceptanceContexts(tracked.filter(path => path.startsWith("tests/lmc/") && path.endsWith(".acceptance.ts")));
  summary.acceptanceContexts = contexts.map(context => ({ name: context.name, pilot: context.pilot, sourceFiles: context.files.length }));
  for (const context of contexts) {
    phase = "context-infrastructure-" + context.name;
    const contextRedis = "lmc-ci-redis-" + context.name + "-" + token;
    docker(["run", "-d", "--name", contextRedis, "--label", label, "--publish", "127.0.0.1::6379", "redis:7.4-alpine@sha256:57e4255cc971b1c8d6f8a6ca283ac01bc3ecdd914273ef6bfaede87aaecd6541"]);
    const contextRedisUrl = "redis://127.0.0.1:" + port(contextRedis, "6379/tcp");
    const contextEnvironment = { ...httpEnvironment, LMC_PILOT_MODE: String(context.pilot), REDIS_URL: contextRedisUrl, REDIS_TEST_URL: contextRedisUrl, LOBBYSTACK_TEST_REDIS_URL: contextRedisUrl };
    phase = "start-owned-http-" + context.name;
    const fd = openSync(join(privateRoot, `admin-${context.name}.log`), "wx", 0o600);
    server = spawn(process.execPath, [join(root, "apps/admin/node_modules/next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", String(appPort)], { cwd: join(root, "apps/admin"), env: contextEnvironment, detached: true, stdio: ["ignore", fd, fd] });
    closeSync(fd);
    await waitForHealth(base);
    phase = "anonymous-http-startup-" + context.name;
    // Startup has no tenant identity/capability and never invokes auth writes.
    const boundaries = [["/en/login", 200], ["/api/auth/get-session", 200], ["/api/leads", 401], ["/api/lmc/settings", 401], ...(context.pilot ? [["/leads", 307], ["/settings/email", 307]] : [])];
    for (const [path, status] of boundaries) {
      const response = await fetch(base + path, { redirect: "manual", signal: AbortSignal.timeout(60000) });
      await response.arrayBuffer();
      if (response.status !== status) throw new Error("PILOT_CI_ANONYMOUS_STARTUP_BOUNDARY");
    }
    try {
      await vitest("lmc-acceptance-" + context.name, root, context.files, ["--config", "tests/lmc/vitest.config.mts"], contextEnvironment);
    } finally {
      if (server.exitCode === null) {
        const ended = once(server, "exit");
        process.kill(-server.pid, "SIGTERM");
        await Promise.race([ended, delay(10000)]);
        if (server.exitCode === null) { process.kill(-server.pid, "SIGKILL"); await ended; }
      }
      server = undefined;
    }
  }
  await step("production-public-auth-static", process.execPath, ["--test", "tests/lmc/pilot-public-assets.node.mjs"], httpEnvironment);
  if (summary.results.reduce((total, result) => total + result.tests, 0) === 0) throw new Error("PILOT_CI_EMPTY_VALIDATION");
  summary.complete = true;
} catch (error) {
  summary.failureCode = error instanceof Error && /^PILOT_CI_[A-Z_]+$/.test(error.message) ? error.message : "PILOT_CI_UNCLASSIFIED_FAILURE";
  summary.failedPhase = phase;
  process.exitCode = 1;
  console.error("Pilot CI failed in " + phase + "; raw logs/reports remain private.");
} finally {
  try {
    if (server?.exitCode === null) {
      const ended = once(server, "exit");
      process.kill(-server.pid, "SIGTERM");
      await Promise.race([ended, delay(10000)]);
      if (server.exitCode === null) { process.kill(-server.pid, "SIGKILL"); await ended; }
    }
    const owned = docker(["ps", "-aq", "--filter", "label=" + label]).split("\n").filter(Boolean);
    if (owned.length) docker(["rm", "-f", "-v", ...owned]);
    if (docker(["ps", "-aq", "--filter", "label=" + label])) throw new Error("PILOT_CI_RESOURCE_CLEANUP_FAILED");
    const currentTypes = readFileSync(generatedTypes, "utf8");
    if (currentTypes !== originalTypes) {
      if (currentTypes !== originalTypes.replaceAll("./.next/types/", "./.next/dev/types/")) throw new Error("PILOT_CI_UNEXPECTED_GENERATED_TYPE_CHANGE");
      writeFileSync(generatedTypes, originalTypes);
    }
    summary.cleanup = true;
  } catch { summary.complete = false; summary.failedPhase ||= "cleanup"; process.exitCode = 1; }
  writeFileSync(summaryFile, JSON.stringify(summary, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  console.log("Sanitized pilot CI summary: " + summaryFile);
}

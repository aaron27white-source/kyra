import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
const gateNames = ["dependency-audit", "secret-scan", "sast"];
const commands = (job) => job.steps.map((step) => step.run ?? "").join("\n");

test("every pilot security gate is required before release validation", () => {
  for (const name of gateNames) {
    assert(workflow.jobs[name], `Missing CI job: ${name}`);
    assert(
      workflow.jobs.validate.needs.includes(name),
      `Release can bypass ${name}`,
    );
  }
  assert.equal(workflow.jobs.validate.if, "always()");
});

test("security scans fail closed on pull requests without provider credentials", () => {
  for (const name of gateNames) {
    const job = workflow.jobs[name];
    assert(job, `Missing CI job: ${name}`);
    assert(!job.if, `${name} is conditionally skipped`);
    assert(!job["continue-on-error"]);
    for (const step of job.steps) {
      assert(!step["continue-on-error"]);
      assert(!/\|\|\s*(?:true|:)/.test(step.run ?? ""));
    }
    assert(!JSON.stringify(job).includes("secrets."));
  }
});

test("production audit gates high/critical findings and excludes unused standalone Zapier", () => {
  const job = workflow.jobs["dependency-audit"];
  assert(job);
  assert.match(commands(job), /pnpm audit --prod --audit-level high/);
  assert(!commands(job).includes("--ignore"));
  assert(!commands(job).includes("npm audit --prefix integrations/zapier"));
  assert(!workflow.jobs.zapier, "Zapier is excluded from this pilot workflow");
  assert(!workflow.jobs.validate.needs.includes("zapier"));
});

test("inherited production migration requires explicit LMC deployment opt-in", () => {
  const job = workflow.jobs["migrate-production"];
  assert.match(job.if, /vars.LMC_ENABLE_PRODUCTION_DEPLOY == 'true'/);
  assert.equal(job.env.RAILWAY_PROJECT_ID, "${{ vars.LMC_RAILWAY_PROJECT_ID }}");
});

test("secret scanning includes complete history and redacts matches", () => {
  const job = workflow.jobs["secret-scan"];
  assert(job);
  const checkout = job.steps.find((step) =>
    step.uses?.startsWith("actions/checkout@"),
  );
  assert.equal(checkout?.with?.["fetch-depth"], 0);
  assert.match(commands(job), /gitleaks git/);
  assert.match(commands(job), /--redact=100/);
  assert.match(commands(job), /--log-opts=--all/);
  assert.match(commands(job), /verify-gitleaks-policy\.py/);
});

test("SAST uses security rules, disables telemetry and fails on findings", () => {
  const job = workflow.jobs.sast;
  assert(job);
  assert.match(commands(job), /semgrep scan/);
  assert.match(commands(job), /--config p\/security-audit/);
  assert.match(commands(job), /--metrics=off/);
  assert.match(commands(job), /--error/);
  assert.match(commands(job), /--strict/);
  assert.match(commands(job), /semgrep==\d+\.\d+\.\d+/);
});

test("database CI uses a dedicated login for trusted System work", () => {
  const env = workflow.jobs.database.env;
  assert(env.LOBBYSTACK_SYSTEM_DATABASE_URL, "Missing dedicated System URL");
  const url = new URL(env.LOBBYSTACK_SYSTEM_DATABASE_URL);
  assert.equal(url.username, "lobbystack_system");
  assert.equal(url.password, env.LOBBYSTACK_SYSTEM_PASSWORD);
  assert.equal(url.pathname, new URL(env.DATABASE_URL).pathname);
  assert.notEqual(
    env.LOBBYSTACK_SYSTEM_DATABASE_URL,
    env.LOBBYSTACK_APP_DATABASE_URL,
  );
});

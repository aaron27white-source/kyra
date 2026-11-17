import assert from "node:assert/strict";
import { test } from "node:test";
import { pilotAcceptanceContexts } from "../../scripts/pilot-ci-contexts.mjs";

const legacy = ["isolation-public-api", "isolation-worker-attach", "isolation-worker-attach-runner", "isolation-worker-health"].map(name => `tests/lmc/${name}.acceptance.ts`);
const exhaustive = "tests/lmc/isolation.acceptance.ts";
const auth = "tests/lmc/isolation-pilot-auth.acceptance.ts";
const other = "tests/lmc/tenant-setup.acceptance.ts";
const inventory = [...legacy, exhaustive, auth, other];

test("approved acceptance contexts retain every source exactly once and only four legacy cases disable pilot mode", () => {
  const contexts = pilotAcceptanceContexts(inventory);
  assert.equal(contexts.length, 4);
  assert.deepEqual(contexts.flatMap(context => context.files).sort(), inventory.toSorted());
  assert.deepEqual(contexts.filter(context => !context.pilot).flatMap(context => context.files).sort(), legacy.toSorted());
  assert.deepEqual(contexts.find(context => context.name === "exhaustive").files, [exhaustive]);
  assert.deepEqual(contexts.find(context => context.name === "auth").files, [auth]);
  assert.ok(contexts.filter(context => context.name !== "legacy").every(context => context.pilot));
});
test("new acceptance sources remain in the pilot cohort without an omission or mode exception", () => {
  const added = "tests/lmc/new-surface.acceptance.ts";
  const contexts = pilotAcceptanceContexts([...inventory, added]);
  assert.ok(contexts.find(context => context.name === "pilot").files.includes(added));
  assert.equal(contexts.flatMap(context => context.files).filter(file => file === added).length, 1);
});
test("missing mandatory auth, exhaustive or original legacy sources fail the context contract", () => {
  for (const missing of [...legacy, exhaustive, auth]) {
    assert.throws(() => pilotAcceptanceContexts(inventory.filter(file => file !== missing)), /PILOT_CI_CONTEXT_REQUIRED_SOURCE/);
  }
});
test("duplicate, malformed and empty inventories cannot weaken aggregate file coverage", () => {
  for (const files of [[...inventory, other], [...inventory, "../outside.acceptance.ts"], []]) {
    assert.throws(() => pilotAcceptanceContexts(files), /PILOT_CI_CONTEXT_/);
  }
});

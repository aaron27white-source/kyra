import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

test("production framework and sanitizer pins include the October 22 security fixes",async()=>{
  const admin=JSON.parse(await readFile(new URL("../../apps/admin/package.json",import.meta.url),"utf8"));
  const workspace=parse(await readFile(new URL("../../pnpm-workspace.yaml",import.meta.url),"utf8"));
  assert.equal(admin.dependencies.next,"16.4.1");
  assert.equal(admin.devDependencies["@next/eslint-plugin-next"],"16.4.1");
  assert.equal(workspace.overrides.dompurify,"3.4.17");
});

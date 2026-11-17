import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { verifyPilotStatic } from "./verify-pilot-static.mjs";

const source=fileURLToPath(new URL("../dist",import.meta.url));
test("published pilot artifact has six pages, two remaining placeholder pages and preserved attribution",async()=>{
  const report=await verifyPilotStatic(source);
  assert.equal(report.pages,6);assert.equal(report.placeholderPages,2);assert.equal(report.requiredAttributions,4);
  assert.equal(report.scripts,0);assert.equal(report.serverFiles,0);assert.equal(report.externalRequests,0);
});

for(const [name,mutate,reason] of [
  ["an inherited article",async root=>{await mkdir(join(root,"blog/old"),{recursive:true});await writeFile(join(root,"blog/old/index.html"),"Old article");},/UNEXPECTED_PUBLIC_PAGE_INVENTORY/],
  ["a server function",async root=>{await mkdir(join(root,"functions"));await writeFile(join(root,"functions/index.js"),"export default {};");},/SERVER_OR_PRIVATE_DIRECTORY/],
  ["JavaScript",async root=>writeFile(join(root,"unexpected.js"),"void 0;"),/UNEXPECTED_STATIC_FILE/],
  // Intentional rejected payload in an unserved temporary copy; assert.rejects below proves denial.
  // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
  ["inline scripts",async root=>{const file=join(root,"index.html");await writeFile(file,(await readFile(file,"utf8")).replace("</head>","<script>void 0;</script></head>"));},/ACTIVE_PUBLIC_ELEMENT/],
  ["inline styles blocked by CSP",async root=>{const file=join(root,"index.html");await writeFile(file,(await readFile(file,"utf8")).replace("</head>","<style>body{color:red}</style></head>"));},/ACTIVE_PUBLIC_ELEMENT/],
  ["inherited company claims",async root=>{const file=join(root,"index.html");await writeFile(file,(await readFile(file,"utf8"))+"LobbyStack");},/INHERITED_PUBLIC_TEXT/],
  ["external images",async root=>{const file=join(root,"index.html");await writeFile(file,(await readFile(file,"utf8")).replace("/brand/lmc-logo.svg","https://example.invalid/logo.svg"));},/EXTERNAL_STATIC_REFERENCE/],
  ["removed placeholders",async root=>{const file=join(root,"contact/index.html");await writeFile(file,(await readFile(file,"utf8")).replaceAll("[FILL]","Example"));},/MISSING_LMC_PLACEHOLDER/],
  ["unresolved legal placeholder",async root=>{const file=join(root,"terms/index.html");await writeFile(file,(await readFile(file,"utf8")).replace("Terms and Conditions","[FILL]"));},/UNRESOLVED_LEGAL_PLACEHOLDER/],
  ["missing required SMS disclosure",async root=>{const file=join(root,"privacy/index.html");await writeFile(file,(await readFile(file,"utf8")).replaceAll("STOP","REMOVED"));},/MISSING_LEGAL_DISCLOSURE/],
  ["changed license notices",async root=>writeFile(join(root,"attributions/NOTICE.txt"),"Changed notice"),/ALTERED_REQUIRED_ATTRIBUTION/],
  ["changed font bytes",async root=>writeFile(join(root,"fonts/geist-latin-wght-normal.woff2"),"Changed font"),/ALTERED_LOCAL_FONT/],
])test(`rejects ${name} in the deployable directory`,async()=>{
  const directory=await mkdtemp(join(tmpdir(),"lmc-static-gate-"));
  try{await cp(source,directory,{recursive:true});await mutate(directory);await assert.rejects(verifyPilotStatic(directory),reason);}
  finally{
    if(dirname(resolve(directory))!==resolve(tmpdir())||!basename(directory).startsWith("lmc-static-gate-"))throw new Error("UNSAFE_STATIC_TEST_CLEANUP");
    await rm(directory,{recursive:true,force:true});
  }
});

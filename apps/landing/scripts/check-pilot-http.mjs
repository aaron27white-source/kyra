import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyPilotStatic } from "./verify-pilot-static.mjs";

const base=new URL(process.argv[2]??"http://127.0.0.1:4321");
if(base.protocol!=="http:"||!["localhost","127.0.0.1","[::1]"].includes(base.hostname)||base.username||base.password||base.pathname!=="/"||base.search||base.hash)throw new Error("LOCAL_STATIC_PREVIEW_REQUIRED");
const root=fileURLToPath(new URL("../dist",import.meta.url));
const artifact=await verifyPilotStatic(root);
const files=[];
async function walk(folder){for(const entry of await readdir(folder,{withFileTypes:true})){const path=join(folder,entry.name);if(entry.isDirectory())await walk(path);else files.push(relative(root,path).split(sep).join("/"));}}
await walk(root);
let positive=0,retired=0;
for(const file of files.filter(file=>!["_headers","_redirects"].includes(file))){
  const path=file==="index.html"?"/":file.endsWith("/index.html")?`/${file.slice(0,-10)}`:`/${file}`;
  const expected=await readFile(join(root,file));
  for(const method of ["GET","HEAD"]){
    const response=await fetch(new URL(path,base),{method,redirect:"manual",signal:AbortSignal.timeout(10000)});
    assert.equal(response.status,200,`STATIC_HTTP_STATUS:${method}:${path}`);
    const body=Buffer.from(await response.arrayBuffer());
    if(method==="GET")assert.ok(body.equals(expected),`STATIC_HTTP_BYTES:${path}`);else assert.equal(body.length,0,`STATIC_HTTP_HEAD_BODY:${path}`);
    positive++;
  }
}
for(const path of ["/blog/","/blog/lobbystack-is-live/","/pricing/","/features/","/solutions/","/fr/","/api/status","/openapi.json","/webmcp.js","/.well-known/api-catalog","/lobbystack-logo.svg","/screenshots/dashboard.webp"]){
  for(const method of ["GET","HEAD"]){
    const response=await fetch(new URL(path,base),{method,redirect:"manual",signal:AbortSignal.timeout(10000)});
    assert.equal(response.status,404,`RETIRED_PUBLIC_ROUTE:${method}:${path}`);
    await response.arrayBuffer();retired++;
  }
}
console.log(JSON.stringify({status:"passed",pages:artifact.pages,positiveGetHead:positive,retiredGetHead:retired,artifactBytesVerified:true,productionHostHeaders:"separate staging verification required"}));

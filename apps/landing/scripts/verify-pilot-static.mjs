import { lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "parse5";

export const pilotPages = ["404.html","contact/index.html","cookie-policy/index.html","index.html","privacy/index.html","terms/index.html"];
const attributionFiles = new Map([["attributions/LICENSE.txt","LICENSE"],["attributions/NOTICE.txt","NOTICE"],["attributions/THIRD_PARTY_NOTICES.txt","THIRD_PARTY_NOTICES.md"],["attributions/GEIST-OFL.txt","apps/admin/node_modules/@fontsource-variable/geist/LICENSE"]]);
const upstream = /lobbystack|kyra|key 20 consultations|app\.cal\.com|cal\.com\/|posthog|cloudflareinsights|pravatar|unsplash|30 browser voice minutes|unlimited concurrent calls|24\/7|free trial/i;
const site = "https://leadmycompany.com";
const app = "https://app.leadmycompany.com/en/login";

function fail(code){throw new Error(code);}
function walkNodes(node,visit){visit(node);for(const child of node.childNodes??[])walkNodes(child,visit);if(node.content)walkNodes(node.content,visit);}
const htmlPath = pathname => pathname==="/"?"index.html":pathname.endsWith("/")?`${pathname.slice(1)}index.html`:pathname.slice(1);

export async function verifyPilotStatic(directory=resolve(fileURLToPath(new URL("../dist",import.meta.url)))){
  const root=resolve(directory),repo=resolve(fileURLToPath(new URL("../../../",import.meta.url)));
  const files=[];
  async function walk(folder){
    for(const name of (await readdir(folder)).sort()){
      const path=join(folder,name),info=await lstat(path),label=relative(root,path).split(sep).join("/");
      if(info.isSymbolicLink())fail(`SYMLINK_IN_STATIC_ARTIFACT:${label}`);
      if(info.isDirectory()){
        if(name.startsWith(".")||["functions","server","node_modules","src"].includes(name))fail(`SERVER_OR_PRIVATE_DIRECTORY:${label}`);
        await walk(path);continue;
      }
      if(!info.isFile())fail(`NON_FILE_IN_STATIC_ARTIFACT:${label}`);
      if(!/\.(?:html|css|svg|woff2?|txt)$/.test(name)&&!["_headers","_redirects"].includes(name))fail(`UNEXPECTED_STATIC_FILE:${label}`);
      if(upstream.test(label))fail(`INHERITED_ASSET_NAME:${label}`);
      files.push(label);
    }
  }
  await walk(root);
  const html=files.filter(file=>file.endsWith(".html")).sort();
  if(JSON.stringify(html)!==JSON.stringify([...pilotPages].sort()))fail("UNEXPECTED_PUBLIC_PAGE_INVENTORY");
  const fileSet=new Set(files);
  const publicFiles=new Set(["_headers","_redirects","robots.txt","favicon.svg","brand/lmc-logo.svg","fonts/geist-latin-wght-normal.woff2",...attributionFiles.keys()]);
  for(const file of files)if(!pilotPages.includes(file)&&!publicFiles.has(file)&&!/^_astro\/[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.css$/.test(file))fail(`UNDECLARED_STATIC_ASSET:${file}`);
  if(!(await readFile(join(root,"fonts/geist-latin-wght-normal.woff2"))).equals(await readFile(join(repo,"apps/admin/node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2"))))fail("ALTERED_LOCAL_FONT");
  for(const [path,source] of attributionFiles){
    if(!fileSet.has(path))fail(`MISSING_REQUIRED_ATTRIBUTION:${path}`);
    if(!(await readFile(join(root,path))).equals(await readFile(join(repo,source))))fail(`ALTERED_REQUIRED_ATTRIBUTION:${path}`);
  }
  function localReference(value,from,allowApp=false){
    if(!value||value.startsWith("#"))return;
    let url;
    try{url=new URL(value,new URL(from==="index.html"?"/":`/${from}`,site));}catch{fail(`INVALID_STATIC_REFERENCE:${from}`);}
    if(allowApp&&url.href===app)return;
    if(url.origin!==site||url.username||url.password)fail(`EXTERNAL_STATIC_REFERENCE:${from}`);
    const target=htmlPath(decodeURIComponent(url.pathname));
    if(!fileSet.has(target))fail(`MISSING_STATIC_REFERENCE:${from}:${target}`);
  }
  let placeholderPages=0;
  for(const file of files){
    if(attributionFiles.has(file)||/\.woff2?$/.test(file))continue;
    const text=await readFile(join(root,file),"utf8");
    if(upstream.test(text))fail(`INHERITED_PUBLIC_TEXT:${file}`);
    if(/DATABASE_URL|postgres(?:ql)?:|REDIS_URL|GOOGLE_CLIENT_SECRET|RESEND_API_KEY|OPENAI_API_KEY/.test(text))fail(`RUNTIME_CONFIGURATION_IN_STATIC_ARTIFACT:${file}`);
    if(file.endsWith(".css")){
      for(const match of text.matchAll(/url\(\s*["']?([^\s)"']+)/g)){
        if(match[1].startsWith("data:"))continue;
        localReference(match[1],file);
      }
    }
    if(file.endsWith(".svg"))walkNodes(parse(text),node=>{
      if(["script","style","iframe","foreignObject","foreignobject","image","use"].includes(node.tagName))fail(`ACTIVE_SVG_ELEMENT:${file}`);
      for(const attr of node.attrs??[])if(/^on/i.test(attr.name)||["href","src","style"].includes(attr.name))fail(`ACTIVE_SVG_ATTRIBUTE:${file}`);
    });
    if(!file.endsWith(".html"))continue;
    const doc=parse(text);
    let h1=0,noindex=false,csp=false;
    walkNodes(doc,node=>{
      if(node.tagName==="h1")h1++;
      if(["script","style","iframe","form","object","embed"].includes(node.tagName))fail(`ACTIVE_PUBLIC_ELEMENT:${file}`);
      for(const attr of node.attrs??[]){
        if(/^on/i.test(attr.name)||["srcdoc","style"].includes(attr.name))fail(`ACTIVE_PUBLIC_ATTRIBUTE:${file}`);
        if(["href","src"].includes(attr.name))localReference(attr.value,file,node.tagName==="a"&&attr.name==="href");
      }
      const attrs=Object.fromEntries((node.attrs??[]).map(attr=>[attr.name,attr.value]));
      if(node.tagName==="meta"&&attrs.name==="robots"&&attrs.content?.includes("noindex"))noindex=true;
      if(node.tagName==="meta"&&attrs["http-equiv"]?.toLowerCase()==="content-security-policy"&&attrs.content?.includes("script-src 'none'")&&attrs.content?.includes("connect-src 'none'")&&attrs.content?.includes("form-action 'none'"))csp=true;
    });
    if(h1!==1||!noindex||!csp)fail(`MISSING_PILOT_PAGE_CONTROL:${file}`);
    if(["contact/index.html","cookie-policy/index.html"].includes(file)){
      if(!text.includes("[FILL]"))fail(`MISSING_LMC_PLACEHOLDER:${file}`);
      placeholderPages++;
    }
    if(["privacy/index.html","terms/index.html"].includes(file)){
      if(text.includes("[FILL]"))fail(`UNRESOLVED_LEGAL_PLACEHOLDER:${file}`);
      for(const required of ["BONSES INOVA SIMPLES (I.S.)","68.814.207/0001-33","joao@leadmycompany.com","STOP","HELP"]){
        if(!text.includes(required))fail(`MISSING_LEGAL_DISCLOSURE:${file}:${required}`);
      }
    }
  }
  const headers=await readFile(join(root,"_headers"),"utf8"),robots=await readFile(join(root,"robots.txt"),"utf8");
  if(!headers.includes("script-src 'none'")||!headers.includes("frame-ancestors 'none'")||!headers.includes("X-Content-Type-Options: nosniff"))fail("MISSING_STATIC_HOST_HEADERS");
  if(!robots.includes("Disallow: /"))fail("PILOT_INDEXING_NOT_DISABLED");
  return {status:"passed",pages:html.length,files:files.length,placeholderPages,requiredAttributions:attributionFiles.size,serverFiles:0,scripts:0,externalRequests:0};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  verifyPilotStatic(process.argv[2]).then(report=>console.log(JSON.stringify(report))).catch(error=>{console.error(error.message);process.exitCode=1;});
}

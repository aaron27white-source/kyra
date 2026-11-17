import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FakeLmcInboundProvider } from "./lmc-fake-inbound";

describe("network-free inbound provider",()=>{
  it("authenticates opaque event references and never trusts authentication from the request body",async()=>{
    const provider=new FakeLmcInboundProvider({env:{NODE_ENV:"test"}});
    const event={kind:"message",id:randomUUID(),email:{from:"ana@example.invalid",to:"reply+token@example.invalid",text:"Roof repair",subject:"Roof",headers:{},authentication:{spf:"pass",dkim:"pass",dmarc:"pass",aligned:true},attachments:[]}};
    const prepared=provider.prepare(event);
    expect(prepared.rawBody).not.toContain("authentication");
    const delivery={rawBody:prepared.rawBody,headers:new Headers(prepared.headers)};
    expect(await provider.verifyAndLoad(delivery)).toMatchObject(event);
    expect(await provider.verifyAndLoad(delivery)).toMatchObject(event);
    await expect(provider.verifyAndLoad({...delivery,rawBody:JSON.stringify(event)})).rejects.toThrow("INVALID_WEBHOOK_SIGNATURE");
  });
  it("refuses production and explicit real-provider modes",()=>{
    expect(()=>new FakeLmcInboundProvider({env:{NODE_ENV:"production"}})).toThrow();
    expect(()=>new FakeLmcInboundProvider({env:{LMC_PROVIDER_MODE:"real"}})).toThrow();
  });
});

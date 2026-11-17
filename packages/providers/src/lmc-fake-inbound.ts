import { loadLmcTestInboundFixture } from "./lmc-test-inbound-fixture";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { lmcProviderEventSchema, type LmcInboundProvider, type LmcProviderEvent } from "@lobbystack/contracts";
import { verifyResendWebhookSignature } from "./email/webhook";
import { lmcProviderMode } from "./lmc-fakes";

/** External-provider substitute only: events are registered server-side, never supplied as trusted HTTP JSON. */
export class FakeLmcInboundProvider implements LmcInboundProvider {
  private readonly events=new Map<string,LmcProviderEvent>();
  private readonly fixtureReferences=new Set<string>();
  private readonly secret=randomBytes(32);
  private readonly now:()=>number;
  private readonly fixtureFile:string|undefined;
  private readonly fixtureEnvironment:Record<string,string|undefined>;
  constructor(options:{env?:Record<string,string|undefined>;now?:()=>number}={}){
    if(lmcProviderMode(options.env)!=="fake")throw new Error("FAKE_PROVIDER_MODE_REQUIRED");
    this.now=options.now??Date.now;
    this.fixtureEnvironment=options.env??process.env;
    this.fixtureFile=this.fixtureEnvironment.LMC_FAKE_INBOUND_FIXTURE_FILE;
    if(this.fixtureFile){
      const fixture=loadLmcTestInboundFixture(this.fixtureFile,this.fixtureEnvironment);
      this.secret=fixture.secret;
      for(const [key,event] of fixture.events){this.events.set(key,event);this.fixtureReferences.add(key);}
    }
  }
  prepare(event:unknown):{rawBody:string;headers:Record<string,string>}{
    const reference=randomUUID(),id=`fake_${reference}`,timestamp=String(Math.floor(this.now()/1_000));
    this.events.set(reference,structuredClone(lmcProviderEventSchema.parse(event)));
    const rawBody=JSON.stringify({reference});
    const signature=createHmac("sha256",this.secret).update(`${id}.${timestamp}.${rawBody}`).digest("base64");
    return{rawBody,headers:{"svix-id":id,"svix-timestamp":timestamp,"svix-signature":`v1,${signature}`}};
  }
  async verifyAndLoad(input:{rawBody:string;headers:Headers}):Promise<LmcProviderEvent|null>{
    if(!verifyResendWebhookSignature(input.rawBody,{id:input.headers.get("svix-id")??"",timestamp:input.headers.get("svix-timestamp")??"",signature:input.headers.get("svix-signature")??""},`whsec_${this.secret.toString("base64")}`,this.now()))throw new Error("INVALID_WEBHOOK_SIGNATURE");
    if(this.fixtureFile){
      const fixture=loadLmcTestInboundFixture(this.fixtureFile,this.fixtureEnvironment);
      if(!this.secret.equals(fixture.secret))throw new Error("LMC_FAKE_FIXTURE_KEY_CHANGED");
      for(const key of this.fixtureReferences)this.events.delete(key);
      this.fixtureReferences.clear();
      for(const [key,event] of fixture.events){this.events.set(key,event);this.fixtureReferences.add(key);}
    }
    const parsed=JSON.parse(input.rawBody) as {reference?:unknown};
    const event=typeof parsed.reference==="string"?this.events.get(parsed.reference):undefined;
    return event?structuredClone(event):null;
  }
}

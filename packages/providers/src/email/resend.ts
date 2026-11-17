import { lmcProviderEventSchema, type LmcEmailTransport, type LmcInboundProvider, type LmcOutboundEmail, type LmcProviderEvent } from "@lobbystack/contracts";
import { validateLmcOutboundEmail } from "../lmc-fakes";
import { verifyResendWebhookSignature } from "./webhook";

const record=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:null;
const uuid=(value:unknown):value is string=>typeof value==="string"&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
type Options={apiKey:string;webhookSecret:string;fetch?:typeof fetch;now?:()=>number};

/** Real adapter is constructed explicitly; importing it never makes a network request. */
export class ResendLmcProvider implements LmcEmailTransport,LmcInboundProvider {
  private readonly fetcher:typeof fetch;
  constructor(private readonly options:Options){
    if(!/^re_[A-Za-z0-9_-]{8,}$/.test(options.apiKey)||!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(options.webhookSecret)||Buffer.from(options.webhookSecret.slice(6),"base64").length<16)throw new Error("RESEND_CONFIGURATION_REQUIRED");
    this.fetcher=options.fetch??globalThis.fetch;
  }

  async send(message:LmcOutboundEmail):Promise<{providerMessageId:string}>{
    validateLmcOutboundEmail(message);
    if(!uuid(message.tenantId)||!uuid(message.leadId))throw new Error("INVALID_OUTBOUND_EMAIL");
    const result=record(await this.api("/emails",{method:"POST",headers:{"Idempotency-Key":message.idempotencyKey},body:JSON.stringify({
      from:message.from,to:[message.to],reply_to:message.replyTo,subject:message.subject,text:message.text,headers:message.headers,tags:[{name:"lmc_tenant",value:message.tenantId}],
    })}));
    if(!uuid(result?.id))throw new Error("EMAIL_PROVIDER_UNAVAILABLE");
    return{providerMessageId:result.id};
  }

  async verifyAndLoad(input:{rawBody:string;headers:Headers}):Promise<LmcProviderEvent|null>{
    const id=input.headers.get("svix-id")??"";
    if(Buffer.byteLength(input.rawBody,"utf8")>65_536||!verifyResendWebhookSignature(input.rawBody,{id,timestamp:input.headers.get("svix-timestamp")??"",signature:input.headers.get("svix-signature")??""},this.options.webhookSecret,this.options.now?.()))throw new Error("INVALID_WEBHOOK_SIGNATURE");
    let envelope:Record<string,unknown>|null;
    try{envelope=record(JSON.parse(input.rawBody));}catch{throw new Error("INVALID_PROVIDER_PAYLOAD");}
    const data=record(envelope?.data);
    if(!envelope||!data||typeof envelope.type!=="string")throw new Error("INVALID_PROVIDER_PAYLOAD");
    if(envelope.type==="email.received"){
      if(!uuid(data.email_id))throw new Error("INVALID_PROVIDER_PAYLOAD");
      const received=record(await this.api(`/emails/receiving/${data.email_id}`,{method:"GET"}));
      if(!received||received.id!==data.email_id||!Array.isArray(received.to)||received.to.length!==1)throw new Error("INVALID_PROVIDER_PAYLOAD");
      const authentication=record(received.authentication);
      const passed=authentication?.spf==="pass"&&authentication.dkim==="pass"&&authentication.dmarc==="pass";
      // Trust only the receiving API's computed verdicts. Message headers are never an auth source.
      const email={from:received.from,to:received.to[0],subject:received.subject,text:received.text??undefined,html:received.html??undefined,headers:{...(record(received.headers)??{}),...(typeof received.message_id==="string"?{"Message-ID":received.message_id}:{})},
        authentication:{spf:authentication?.spf==="pass"?"pass":"none",dkim:authentication?.dkim==="pass"?"pass":"none",dmarc:authentication?.dmarc==="pass"?"pass":"none",aligned:passed},attachments:received.attachments??[]};
      const parsed=lmcProviderEventSchema.safeParse({kind:"message",id:`resend:${data.email_id}`,email});
      if(!parsed.success)throw new Error("INVALID_PROVIDER_PAYLOAD");
      return parsed.data;
    }
    if(envelope.type==="email.bounced"||envelope.type==="email.complained"){
      const tags=record(data.tags);
      if(!uuid(tags?.lmc_tenant)||!uuid(data.email_id)||!Array.isArray(data.to)||data.to.length!==1)throw new Error("INVALID_PROVIDER_PAYLOAD");
      const parsed=lmcProviderEventSchema.safeParse({kind:"suppression",id:`resend:${id}`,tenantId:tags.lmc_tenant,providerMessageId:data.email_id,email:data.to[0],reason:envelope.type==="email.bounced"?"bounce":"complaint"});
      if(!parsed.success)throw new Error("INVALID_PROVIDER_PAYLOAD");
      return parsed.data;
    }
    return null;
  }

  private async api(path:string,init:RequestInit):Promise<unknown>{
    try{
      const response=await this.fetcher(`https://api.resend.com${path}`,{...init,headers:{Authorization:`Bearer ${this.options.apiKey}`,"Content-Type":"application/json",...init.headers},redirect:"error",signal:AbortSignal.timeout(10_000)});
      if(!response.ok||!response.body)throw new Error("EMAIL_PROVIDER_UNAVAILABLE");
      const reader=response.body.getReader(),chunks:Uint8Array[]=[];
      let size=0;
      try{
        while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>262_144){await reader.cancel();throw new Error("EMAIL_PROVIDER_UNAVAILABLE");}chunks.push(part.value);}
      }finally{reader.releaseLock();}
      return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks)));
    }catch{throw new Error("EMAIL_PROVIDER_UNAVAILABLE");}
  }
}

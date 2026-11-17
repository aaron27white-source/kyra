import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ResendLmcProvider } from "./resend";

const secret=`whsec_${Buffer.from("test-only-resend-webhook-key-123456").toString("base64")}`;
const apiKey="re_test_only_not_a_credential";
function signed(body:unknown,overrides:Record<string,string>={}){
  const rawBody=JSON.stringify(body),id=`msg_${randomUUID()}`,timestamp=String(Math.floor(Date.now()/1_000));
  const signature=createHmac("sha256",Buffer.from(secret.slice(6),"base64")).update(`${id}.${timestamp}.${rawBody}`).digest("base64");
  return {rawBody,headers:new Headers({"svix-id":id,"svix-timestamp":timestamp,"svix-signature":`v1,${signature}`,...overrides})};
}
function received(id:string,authentication:unknown={spf:"pass",dkim:"pass",dmarc:"pass"}){
  return {id,from:"ana@example.invalid",to:["reply+AbCd@inbound.example.invalid"],subject:"Roof",text:"ZIP 33101",html:null,message_id:"<incoming@example.invalid>",headers:{"in-reply-to":"<outgoing@example.invalid>","authentication-results":"attacker; spf=pass; dkim=pass; dmarc=pass"},authentication,attachments:[]};
}
describe("Resend LMC adapter",()=>{
  it("verifies exact signed bytes before fetching the received email from a fixed API origin",async()=>{
    const id=randomUUID(),fetcher=vi.fn<typeof fetch>(async()=>Response.json(received(id)));
    const provider=new ResendLmcProvider({apiKey,webhookSecret:secret,fetch:fetcher});
    const input=signed({type:"email.received",data:{email_id:id}});
    expect(await provider.verifyAndLoad(input)).toMatchObject({kind:"message",id:`resend:${id}`,email:{to:"reply+AbCd@inbound.example.invalid",authentication:{spf:"pass",dkim:"pass",dmarc:"pass",aligned:true}}});
    expect(fetcher).toHaveBeenCalledWith(`https://api.resend.com/emails/receiving/${id}`,expect.objectContaining({redirect:"error",headers:expect.objectContaining({Authorization:`Bearer ${apiKey}`})}));
    await expect(provider.verifyAndLoad({...input,rawBody:input.rawBody+" "})).rejects.toThrow("INVALID_WEBHOOK_SIGNATURE");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([null,{spf:"pass",dkim:"gray",dmarc:"pass"},{spf:"unknown",dkim:"pass",dmarc:"pass"}])("does not promote missing or nonpassing trusted authentication: %j",async authentication=>{
    const id=randomUUID(),provider=new ResendLmcProvider({apiKey,webhookSecret:secret,fetch:vi.fn<typeof fetch>(async()=>Response.json(received(id,authentication)))});
    const event=await provider.verifyAndLoad(signed({type:"email.received",data:{email_id:id}}));
    expect(event).toMatchObject({kind:"message",email:{authentication:{aligned:false}}});
  });
  it("rejects unsupported signature versions, stale attempts and recipient ambiguity without fetching",async()=>{
    const fetcher=vi.fn<typeof fetch>(async()=>Response.json({})),provider=new ResendLmcProvider({apiKey,webhookSecret:secret,fetch:fetcher});
    const event=signed({type:"email.received",data:{email_id:randomUUID()}});
    for(const signature of [event.headers.get("svix-signature")!.replace("v1,","v2,"),event.headers.get("svix-signature")!.slice(3)]){
      await expect(provider.verifyAndLoad({...event,headers:new Headers({...Object.fromEntries(event.headers),"svix-signature":signature})})).rejects.toThrow("INVALID_WEBHOOK_SIGNATURE");
    }
    await expect(provider.verifyAndLoad(signed({type:"email.received",data:{email_id:"https://internal.invalid"}}))).rejects.toThrow("INVALID_PROVIDER_PAYLOAD");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("maps signed bounce tags to a routed suppression event; irrelevant events do no network work",async()=>{
    const fetcher=vi.fn(),provider=new ResendLmcProvider({apiKey,webhookSecret:secret,fetch:fetcher}),tenantId=randomUUID(),id=randomUUID();
    expect(await provider.verifyAndLoad(signed({type:"email.bounced",data:{email_id:id,to:["ana@example.invalid"],tags:{lmc_tenant:tenantId}}}))).toMatchObject({kind:"suppression",tenantId,email:"ana@example.invalid",providerMessageId:id,reason:"bounce"});
    expect(await provider.verifyAndLoad(signed({type:"email.delivered",data:{email_id:id}}))).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("sends only the stored recipient with an idempotency key, tenant tag and same-thread headers",async()=>{
    const id=randomUUID(),fetcher=vi.fn<typeof fetch>(async()=>Response.json({id})),provider=new ResendLmcProvider({apiKey,webhookSecret:secret,fetch:fetcher});
    const tenantId=randomUUID();
    const mail={tenantId,leadId:randomUUID(),idempotencyKey:"lmc:message-1",kind:"reply" as const,from:"team@example.invalid",to:"ana@example.invalid",replyTo:"reply+AbCd@inbound.example.invalid",subject:"Re: Roof",text:"What is your ZIP?",headers:{"Message-ID":"<outgoing@example.invalid>","In-Reply-To":"<incoming@example.invalid>"}};
    expect(await provider.send(mail)).toEqual({providerMessageId:id});
    expect(fetcher).toHaveBeenCalledWith("https://api.resend.com/emails",expect.objectContaining({method:"POST",headers:expect.objectContaining({"Idempotency-Key":"lmc:message-1"})}));
    const init=fetcher.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({from:mail.from,to:[mail.to],reply_to:mail.replyTo,subject:mail.subject,text:mail.text,headers:mail.headers,tags:[{name:"lmc_tenant",value:tenantId}]});
    await expect(provider.send({...mail,headers:{...mail.headers,Bcc:"intruder@example.invalid"}})).rejects.toThrow("INVALID_OUTBOUND_EMAIL");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

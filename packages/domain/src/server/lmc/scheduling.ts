import { and, eq } from "drizzle-orm";
import { DateTime } from "luxon";
import { lmcBookingRulesSchema } from "@lobbystack/contracts";
import { businesses, businessHours, lmcSettings, services, withBusinessTransaction, type Database } from "@lobbystack/db";
import { findEmailAvailabilityInTransaction } from "../booking";
import { candidateStartTimes } from "../receptionistActions";

export async function listEmailVisitSlots(database:Database,input:{tenantId:string;serviceId:string;now:Date;requestedDate?:string;excludeStartsAt?:string[]}){
  const loaded=await withBusinessTransaction(database,{businessId:input.tenantId,actorType:"worker"},async tx=>{
    const [business]=await tx.select({timezone:businesses.timezone}).from(businesses).where(eq(businesses.id,input.tenantId)).limit(1);
    const [service]=await tx.select({duration:services.durationMinutes}).from(services).where(and(eq(services.businessId,input.tenantId),eq(services.id,input.serviceId),eq(services.active,true))).limit(1);
    const hours=await tx.select().from(businessHours).where(eq(businessHours.businessId,input.tenantId));
    const [settings]=await tx.select({config:lmcSettings.config}).from(lmcSettings).where(eq(lmcSettings.tenantId,input.tenantId)).limit(1);
    return {business,service,hours,settings};
  });
  if(!loaded.business||!loaded.service)return [];
  const rules=lmcBookingRulesSchema.safeParse(loaded.settings?.config.bookingRules??{});
  if(!rules.success)return [];
  const slots:Awaited<ReturnType<typeof findEmailAvailabilityInTransaction>>=[];
  const localNow=DateTime.fromJSDate(input.now,{zone:loaded.business.timezone});
  if(input.requestedDate){
    const requested=DateTime.fromISO(input.requestedDate,{zone:loaded.business.timezone});
    if(!requested.isValid||requested.toISODate()!==input.requestedDate||requested.startOf("day")<localNow.startOf("day")||requested.startOf("day")>=localNow.plus({days:rules.data.horizonDays}).startOf("day"))return [];
  }
  const excluded=new Set(input.excludeStartsAt??[]);
  for(let day=0;day<(input.requestedDate?1:rules.data.horizonDays)&&slots.length<3;day++){
    const date=input.requestedDate??localNow.plus({days:day}).toISODate();if(!date)break;
    const candidates=candidateStartTimes({date,timezone:loaded.business.timezone,hours:loaded.hours,durationMinutes:loaded.service.duration,now:new Date(input.now.getTime()+rules.data.minimumNoticeMinutes*60_000)});
    for(const startsAt of candidates){
      if(excluded.has(startsAt))continue;
      const available=await withBusinessTransaction(database,{businessId:input.tenantId,actorType:"worker"},tx=>findEmailAvailabilityInTransaction(tx,{businessId:input.tenantId,serviceId:input.serviceId,startsAt,now:input.now}));
      if(available[0])slots.push(available[0]);
      if(slots.length>=3)break;
    }
  }
  return slots;
}

/** Human-readable English local time; never serialize UTC timestamps to a lead. */
export function formatEmailVisitTime(startsAt:string,timezone:string):string{
  const instant=DateTime.fromISO(startsAt,{setZone:true});
  if(!instant.isValid||!DateTime.now().setZone(timezone).isValid)throw new Error("INVALID_BUSINESS_TIMEZONE");
  const parts=new Intl.DateTimeFormat("en-US",{timeZone:timezone,weekday:"long",month:"long",day:"numeric",hour:"numeric",minute:"2-digit",hourCycle:"h12",timeZoneName:"long"}).formatToParts(instant.toJSDate());
  const part=(type:Intl.DateTimeFormatPartTypes)=>parts.find(item=>item.type===type)?.value??"";
  return `${part("weekday")}, ${part("month")} ${part("day")} at ${part("hour")}:${part("minute")} ${part("dayPeriod")} ${part("timeZoneName")}`;
}

export function formatEmailVisitDate(date:string,timezone:string):string{
  const local=DateTime.fromISO(date,{zone:timezone});
  if(!local.isValid||local.toISODate()!==date)throw new Error("INVALID_BUSINESS_TIMEZONE");
  return local.toFormat("LLLL d",{locale:"en-US"});
}

export function emailVisitLocalDate(startsAt:string,timezone:string):string{
  const local=DateTime.fromISO(startsAt,{setZone:true}).setZone(timezone);
  if(!local.isValid)throw new Error("INVALID_BUSINESS_TIMEZONE");
  return local.toISODate()!;
}

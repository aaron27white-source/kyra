import { DateTime } from "luxon";

const months = "january|february|march|april|may|june|july|august|september|october|november|december";
const shortMonths = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec";

/** Parse only explicit, unambiguous local calendar dates; never guess a time of day. */
export function requestedLocalDate(text:string,now:Date,timezone:string):string|undefined{
  const localNow=DateTime.fromJSDate(now,{zone:timezone});
  if(!localNow.isValid)return undefined;
  const named=text.match(new RegExp(`\\b(${months}|${shortMonths})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`,"i"));
  const numeric=text.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/);
  let candidate:DateTime|undefined;
  if(named){
    const monthName=named[1]!.toLowerCase().replace(/\.$/,"");
    const monthIndex=["january","february","march","april","may","june","july","august","september","october","november","december"].findIndex(month=>month.startsWith(monthName));
    if(monthIndex<0)return undefined;
    let year=named[3]?Number(named[3]):localNow.year;
    candidate=DateTime.fromObject({year,month:monthIndex+1,day:Number(named[2])},{zone:timezone});
    if(!named[3]&&candidate.isValid&&candidate.startOf("day")<localNow.startOf("day")){
      year++;
      candidate=DateTime.fromObject({year,month:monthIndex+1,day:Number(named[2])},{zone:timezone});
    }
  }else if(numeric){
    const rawYear=numeric[3];
    let year=rawYear?Number(rawYear):localNow.year;
    if(rawYear&&rawYear.length===2)year+=year>=70?1900:2000;
    candidate=DateTime.fromObject({year,month:Number(numeric[1]),day:Number(numeric[2])},{zone:timezone});
    if(!rawYear&&candidate.isValid&&candidate.startOf("day")<localNow.startOf("day"))candidate=candidate.plus({years:1});
  }else{
    const relative=text.match(/\b(tomorrow|today)\b/i);
    if(relative)candidate=localNow.plus({days:relative[1]!.toLowerCase()==="tomorrow"?1:0});
    else{
      const weekday=text.match(/\b(?:next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
      if(weekday){
        const weekdays=["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
        const wanted=weekdays.indexOf(weekday[1]!.toLowerCase());
        let days=(wanted-localNow.weekday%7+7)%7;
        if(days===0||/^next\s/i.test(weekday[0]))days=days===0?7:days+7;
        candidate=localNow.plus({days});
      }
    }
  }
  return candidate?.isValid?candidate.toISODate()??undefined:undefined;
}

export function isAlternativeAvailabilityRequest(text:string):boolean{
  return /\b(?:none|neither|these|those)\b.{0,80}\b(?:work|fit|suit|available)\b/i.test(text)
    || /\b(?:another|different|alternative)\s+(?:date|day|time|slot)\b/i.test(text)
    || /\b(?:do|would|could)\s+(?:you|u|you guys|u guys)\s+(?:have|work|do)\b/i.test(text)
    || /\b(?:are you|are y'all)\s+(?:open|available)\b/i.test(text);
}

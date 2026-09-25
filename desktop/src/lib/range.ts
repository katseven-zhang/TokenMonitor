import type { Query } from './api';
export function localInput(ts:number) { const d=new Date(ts); return new Date(ts-d.getTimezoneOffset()*60000).toISOString().slice(0,16); }
// The backend buckets the series with one fixed `offsetMinutes` for the whole window, so
// the anchor is a choice rather than a fact. Presets took it from `end` while the manual
// range took it from `start`: the same window rendered on two grids a DST shift apart, and
// a day drill-down kept whichever offset the previous action had left behind. The start is
// the grid origin and it is what a day or month view has to agree with, so every window
// now comes through here.
export function windowOf(start:number,end:number):Pick<Query,'start'|'end'|'offsetMinutes'|'timeZone'> {return {start,end,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,offsetMinutes:-new Date(start).getTimezoneOffset()};}
export function preset(minutes:number):Pick<Query,'start'|'end'|'offsetMinutes'|'timeZone'> {const end=Math.floor(Date.now()/60000)*60000;return windowOf(end-minutes*60000,end);}
// Daily presets include today and the preceding local calendar days. This matches the
// date-based rows used by Codex Usage Desktop; an elapsed 168-hour window starts partway
// through an eighth date and cannot be compared to its "Last 7 Days" report.
export function calendarPreset(days:number):Pick<Query,'start'|'end'|'offsetMinutes'|'timeZone'> {
 const end=Math.floor(Date.now()/60000)*60000;
 const today=new Date(end);
 const start=new Date(today.getFullYear(),today.getMonth(),today.getDate()-(days-1)).getTime();
 return windowOf(start,end);
}
export function rangePreset(minutes:number){return minutes===10080||minutes===43200?calendarPreset(minutes/1440):preset(minutes);}
export function isRangePresetSelected(q:Pick<Query,'start'|'end'>,minutes:number){
 if(minutes!==10080&&minutes!==43200)return q.end-q.start===minutes*60000;
 const today=new Date(Date.now());
 const start=new Date(today.getFullYear(),today.getMonth(),today.getDate()-(minutes/1440-1)).getTime();
 const midnight=new Date(today.getFullYear(),today.getMonth(),today.getDate()).getTime();
 return q.start===start&&q.end>=midnight&&q.end<=Date.now();
}
export function initialQuery():Query{return {...calendarPreset(7),agent:null,model:null,project:null,session:null,search:''};}
export function dateRange(day:string,month=false):{start:number;end:number}{const start=new Date(`${day}${month?'-01':''}T00:00:00`);const end=new Date(start);if(month)end.setMonth(end.getMonth()+1);else end.setDate(end.getDate()+1);return {start:start.getTime(),end:end.getTime()};}

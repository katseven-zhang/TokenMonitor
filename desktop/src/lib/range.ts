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
export function initialQuery():Query{return {...preset(7*24*60),agent:null,model:null,project:null,session:null,search:''};}
export function dateRange(day:string,month=false):{start:number;end:number}{const start=new Date(`${day}${month?'-01':''}T00:00:00`);const end=new Date(start);if(month)end.setMonth(end.getMonth()+1);else end.setDate(end.getDate()+1);return {start:start.getTime(),end:end.getTime()};}

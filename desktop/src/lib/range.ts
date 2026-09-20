import type { Query } from './api';
export function localInput(ts:number) { const d=new Date(ts); return new Date(ts-d.getTimezoneOffset()*60000).toISOString().slice(0,16); }
export function preset(minutes:number):Pick<Query,'start'|'end'|'offsetMinutes'|'timeZone'> {const end=Math.floor(Date.now()/60000)*60000;return {timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,start:end-minutes*60000,end,offsetMinutes:-new Date(end).getTimezoneOffset()};}
export function initialQuery():Query{return {...preset(7*24*60),agent:null,model:null,project:null,session:null,search:''};}
export function dateRange(day:string,month=false):{start:number;end:number}{const start=new Date(`${day}${month?'-01':''}T00:00:00`);const end=new Date(start);if(month)end.setMonth(end.getMonth()+1);else end.setDate(end.getDate()+1);return {start:start.getTime(),end:end.getTime()};}

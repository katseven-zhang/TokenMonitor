import { createContext, useContext } from 'react';

export function currencyFromJson(text?:string) {
  let config:{displayCurrency?:string;usdCny?:number}={};
  try { config=JSON.parse(text||'{}'); } catch { /* Keep the saved default until valid JSON is saved. */ }
  const code=config.displayCurrency?.toUpperCase()==='CNY'?'CNY':'USD';
  const factor=code==='CNY'&&typeof config.usdCny==='number'&&config.usdCny>0?config.usdCny:1;
  return {code,factor,money:(usd:number|null|undefined)=>usd==null?'未定价':`${code==='CNY'?'¥':'$'}${(usd*factor).toLocaleString('en',{minimumFractionDigits:2,maximumFractionDigits:4})}`};
}
export const CurrencyContext=createContext(currencyFromJson());
export const useCurrency=()=>useContext(CurrencyContext);

import { createContext, useContext } from 'react';

function formatMoney(usd:number|null|undefined,code:'CNY'|'USD',factor=1) {
  if(usd==null) return '未定价';
  const value=usd*factor;
  // `toLocaleString` signs the digits, not the amount, so a credit or a correction read
  // back as `$-1.50`. The sign belongs outside the currency symbol, and a value that only
  // the rounding can see as negative must not come back as `-$0.00`.
  const amount=Math.abs(value).toLocaleString('en',{minimumFractionDigits:2,maximumFractionDigits:4});
  const sign=value<0&&Math.abs(value)>=0.00005?'-':'';
  return `${sign}${code==='CNY'?'¥':'$'}${amount}`;
}
export function currencyFromJson(text?:string) {
  let config:{displayCurrency?:string;usdCny?:number}={};
  try { config=JSON.parse(text||'{}'); } catch { /* Keep the saved default until valid JSON is saved. */ }
  const code=config.displayCurrency?.toUpperCase()==='CNY'?'CNY':'USD';
  const factor=code==='CNY'&&typeof config.usdCny==='number'&&config.usdCny>0?config.usdCny:1;
  return {code,factor,money:(usd:number|null|undefined)=>formatMoney(usd,code,factor)};
}
export const CurrencyContext=createContext(currencyFromJson());
export const useCurrency=()=>useContext(CurrencyContext);

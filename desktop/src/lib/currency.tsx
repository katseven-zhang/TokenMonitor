import { createContext, useContext } from 'react';

/**
 * How a lib module asks for user-visible copy without importing a hook or an i18next
 * instance (task #103): the caller hands down a function that resolves a key in whatever
 * language it is rendering, exactly like `quota-observations.ts` returns keys instead of
 * one language's sentence.
 */
export type Translate = (key: string) => string;

/** The one locale key this module can show; shared with the price catalog's unpriced cells. */
export const UNPRICED_KEY = 'common.unpriced';
// Only the pre-provider default value and unit tests reach this — every mounted surface
// passes a translator, so no user is shown a string that skipped the tables.
const UNPRICED_FALLBACK = 'Unpriced';

function formatMoney(usd:number|null|undefined,code:'CNY'|'USD',factor=1,unpriced=UNPRICED_FALLBACK) {
  if(usd==null) return unpriced;
  const value=usd*factor;
  // `toLocaleString` signs the digits, not the amount, so a credit or a correction read
  // back as `$-1.50`. The sign belongs outside the currency symbol, and a value that only
  // the rounding can see as negative must not come back as `-$0.00`.
  const amount=Math.abs(value).toLocaleString('en',{minimumFractionDigits:2,maximumFractionDigits:4});
  const sign=value<0&&Math.abs(value)>=0.00005?'-':'';
  return `${sign}${code==='CNY'?'¥':'$'}${amount}`;
}
export function currencyFromJson(text?:string,translate?:Translate) {
  let config:{displayCurrency?:string;usdCny?:number}={};
  try { config=JSON.parse(text||'{}'); } catch { /* Keep the saved default until valid JSON is saved. */ }
  const code=config.displayCurrency?.toUpperCase()==='CNY'?'CNY':'USD';
  const factor=code==='CNY'&&typeof config.usdCny==='number'&&config.usdCny>0?config.usdCny:1;
  const unpriced=translate?translate(UNPRICED_KEY):UNPRICED_FALLBACK;
  return {code,factor,money:(usd:number|null|undefined)=>formatMoney(usd,code,factor,unpriced)};
}
export const CurrencyContext=createContext(currencyFromJson());
export const useCurrency=()=>useContext(CurrencyContext);

import {describe,it,expect} from 'vitest';
import {currencyFromJson,UNPRICED_KEY} from './currency';
describe('display currency',()=>{
  it('keeps USD values by default',()=>{
    expect(currencyFromJson().money(10)).toBe('$10.00');
  });
  it('converts canonical dollars only once and preserves unknowns and free usage',()=>{
    const display=currencyFromJson('{"displayCurrency":"CNY","usdCny":7}',key=>key);
    expect(display.code).toBe('CNY');
    expect(display.money(6.1)).toBe('¥42.70');
    expect(display.money(0)).toBe('¥0.00');
    expect(display.money(null)).toBe(UNPRICED_KEY);
    expect(currencyFromJson('{"displayCurrency":"USD","usdCny":7}').money(6.1)).toBe('$6.10');
  });
  // Task #103: the unpriced cell used to be the literal 未定价, so an English or Japanese
  // interface showed a Chinese word in every cost column it could not price.
  it('takes the unpriced label from the caller instead of one baked-in language',()=>{
    const speak=(table:Record<string,string>)=>(key:string)=>table[key]??key;
    expect(currencyFromJson('{}',speak({[UNPRICED_KEY]:'未定价'})).money(null)).toBe('未定价');
    expect(currencyFromJson('{}',speak({[UNPRICED_KEY]:'Unpriced'})).money(null)).toBe('Unpriced');
    expect(currencyFromJson('{}',speak({[UNPRICED_KEY]:'価格未登録'})).money(null)).toBe('価格未登録');
  });
  it('still reads priced values the same way whichever label it was given',()=>{
    for(const translate of [undefined, (key:string)=>`[${key}]`] as const){
      const display=currencyFromJson('{"displayCurrency":"CNY","usdCny":7}',translate);
      expect(display.money(1)).toBe('¥7.00');
      expect(display.money(undefined)).toBe(translate?`[${UNPRICED_KEY}]`:'Unpriced');
    }
  });
  it('puts the sign in front of the currency symbol, not inside it',()=>{
    const cny=currencyFromJson('{"displayCurrency":"CNY","usdCny":7}');
    expect(currencyFromJson().money(-1.5)).toBe('-$1.50');
    expect(cny.money(-1.5)).toBe('-¥10.50');
    expect(currencyFromJson().money(-1234.5)).toBe('-$1,234.50');
    expect(currencyFromJson().money(-0.0007)).toBe('-$0.0007');
  });
  it('does not report a credit for an amount too small to price',()=>{
    expect(currencyFromJson().money(-0.000001)).toBe('$0.00');
    expect(currencyFromJson().money(-0)).toBe('$0.00');
    expect(currencyFromJson().money(0)).toBe('$0.00');
  });
});

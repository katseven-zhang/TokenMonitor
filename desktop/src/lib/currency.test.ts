import {describe,it,expect} from 'vitest';
import {currencyFromJson} from './currency';
describe('display currency',()=>{
  it('keeps USD values by default',()=>{
    expect(currencyFromJson().money(10)).toBe('$10.00');
  });
  it('converts canonical dollars only once and preserves unknowns and free usage',()=>{
    const display=currencyFromJson('{"displayCurrency":"CNY","usdCny":7}');
    expect(display.code).toBe('CNY');
    expect(display.money(6.1)).toBe('¥42.70');
    expect(display.money(0)).toBe('¥0.00');
    expect(display.money(null)).toBe('未定价');
    expect(currencyFromJson('{"displayCurrency":"USD","usdCny":7}').money(6.1)).toBe('$6.10');
  });
});

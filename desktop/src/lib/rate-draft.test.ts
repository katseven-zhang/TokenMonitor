import { describe,expect,it } from 'vitest';
import { parseExchangeRateDraft,typeExchangeRate } from './rate-draft';

describe('exchange rate draft',()=>{
  it('types 7.2 without ever storing the tenfold rate a swallowed point produces',()=>{
    expect(typeExchangeRate('7.2')).toEqual([7,null,7.2]);
    expect(typeExchangeRate('7.2')).not.toContain(72);
  });

  it('commits complete decimals',()=>{
    expect(parseExchangeRateDraft('7')).toEqual({ ok:true,value:7,display:'7' });
    expect(parseExchangeRateDraft('7.25')).toEqual({ ok:true,value:7.25,display:'7.25' });
    expect(parseExchangeRateDraft('.5')).toEqual({ ok:true,value:0.5,display:'0.5' });
    expect(parseExchangeRateDraft('1e-7')).toEqual({ ok:true,value:0.0000001,display:'1e-7' });
  });

  it('leaves the stored rate untouched while a separator is still being typed',()=>{
    expect(parseExchangeRateDraft('7.')).toEqual({ ok:true,value:null,display:'7' });
    expect(parseExchangeRateDraft('.')).toEqual({ ok:true,value:null,display:'' });
    expect(parseExchangeRateDraft('7e')).toEqual({ ok:true,value:null,display:'7' });
  });

  it('clears the rate only for an empty field',()=>{
    expect(parseExchangeRateDraft('')).toEqual({ ok:true,value:null,display:'' });
  });

  it('refuses text that can never be a rate',()=>{
    for(const raw of ['7.2.3','abc','-7','7 2']){
      expect(parseExchangeRateDraft(raw).ok,raw).toBe(false);
    }
  });
});

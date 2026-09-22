import { describe,expect,it } from 'vitest';
import { canStepTo, isCurrentRequest, lastPageOffset, pageNumberOf, pageCountOf, requestFor, type PagedRequest } from './page-request';

type Q = { search:string; agent:string|null };
const same = (a:Q,b:Q)=>a.search===b.search&&a.agent===b.agent;
const at = (key:Q,offset:number):PagedRequest<Q>=>({key,offset});

describe('table paging across filter changes',()=>{
  it('restarts a changed filter at the first page',()=>{
    const loaded=at({search:'abc',agent:null},300);
    expect(requestFor({search:'abd',agent:null},loaded,same)).toEqual({key:{search:'abd',agent:null},offset:0});
  });

  it('keeps the current page while the same filter is re-issued, and resets for another one',()=>{
    const loaded=at({search:'abc',agent:null},300);
    expect(requestFor({search:'abc',agent:null},loaded,same)).toBe(loaded);
    expect(requestFor({search:'abc',agent:'codex'},loaded,same).offset).toBe(0);
  });

  it('never treats a page loaded for another filter as current',()=>{
    const loaded=at({search:'abc',agent:null},200);
    expect(isCurrentRequest(loaded,at({search:'abc',agent:null},200),same)).toBe(true);
    expect(isCurrentRequest(loaded,at({search:'abc',agent:null},100),same)).toBe(false);
    expect(isCurrentRequest(loaded,at({search:'zzz',agent:null},200),same)).toBe(false);
    expect(isCurrentRequest(null,at({search:'abc',agent:null},200),same)).toBe(false);
  });
});

describe('pagination label and bounds',()=>{
  it('numbers pages from the offset',()=>{
    expect(pageNumberOf(0,100)).toBe(1);
    expect(pageNumberOf(300,100)).toBe(4);
  });

  it('refuses to claim a single page while the total is still unknown',()=>{
    expect(pageCountOf(null,100)).toBeNull();
    expect(pageCountOf(0,100)).toBe(1);
    expect(pageCountOf(250,100)).toBe(3);
    expect(lastPageOffset(null,100)).toBeNull();
    expect(lastPageOffset(250,100)).toBe(200);
  });

  it('only steps inside the loaded range',()=>{
    expect(canStepTo(0,100,250,'back')).toBe(false);
    expect(canStepTo(100,100,250,'back')).toBe(true);
    expect(canStepTo(200,100,250,'forward')).toBe(false);
    expect(canStepTo(100,100,250,'forward')).toBe(true);
    expect(canStepTo(100,100,null,'forward')).toBe(false);
  });
});

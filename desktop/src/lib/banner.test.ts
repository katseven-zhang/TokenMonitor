import { describe,expect,it } from 'vitest';
import { dismissError, emptyErrorSlots, NOTICE_TTL_MS, serverErrorSlot, visibleError } from './banner';

describe('banner error sources',()=>{
  it('prefers the message the user acted on over a background report',()=>{
    const slots={...emptyErrorSlots(),query:'查询失败',action:'扫描失败'};
    expect(visibleError(slots)).toEqual({slot:'action',message:'扫描失败'});
  });

  it('shows the next source instead of a banner that never goes away',()=>{
    let slots={...emptyErrorSlots(),action:'扫描失败',server:'索引损坏'};
    let first=visibleError(slots);
    expect(first).not.toBeNull();
    slots=dismissError(slots,first!.slot);
    first=visibleError(slots);
    expect(first).toEqual({slot:'server',message:'索引损坏'});
    slots=dismissError(slots,'server');
    expect(visibleError(slots)).toBeNull();
  });

  it('treats blank text as no error at all',()=>{
    expect(visibleError({...emptyErrorSlots(),status:'   '})).toBeNull();
  });

  it('keeps a repeated server error dismissed until its text changes',()=>{
    expect(serverErrorSlot('后台报告：某个来源读取失败','后台报告：某个来源读取失败')).toBe('');
    expect(serverErrorSlot('后台报告：某个来源读取失败','')).toBe('后台报告：某个来源读取失败');
    expect(serverErrorSlot('后台报告：另一个来源读取失败','后台报告：某个来源读取失败')).toBe('后台报告：另一个来源读取失败');
    expect(serverErrorSlot(null,'')).toBe('');
  });

  it('notices expire instead of sitting over a later failure',()=>{
    expect(NOTICE_TTL_MS).toBeGreaterThan(0);
  });
});

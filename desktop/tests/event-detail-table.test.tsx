import { afterEach, describe,expect,it,vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { EventDetailTable } from '../src/components/event-detail-table';
import type { Query } from '../src/lib/api';

// The effect that loads a page never runs during static rendering, so this is exactly
// the window a user used to see as a false "no usage records" panel.
const query:Query = { start:0,end:60_000,agent:null,model:null,project:null,session:null,search:'nothing',offsetMinutes:0 };

afterEach(()=>vi.restoreAllMocks());

vi.mock('../src/lib/api',()=>({ request:()=>new Promise(()=>{}) }));

describe('usage detail paging',()=>{
  it('shows progress, not an empty result, while the first page is in flight',()=>{
    const html=renderToStaticMarkup(<EventDetailTable query={query} revision={0} onFilterSession={()=>{}} onReveal={()=>{}}/>);
    expect(html).toContain('正在读取逐条用量记录');
    expect(html).not.toContain('这个时间范围内没有用量记录');
  });

  it('withholds the page counter until the total is known',()=>{
    const html=renderToStaticMarkup(<EventDetailTable query={query} revision={0} onFilterSession={()=>{}} onReveal={()=>{}}/>);
    expect(html).not.toContain('1 / 1');
    expect(html).toContain('—');
    expect(html.match(/disabled=""/g)?.length).toBe(2);
  });
});

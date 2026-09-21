import { useEffect, useState } from 'react';
import { useCurrency } from '../lib/currency';
import { request, type EventPage, type Query } from '../lib/api';
import { latestLoader } from '../lib/latest-loader';
import { sameQuery } from '../lib/query-identity';
import { canStepTo, isCurrentRequest, pageNumberOf, pageCountOf, requestFor, type PagedRequest } from '../lib/page-request';
import { Empty } from './empty-state';

const limit = 100;
const n = (value:number) => value.toLocaleString('zh-CN');
const time = (value:number) => new Date(value).toLocaleString('zh-CN',{hour12:false});
type DetailRequest = PagedRequest<Query> & { revision:number };
type Loaded = DetailRequest & { result:EventPage };

// The page and its filter live in one state object, so a changed filter can never be
// sent out with the previous page's offset. `revision` lets a pricing change re-read
// the same page without the list restarting, and an unmatched result is treated as
// "still loading" instead of "no records".
export function EventDetailTable({query,revision,onFilterSession,onReveal}:{query:Query;revision:number;onFilterSession:(agent:string,session:string)=>void;onReveal:(path:string)=>void}) {
  const { money } = useCurrency();
  const [stored,setStored]=useState<PagedRequest<Query>>({key:query,offset:0});
  const paging=requestFor(query,stored,sameQuery);
  if(paging!==stored) setStored(paging);
  const [loaded,setLoaded]=useState<Loaded|null>(null);
  const [error,setError]=useState('');
  const [loader]=useState(()=>latestLoader<DetailRequest,Loaded>(
    (a,b)=>a.revision===b.revision&&a.offset===b.offset&&sameQuery(a.key,b.key),
    async ({key,offset,revision})=>({key,offset,revision,result:await request<EventPage>('events',{query:key,offset,limit})}),
    result=>{setLoaded(result);setError('');},
    error=>setError(String(error)),
  ));
  useEffect(()=>{
    const key:DetailRequest={...paging,revision};
    void loader.run(key);
    const timer=setInterval(()=>void loader.run(key),5000);
    return()=>clearInterval(timer);
  },[loader,paging,revision]);
  const page=loaded&&loaded.revision===revision&&isCurrentRequest(loaded,paging,sameQuery)?loaded.result:null;
  const offset=paging.offset;
  const total=page?.total??null;
  return <section className="panel"><div className="panel-heading"><h2>逐条用量记录</h2><span>时间范围内共 {page?n(total??0):'…'} 条</span></div>
    {error&&<p role="alert" className="error-text">{error}</p>}
    {!page?<p role="status" className="table-note">正在读取逐条用量记录…</p>:page.items.length?<div className="table-wrap"><table><thead><tr>{['时间','Agent / 模型','项目 / 会话','输入','缓存读 / 写','输出 / 推理','估算费用','原始位置'].map(h=><th key={h}>{h}</th>)}</tr></thead><tbody>{page.items.map(({event:e,costUSD})=><tr key={`${e.agent}:${e.id}`}><td>{time(e.ts)}</td><td>{e.agent}<small className="cell-sub">{e.model}</small></td><td className="long-cell">{e.project||'未记录项目'}<button className="cell-sub row-link" onClick={()=>onFilterSession(e.agent,e.session)}>{e.session}</button></td><td className="number">{n(e.tokens.input)}</td><td className="number">{n(e.tokens.cached)} / {n(e.tokens.cacheWrite)}</td><td className="number">{n(e.tokens.output)} / {n(e.tokens.reasoning)}</td><td>{money(costUSD)}</td><td><button title={e.path} onClick={()=>onReveal(e.path)}>文件{e.line?` : ${e.line}`:''}</button></td></tr>)}</tbody></table></div>:<Empty/>}
    <div className="pagination" aria-label="逐条用量分页">
      <button disabled={!page||!canStepTo(offset,limit,total,'back')} onClick={()=>setStored({key:paging.key,offset:Math.max(0,offset-limit)})}>上一页</button>
      <span>{page?`${pageNumberOf(offset,limit)} / ${pageCountOf(total,limit)}`:'—'}</span>
      <button disabled={!page||!canStepTo(offset,limit,total,'forward')} onClick={()=>setStored({key:paging.key,offset:offset+limit})}>下一页</button>
    </div>
  </section>;
}

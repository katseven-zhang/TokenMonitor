import { useEffect, useState } from 'react';
import { request, type ActivityPage, type Query } from '../lib/api';
import { latestLoader } from '../lib/latest-loader';
import { sameQuery } from '../lib/query-identity';
import { canStepTo, isCurrentRequest, lastPageOffset, pageCountOf, pageNumberOf, type PagedRequest } from '../lib/page-request';

const size = 100;
const number = (value:number) => value.toLocaleString('zh-CN');
type Loaded = PagedRequest<Query> & { page:ActivityPage };

export function ActivityTable({query,onReveal}:{query:Query;onReveal:(path:string)=>void}) {
  // The loader is created once, so the query travels inside the request key instead of
  // a closure over the first render's props. A new filter restarts paging at the first
  // page here rather than by remounting the table, which used to discard this state.
  const [paging,setPaging]=useState<PagedRequest<Query>>({key:query,offset:0});
  if(!sameQuery(paging.key,query)) setPaging({key:query,offset:0});
  const [response,setResponse]=useState<Loaded|null>(null);
  const [error,setError]=useState('');
  const [loader]=useState(()=>latestLoader<PagedRequest<Query>,Loaded>(
    (a,b)=>a.offset===b.offset&&sameQuery(a.key,b.key),
    async ({key,offset})=>({key,offset,page:await request<ActivityPage>('activities',{query:key,offset,limit:size})}),
    result=>{setResponse(result);setError('');},
    error=>setError(String(error)),
  ));
  useEffect(()=>{
    void loader.run(paging);
    const timer=setInterval(()=>void loader.run(paging),5000);
    return()=>clearInterval(timer);
  },[loader,paging]);
  const offset=paging.offset;
  const page=isCurrentRequest(response,paging,sameQuery)?response.page:null;
  const total=page?.total??null;
  const lastOffset=lastPageOffset(total,size);
  const goTo=(next:number)=>setPaging({key:paging.key,offset:next});
  return <>
    {error&&<p role="alert" className="error-text">{error}</p>}
    <p className="table-note">{page?`共 ${number(total??0)} 条调用，`:''}按时间从新到旧排列。Codex 会话回放可查看工具参数、输出和补丁。</p>
    <div className="pagination" aria-label="工具活动分页">
      <button disabled={!page||offset===0} onClick={()=>goTo(0)}>首页</button>
      <button disabled={!page||!canStepTo(offset,size,total,'back')} onClick={()=>goTo(Math.max(0,offset-size))}>上一页</button>
      <span>{page?`${pageNumberOf(offset,size)} / ${pageCountOf(total,size)}`:'—'} · 每页 {size} 条</span>
      <button disabled={!page||!canStepTo(offset,size,total,'forward')} onClick={()=>goTo(offset+size)}>下一页</button>
      <button disabled={!page||lastOffset===null||offset>=lastOffset} onClick={()=>goTo(lastOffset??0)}>末页</button>
    </div>
    <div style={{height:'60vh',overflow:'auto'}} aria-busy={!page}>
    {!page?<p role="status" className="table-note">正在读取工具活动…</p>:<>
      {page.items.length?<div className="table-wrap"><table><thead><tr><th>时间</th><th>Agent</th><th>工具</th><th>会话</th><th>来源</th></tr></thead><tbody>{page.items.map(a=><tr key={`${a.agent}:${a.id}`}>
        <td>{new Date(a.ts).toLocaleString('zh-CN',{hour12:false})}</td><td>{a.agent}</td><td>{a.name}</td><td className="long-cell">{a.session}</td><td><button title={a.path} onClick={()=>onReveal(a.path)}>打开文件</button></td>
      </tr>)}</tbody></table></div>:<p className="table-note">这一页没有工具调用记录。</p>}
    </>}
    </div>
  </>;
}

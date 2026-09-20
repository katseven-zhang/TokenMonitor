import { useEffect, useState } from 'react';
import { request, type ActivityPage, type Query } from '../lib/api';
import { latestLoader } from '../lib/latest-loader';

const size = 100;
const number = (value:number) => value.toLocaleString('zh-CN');
export function ActivityTable({query,onReveal}:{query:Query;onReveal:(path:string)=>void}) {
  // Parent keys this component by the complete query, resetting paging on any filter change.
  const [offset,setOffset] = useState(0);
  const [response,setResponse] = useState<{offset:number;page:ActivityPage}|null>(null);
  const [error,setError] = useState('');
  const [loader] = useState(()=>latestLoader<number,{offset:number;page:ActivityPage}>(
    (a,b)=>a===b,
    async offset=>({offset,page:await request<ActivityPage>('activities',{query,offset,limit:size})}),
    result=>{setResponse(result);setError('');},
    error=>setError(String(error)),
  ));
  useEffect(()=>{
    void loader.run(offset);
    const timer=setInterval(()=>void loader.run(offset),5000);
    return()=>clearInterval(timer);
  },[loader,offset]);
  const page=response?.offset===offset?response.page:null;
  const total=response?.page.total??0;
  const lastOffset=Math.max(0,Math.ceil(total/size)-1)*size;
  return <>
    {error&&<p role="alert" className="error-text">{error}</p>}
    <p className="table-note">{response?`共 ${number(total)} 条调用，`:''}按时间从新到旧排列。Codex 会话回放可查看工具参数、输出和补丁。</p>
    <div className="pagination" aria-label="工具活动分页">
      <button disabled={!page||offset===0} onClick={()=>setOffset(0)}>首页</button>
      <button disabled={!page||offset===0} onClick={()=>setOffset(Math.max(0,offset-size))}>上一页</button>
      <span>{Math.floor(offset/size)+1} / {Math.max(1,Math.ceil(total/size))} · 每页 {size} 条</span>
      <button disabled={!page||offset+size>=total} onClick={()=>setOffset(offset+size)}>下一页</button>
      <button disabled={!page||offset>=lastOffset} onClick={()=>setOffset(lastOffset)}>末页</button>
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

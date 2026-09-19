import { useMemo,useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { Summary } from '../lib/api';
import { sortSummaries,type SummarySort } from '../lib/summary-sort';

export type SummaryKind='models'|'projects'|'sessions'|'days'|'months';
const titles:Record<SummaryKind,string>={models:'模型',projects:'项目',sessions:'会话',days:'日期',months:'月份'};
const n=(value:number)=>value.toLocaleString('zh-CN');
const money=(value:number|null)=>value==null?'未定价':`$${value.toLocaleString('en',{minimumFractionDigits:2,maximumFractionDigits:4})}`;
const time=(value:number)=>new Date(value).toLocaleString('zh-CN',{hour12:false});
export function SummaryTable({rows,kind,onDrill}:{rows:Summary[];kind:SummaryKind;onDrill:(row:Summary,kind:SummaryKind)=>void}) {
  const [column,setColumn]=useState<SummarySort>(kind==='days'||kind==='months'?'label':'totalTokens');
  const [descending,setDescending]=useState(true);
  const [requestedPage,setPage]=useState(0),[pageSize,setPageSize]=useState(50);
  const sorted=useMemo(()=>sortSummaries(rows,column,descending),[rows,column,descending]);
  const pageCount=Math.max(1,Math.ceil(sorted.length/pageSize));
  const page=Math.min(requestedPage,pageCount-1);
  const visible=sorted.slice(page*pageSize,(page+1)*pageSize);
  const columns:[SummarySort,string][]=[['label',titles[kind]],['totalTokens','总 Tokens'],['input','输入'],['cached','缓存读取'],['cacheWrite','缓存写入'],['output','输出'],['reasoning','推理¹'],['events','记录'],['costUsd','估算费用']];
  if(kind==='sessions') columns.push(['lastTs','最后活动']);
  function sort(next:SummarySort){setDescending(next===column?!descending:next!=='label');setColumn(next);setPage(0);}
  return <>
    <div className="table-wrap"><table><thead><tr>{columns.map(([key,title])=><th key={key} aria-sort={column===key?(descending?'descending':'ascending'):'none'}><button className="table-sort" onClick={()=>sort(key)}>{title}<span aria-hidden="true">{column===key?(descending?' ↓':' ↑'):' ↕'}</span></button></th>)}<th/></tr></thead>
      <tbody>{visible.map(row=><tr key={row.key}><td><button className="row-link" onClick={()=>onDrill(row,kind)}>{row.label||'未记录项目'}</button>{kind==='sessions'&&<small className="cell-sub">{row.agent} · {row.session}</small>}</td><td className="number strong">{n(row.totalTokens)}</td>{(['input','cached','cacheWrite','output','reasoning'] as const).map(key=><td key={key} className="number">{n(row.tokens[key])}</td>)}<td className="number">{n(row.events)}</td><td className="number cost" title={row.unpricedEvents?`${row.unpricedEvents} 条记录未定价；已定价部分 ${money(row.knownCostUsd)}`:''}>{money(row.costUsd)}</td>{kind==='sessions'&&<td className="number">{time(row.lastTs)}</td>}<td><button className="icon-button" aria-label={`查看 ${row.label}`} onClick={()=>onDrill(row,kind)}><ChevronRight size={16}/></button></td></tr>)}</tbody>
    </table></div>
    {!rows.length&&<div className="empty"><h3>这个时间范围内没有用量记录</h3><p>选择其他时间范围，或在设置中检查本地数据目录。</p></div>}
    <div className="summary-pagination"><span>{rows.length?`${page*pageSize+1}–${Math.min((page+1)*pageSize,rows.length)}`:'0'} / {n(rows.length)} 项</span><label>每页 <select aria-label={`${titles[kind]}每页条数`} value={pageSize} onChange={e=>{setPageSize(Number(e.target.value));setPage(0);}}>{[25,50,100].map(size=><option key={size} value={size}>{size}</option>)}</select></label><div><button className="secondary" disabled={page===0} onClick={()=>setPage(0)}>首页</button><button className="secondary" disabled={page===0} onClick={()=>setPage(page-1)}>上一页</button><span>{page+1} / {pageCount}</span><button className="secondary" disabled={page>=pageCount-1} onClick={()=>setPage(page+1)}>下一页</button><button className="secondary" disabled={page>=pageCount-1} onClick={()=>setPage(pageCount-1)}>末页</button></div></div>
    <div className="table-note">¹ 推理 Tokens 已包含于输出，不重复加入总量。费用由本地 prices.json 计算。点击表头可排序；明细与导出使用完整查询范围，分页不改变总量。</div>
  </>;
}

import { useCurrency } from '../lib/currency';
import { useMemo,useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { Summary } from '../lib/api';
import { sortSummaries,type SummarySort } from '../lib/summary-sort';
import { cacheHitRate,componentPrices,comparisonShares,comparisonTotals,effectivePrice } from '../lib/summary-analytics';

export type SummaryKind='models'|'projects'|'sessions'|'days'|'months';
const titles:Record<SummaryKind,string>={models:'模型',projects:'项目',sessions:'会话',days:'日期',months:'月份'};
const n=(value:number)=>value.toLocaleString('zh-CN');
const time=(value:number)=>new Date(value).toLocaleString('zh-CN',{hour12:false});
const percent=(value:number|null)=>value===null?'—':`${(value*100).toFixed(1)}%`;
export function SummaryTable({rows,kind,onDrill}:{rows:Summary[];kind:SummaryKind;onDrill:(row:Summary,kind:SummaryKind)=>void}) {
  const {money,code}=useCurrency();
  const [column,setColumn]=useState<SummarySort>(kind==='days'||kind==='months'?'label':'totalTokens');
  const [descending,setDescending]=useState(true);
  const [requestedPage,setPage]=useState(0),[pageSize,setPageSize]=useState(50);
  const sorted=useMemo(()=>sortSummaries(rows,column,descending),[rows,column,descending]);
  const pageCount=Math.max(1,Math.ceil(sorted.length/pageSize));
  const page=Math.min(requestedPage,pageCount-1);
  const visible=sorted.slice(page*pageSize,(page+1)*pageSize);
  const comparing=kind==='models'||kind==='projects';
  const totals=useMemo(()=>comparisonTotals(rows),[rows]);
  const columns:[SummarySort,string][]=[['label',titles[kind]],['totalTokens','总 Tokens'],['input','输入'],['cached','缓存读取'],['cacheWrite','缓存写入'],['output','输出'],['reasoning','推理¹'],['events','记录'],['costUsd','估算费用']];
  if(comparing) columns.push(['cacheHitRate','缓存命中率'],['effectivePrice',`${code} / 百万 Tokens`]);
  if(kind==='sessions'||comparing) columns.push(['lastTs','最后活动']);
  function sort(next:SummarySort){setDescending(next===column?!descending:next!=='label');setColumn(next);setPage(0);}
  return <>
    {comparing&&<p className="comparison-note">构成：<span style={{color:'#6b8def'}}>新输入</span> / <span style={{color:'#39bb9a'}}>缓存读取</span> / <span style={{color:'#f4b454'}}>缓存写入</span> / <span style={{color:'#ab80db'}}>输出</span>。占比分母为当前筛选的全部结果；含未定价用量时不显示费用占比。有效单价 = 按历史价格计得的费用 / 总 Tokens × 百万，并非当前报价。</p>}
    <div className="table-wrap"><table><thead><tr>{columns.map(([key,title])=><th key={key} aria-sort={column===key?(descending?'descending':'ascending'):'none'}><button className="table-sort" onClick={()=>sort(key)}>{title}<span aria-hidden="true">{column===key?(descending?' ↓':' ↑'):' ↕'}</span></button></th>)}<th/></tr></thead>
      <tbody>{visible.map(row=><tr key={row.key}><td><button className="row-link" onClick={()=>onDrill(row,kind)}>{row.label||'未记录项目'}</button>{comparing&&<small className="cell-sub">用量占比 {percent(comparisonShares(row,totals).usage)}</small>}{kind==='models'&&<details className="component-prices"><summary>分类有效单价</summary><small>{code} / 百万 Tokens · 查询期加权</small>{componentPrices(row).map((price,index)=><p key={index}><span>{['新输入','缓存读取','缓存写入','输出'][index]}</span><b>{price===null?'—':money(price)}</b></p>)}<small>未完整定价或无该类用量时显示 —</small></details>}{kind==='sessions'&&<small className="cell-sub">{row.agent} · {row.session}</small>}</td><td className="number strong">{n(row.totalTokens)}{comparing&&<div className="composition-bar" role="img" aria-label={`Token 构成：新输入 ${n(row.tokens.input)}，缓存读取 ${n(row.tokens.cached)}，缓存写入 ${n(row.tokens.cacheWrite)}，输出 ${n(row.tokens.output)}`}>{(['input','cached','cacheWrite','output'] as const).map((key,index)=><i key={key} style={{width:`${row.totalTokens?row.tokens[key]/row.totalTokens*100:0}%`,background:['#6b8def','#39bb9a','#f4b454','#ab80db'][index]}}/>)}</div>}</td>{(['input','cached','cacheWrite','output','reasoning'] as const).map(key=><td key={key} className="number">{n(row.tokens[key])}</td>)}<td className="number">{n(row.events)}</td><td className="number cost" title={row.unpricedEvents?`${row.unpricedEvents} 条记录未定价；已定价部分 ${money(row.knownCostUsd)}`:''}>{money(row.costUsd)}{comparing&&<small className="cell-sub">费用占比 {percent(comparisonShares(row,totals).cost)}</small>}</td>{comparing&&<><td className="number">{percent(cacheHitRate(row))}</td><td className="number">{effectivePrice(row)===null?'—':money(effectivePrice(row))}</td></>}{(kind==='sessions'||comparing)&&<td className="number">{time(row.lastTs)}</td>}<td><button className="icon-button" aria-label={`查看 ${row.label}`} onClick={()=>onDrill(row,kind)}><ChevronRight size={16}/></button></td></tr>)}</tbody>
    </table></div>
    {!rows.length&&<div className="empty"><h3>这个时间范围内没有用量记录</h3><p>选择其他时间范围，或在设置中检查本地数据目录。</p></div>}
    <div className="summary-pagination"><span>{rows.length?`${page*pageSize+1}–${Math.min((page+1)*pageSize,rows.length)}`:'0'} / {n(rows.length)} 项</span><label>每页 <select aria-label={`${titles[kind]}每页条数`} value={pageSize} onChange={e=>{setPageSize(Number(e.target.value));setPage(0);}}>{[25,50,100].map(size=><option key={size} value={size}>{size}</option>)}</select></label><div><button className="secondary" disabled={page===0} onClick={()=>setPage(0)}>首页</button><button className="secondary" disabled={page===0} onClick={()=>setPage(page-1)}>上一页</button><span>{page+1} / {pageCount}</span><button className="secondary" disabled={page>=pageCount-1} onClick={()=>setPage(page+1)}>下一页</button><button className="secondary" disabled={page>=pageCount-1} onClick={()=>setPage(pageCount-1)}>末页</button></div></div>
    <div className="table-note">¹ 推理 Tokens 已包含于输出，不重复加入总量。费用由本地 prices.json 计算。点击表头可排序；明细与导出使用完整查询范围，分页不改变总量。</div>
  </>;
}

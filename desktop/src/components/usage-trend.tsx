import { useMemo, useRef, useState } from 'react';
import { Maximize2, X } from 'lucide-react';
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Dashboard, Summary } from '../lib/api';

const series = [
  ['input', '新输入', '#6b8def'], ['cached', '缓存读取', '#39bb9a'],
  ['cacheWrite', '缓存写入', '#f4b454'], ['output', '输出', '#ab80db'],
  ['costUsd', '估算费用', '#ef8797'],
] as const;
const compact = (n:number) => new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:2}).format(n);
const money = (n:number|null) => n === null ? '未完整定价' : `$${n.toLocaleString('en',{maximumFractionDigits:4})}`;
const number = (n:number) => n.toLocaleString('zh-CN');

function TrendTooltip({active,payload}:{active?:boolean;payload?:readonly {payload?:Summary}[]}) {
  const row=payload?.find(item=>item.payload)?.payload;
  if(!active || !row) return null;
  return <div className="trend-tooltip"><strong>{new Date(Number(row.label)).toLocaleString('zh-CN',{hour12:false})}</strong>
    <p>总 Tokens <b>{number(row.totalTokens)}</b></p>
    {series.filter(([key])=>key!=='costUsd').map(([key,label,color])=><p key={key}><span style={{color}}>{label}</span><b>{number(row.tokens[key as keyof typeof row.tokens])}</b></p>)}
    <p>推理（已含于输出）<b>{number(row.tokens.reasoning)}</b></p>
    <p>用量记录 <b>{number(row.events)}</b></p>
    <p>估算费用 <b>{money(row.costUsd)}</b></p>
    {row.unpricedEvents>0&&<small>{number(row.unpricedEvents)} 条未定价；已定价部分 {money(row.knownCostUsd)}</small>}
  </div>;
}

export function UsageTrend({data}:{data:Pick<Dashboard,'series'|'bucketMs'>}) {
  const [hidden,setHidden]=useState<Set<string>>(()=>new Set());
  const dialog=useRef<HTMLDialogElement>(null);
  const points=useMemo(()=>data.series.map(row=>({...row,ts:Number(row.label),...row.tokens})),[data.series]);
  const bucket=data.bucketMs===60000?'分钟':data.bucketMs===3600000?'小时':data.bucketMs===86400000?'日':`${data.bucketMs/86400000} 日`;
  const chart=(height:number|string)=><>
    <div className="chart" style={{height}}><ResponsiveContainer width="100%" height="100%"><ComposedChart data={points}>
      <CartesianGrid vertical={false} stroke="var(--chart-grid)"/>
      <XAxis dataKey="ts" minTickGap={40} tickFormatter={ts=>new Date(ts).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:data.bucketMs<86400000?'2-digit':undefined,minute:data.bucketMs===60000?'2-digit':undefined})} tick={{fontSize:11}}/>
      <YAxis yAxisId="tokens" tickFormatter={compact} width={55} tick={{fontSize:11}}/>
      <YAxis yAxisId="cost" orientation="right" hide={hidden.has('costUsd')} tickFormatter={n=>`$${compact(n)}`} width={58} tick={{fontSize:10}}/>
      <Tooltip content={<TrendTooltip/>}/>
      {series.filter(([key])=>key!=='costUsd').map(([key,label,color])=><Bar key={key} yAxisId="tokens" dataKey={key} name={label} stackId="tokens" fill={color} hide={hidden.has(key)} isAnimationActive={false}/>)}
      <Line yAxisId="cost" dataKey="costUsd" name="估算费用" stroke="#ef8797" strokeWidth={2} dot={false} connectNulls={false} hide={hidden.has('costUsd')} isAnimationActive={false}/>
    </ComposedChart></ResponsiveContainer></div>
    <div className="chart-legend trend-legend">{series.map(([key,label,color])=><button key={key} aria-pressed={!hidden.has(key)} onClick={()=>setHidden(old=>{const next=new Set(old);if(next.has(key))next.delete(key);else next.add(key);return next;})}><i style={{background:color}}/>{label}</button>)}</div>
    <p className="trend-note">点击图例显示或隐藏系列；费用缺口表示该时段未完整定价。</p>
  </>;
  return <div className="hero-chart"><div className="chart-label"><h3>用量趋势</h3><span>{bucket}聚合 · 查询范围不变</span><button className="icon-button" aria-label="放大用量趋势" onClick={()=>dialog.current?.showModal()}><Maximize2 size={15}/></button></div>{chart(250)}
    <dialog ref={dialog} className="trend-dialog" aria-labelledby="trend-dialog-title"><div className="chart-label"><h2 id="trend-dialog-title">用量趋势 · {bucket}聚合</h2><button className="icon-button" aria-label="关闭放大趋势" onClick={()=>dialog.current?.close()}><X size={20}/></button></div>{chart('calc(85vh - 150px)')}</dialog>
  </div>;
}

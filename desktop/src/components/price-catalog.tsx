import { useMemo,useState } from 'react';
import { localInput } from '../lib/range';

type Rate={effectiveFrom?:string;input:number;cached:number;cacheWrite:number;output:number};
type Catalog={description?:string;models:Record<string,Rate[]>;aliases?:Record<string,string>};
const price=(value:number|undefined)=>value===undefined?'未定价':`$${value.toLocaleString('en',{maximumFractionDigits:8})}`;
export function PriceCatalog({text}:{text:string}) {
  const [search,setSearch]=useState(''),[at,setAt]=useState(()=>localInput(Date.now())),[requestedPage,setPage]=useState(0);
  const catalog=useMemo(()=>{try{return JSON.parse(text) as Catalog;}catch{return null;}},[text]);
  const timestamp=new Date(at).getTime();
  const rows=useMemo(()=>Object.entries(catalog?.models??{}).map(([model,rates])=>({model,rates:[...rates].sort((a,b)=>(a.effectiveFrom?Date.parse(a.effectiveFrom):0)-(b.effectiveFrom?Date.parse(b.effectiveFrom):0)),aliases:Object.entries(catalog?.aliases??{}).filter(([,target])=>target===model).map(([alias])=>alias)})).filter(row=>[row.model,...row.aliases].some(value=>value.toLowerCase().includes(search.toLowerCase()))).sort((a,b)=>a.model.localeCompare(b.model)),[catalog,search]);
  const pages=Math.max(1,Math.ceil(rows.length/25)),page=Math.min(requestedPage,pages-1);
  return <section className="panel settings-panel"><h2>本地模型价格目录</h2><p>读取已保存的 JSON，输入框中的未保存修改不会改变本表。单位：USD / 百万 Tokens。生效价格按用量发生时间选择。</p>
    {catalog?.description&&<p>{catalog.description}</p>}
    <div className="catalog-filters"><label>搜索模型或别名<input aria-label="搜索本地价格模型" value={search} onChange={e=>{setSearch(e.target.value);setPage(0);}} placeholder="模型名称 / 日志别名"/></label><label>核对生效时间<input aria-label="价格核对时间" type="datetime-local" step="60" value={at} onChange={e=>setAt(e.target.value)}/></label></div>
    {!Number.isFinite(timestamp)&&<p role="alert">请选择有效的价格核对时间。</p>}
    <div className="table-wrap"><table><thead><tr><th>模型 / 别名</th><th>新输入</th><th>缓存读取</th><th>缓存写入</th><th>输出</th><th>生效规则</th></tr></thead><tbody>{rows.slice(page*25,(page+1)*25).map(row=>{const active=[...row.rates].reverse().find(rate=>(rate.effectiveFrom?Date.parse(rate.effectiveFrom):0)<=timestamp);return <tr key={row.model}><td className="long-cell"><b>{row.model}</b>{row.aliases.length>0&&<small className="cell-sub">别名：{row.aliases.join('、')}</small>}</td>{(['input','cached','cacheWrite','output'] as const).map(key=><td key={key} className="number">{price(active?.[key])}</td>)}<td className="long-cell"><span>{active?active.effectiveFrom?new Date(active.effectiveFrom).toLocaleString('zh-CN',{hour12:false}):'基础价格':'该时间尚无生效价格'}</span><details><summary>{row.rates.length} 条价格记录</summary>{row.rates.map((rate,index)=><div className="catalog-rate" key={index}><b>{rate.effectiveFrom||'基础价格（未指定生效时间）'}</b><span>输入 {price(rate.input)} · 缓存读取 {price(rate.cached)} · 缓存写入 {price(rate.cacheWrite)} · 输出 {price(rate.output)}</span></div>)}</details></td></tr>;})}</tbody></table></div>
    {!rows.length&&<p className="table-note">没有匹配的本地模型价格。可在下方 JSON 中添加后验证保存。</p>}
    <div className="summary-pagination"><span>{rows.length} 个匹配模型 · 第 {page+1} / {pages} 页</span><div><button className="secondary" disabled={page===0} onClick={()=>setPage(page-1)}>上一页</button><button className="secondary" disabled={page===pages-1} onClick={()=>setPage(page+1)}>下一页</button></div></div>
  </section>;
}

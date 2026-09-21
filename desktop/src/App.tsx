import { CurrencyContext,currencyFromJson } from './lib/currency';
import { CurrencySettings } from './components/currency-settings';
import { useCallback,useEffect,useLayoutEffect,useState } from 'react';
import { debounce,SEARCH_DEBOUNCE_MS } from './lib/debounce';
import { NOTICE_TTL_MS,dismissError,emptyErrorSlots,serverErrorSlot,visibleError,type ErrorSlot,type ErrorSlots } from './lib/banner';
import { ErrorBoundary,FailureNotice } from './components/error-boundary';
import { Activity,ArrowDownToLine,BarChart3,ChevronRight,Clock3,Coins,Cpu,Database,Folder,HardDrive,Layers,Loader2,Moon,Play,RefreshCw,Search,Settings2,ShieldCheck,Square,Sun,Terminal,X } from 'lucide-react';
import { UsageTrend } from './components/usage-trend';
import { save } from '@tauri-apps/plugin-dialog';
import { request,type Bootstrap,type Dashboard,type Query,type Settings,type Status,type Summary,type SessionDetailRow } from './lib/api';
import { localInput,preset,initialQuery,dateRange,windowOf } from './lib/range';
import { latestLoader } from './lib/latest-loader';
import { readScanStatusRows } from './lib/scan-status';
import { sameQuery } from './lib/query-identity';
import { SummaryTable,type SummaryKind } from './components/summary-table';
import { PriceCatalog } from './components/price-catalog';
import { ActivityTable } from './components/activity-table';
import { Empty } from './components/empty-state';
import { EventDetailTable } from './components/event-detail-table';
import { QuotaPanel } from './components/quota-panel';
import { SessionDetailModal } from './components/session-detail-modal';

const n=(x:number)=>new Intl.NumberFormat('zh-CN',{maximumFractionDigits:0}).format(x);
const compact=(x:number)=>new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:2}).format(x);

const time=(x:number)=>new Date(x).toLocaleString('zh-CN',{hour12:false});
// A degraded status row must show a gap, never a confident zero: an absent count and a
// measured zero answer different questions.
const countOrNull=(x:number|null)=>x===null?'—':n(x);
const timeOrNull=(x:number|null)=>x===null?'—':time(x);
type Tab='overview'|'sessions'|'models'|'projects'|'days'|'months'|'requests'|'tools'|'service'|'settings';
const tabs:[Tab,string][]=[['overview','仪表盘'],['sessions','会话'],['models','模型'],['projects','项目'],['days','按日'],['months','按月'],['requests','用量明细'],['tools','工具活动']];
function Metric({label,value,hint,icon}:{label:string;value:string;hint:string;icon:React.ReactNode}){return <div className="metric"><span>{icon}{label}</span><strong>{value}</strong><small>{hint}</small></div>}

export default function App(){
 const [boot,setBoot]=useState<Bootstrap|null>(null),[q,setQ]=useState<Query>(initialQuery),[response,setData]=useState<Dashboard|null>(null),[tab,setTab]=useState<Tab>('overview');
 const currency=currencyFromJson(boot?.prices),money=currency.money;
 const data=response&&sameQuery(response.query,q)?response:null;
 // Status rows are raw table content, so they are read once here and every reader below
 // uses the degraded shape instead of indexing fields that may not exist.
 const sourceRows=readScanStatusRows(data?.status);
 const [status,setStatus]=useState<Status>({running:false,scanning:false}),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
 // Every failure keeps its own slot, so one banner shows at a time and closing it
 // removes the message that was shown instead of an unrelated source that cannot be
 // dismissed (the old banner cleared two of its three sources).
 const [errors,setErrors]=useState<ErrorSlots>(emptyErrorSlots),[dismissedServer,setDismissedServer]=useState('');
 const visible=visibleError({...errors,server:serverErrorSlot(status.error,dismissedServer)});
 const fail=(slot:ErrorSlot,message:string)=>setErrors(current=>({...current,[slot]:message}));
 const clearError=(slot:ErrorSlot)=>setErrors(current=>current[slot]?{...current,[slot]:''}:current);
 const dismissBanner=()=>{if(!visible)return;if(visible.slot==='server')setDismissedServer(visible.message);setErrors(current=>dismissError(current,visible.slot));};
 const [theme,setTheme]=useState(()=>localStorage.getItem('tm-theme')||'light'),[selected,setSelected]=useState<SessionDetailRow|null>(null);
 const [priceText,setPriceText]=useState(''),[settings,setSettings]=useState<Settings|null>(null),[logs,setLogs]=useState('');
 // Bumped when prices are saved so the detail page re-reads its costs without losing its place.
 const [pricingRevision,setPricingRevision]=useState(0);
 const [priceError,setPriceError]=useState('');
 // Range validation belongs next to the fields it describes, not in the shared banner
 // where the next background poll would overwrite it.
 const [rangeError,setRangeError]=useState('');
 const [startText,setStartText]=useState(localInput(q.start)),[endText,setEndText]=useState(localInput(q.end));
 // Search is typed into a draft and reaches the query only after a pause, so a filter
 // change costs one query instead of one per keystroke.
 const [searchDraft,setSearchDraft]=useState(q.search),[searchApplied,setSearchApplied]=useState(q.search);
 if(searchApplied!==q.search){setSearchApplied(q.search);setSearchDraft(q.search);}
 const [commitSearch]=useState(()=>debounce((text:string)=>{setSearchApplied(text);setQ(current=>current.search===text?current:{...current,search:text});},SEARCH_DEBOUNCE_MS));
 useEffect(()=>()=>commitSearch.cancel(),[commitSearch]);
 useLayoutEffect(()=>{window.scrollTo({top:0,left:0,behavior:'instant'});},[tab,q.agent]);
 useEffect(()=>{const m=matchMedia('(prefers-color-scheme: dark)');const apply=()=>{document.documentElement.classList.toggle('dark',theme==='dark'||(theme==='system'&&m.matches));document.documentElement.style.colorScheme=theme==='system'?(m.matches?'dark':'light'):theme;};apply();m.addEventListener('change',apply);localStorage.setItem('tm-theme',theme);return()=>m.removeEventListener('change',apply);},[theme]);
 const [loader]=useState(()=>latestLoader<Query,Dashboard>(sameQuery,query=>request<Dashboard>('dashboard',{query}),result=>{setData(result);clearError('query');},e=>fail('query',String(e))));
 const refresh=useCallback((force=false)=>loader.run(q,force),[q,loader]);
 useEffect(()=>{request<Bootstrap>('bootstrap').then(b=>{setBoot(b);setPriceText(b.prices);setSettings(b.settings);}).catch(e=>fail('query',String(e)));},[]);
 useEffect(()=>{setStartText(localInput(q.start));setEndText(localInput(q.end));void refresh();},[q,refresh]);
 useEffect(()=>{const poll=()=>{void request<Status>('status').then(s=>{setStatus(s);clearError('status');}).catch(e=>fail('status',`读取后台状态失败：${String(e)}`));};poll();const timer=setInterval(poll,2000);return()=>clearInterval(timer);},[]);
 useEffect(()=>{const timer=setInterval(()=>void refresh(),5000);return()=>clearInterval(timer);},[refresh]);
 useEffect(()=>{let cancelled=false;if(tab==='service')request<{text:string}>('logs').then(r=>{if(!cancelled)setLogs(r.text);}).catch(e=>{if(!cancelled)fail('query',String(e));});return()=>{cancelled=true;};},[tab,data]);
 // A confirmation is not state: it leaves on its own so it cannot hide a later failure.
 useEffect(()=>{if(!notice)return;const timer=setTimeout(()=>setNotice(''),NOTICE_TTL_MS);return()=>clearTimeout(timer);},[notice]);
 async function action(method:string,args:unknown={},onError?:(message:string)=>void){setBusy(true);clearError('action');try{await request(method,args);await refresh(true);setStatus(await request<Status>('status'));return true;}catch(e){fail('action',String(e));onError?.(String(e));return false;}finally{setBusy(false);}}
 function chooseAgent(agent:string|null){setQ({...q,agent,model:null,project:null,session:null,search:''});setTab('overview');}
 function quick(minutes:number){setQ({...q,...preset(minutes)});}
 function applyRange(){const start=new Date(startText).getTime(),end=new Date(endText).getTime();if(!Number.isFinite(start)||!Number.isFinite(end)||start>=end){setRangeError('请选择有效时间范围，开始时间必须早于结束时间。');return;}setRangeError('');setQ({...q,...windowOf(start,end)});}
 function drill(row:Summary,kind:Tab){
   if(kind==='models'){setQ({...q,model:row.key,session:null});setTab('sessions');}
   else if(kind==='projects'){setQ({...q,project:row.key,session:null});setTab('sessions');}
   else if(kind==='days'||kind==='months'){const range=row.rangeStart!=null&&row.rangeEnd!=null?{start:row.rangeStart,end:row.rangeEnd}:dateRange(row.key,kind==='months');setQ({...q,...windowOf(Math.max(range.start,q.start),Math.min(range.end,q.end)),session:null});setTab('sessions');}
   else if(kind==='sessions'){
    if(row.agent==='codex'){setSelected({path:row.path,sessionId:row.session,threadName:row.label,modifiedAtMs:row.lastTs,sizeBytes:0,inputTokens:row.tokens.input+row.tokens.cached+row.tokens.cacheWrite,cachedInputTokens:row.tokens.cached,outputTokens:row.tokens.output,reasoningOutputTokens:row.tokens.reasoning,totalTokens:row.totalTokens,costUSD:row.knownCostUsd,models:[],projects:[],dailyUsage:[]});}
    else{setQ({...q,agent:row.agent,session:row.session});setTab('requests');}
   }
 }
 async function savePrices(){setPriceError('');if(await action('save_prices',{text:priceText},setPriceError)){setBoot(b=>b?{...b,prices:priceText}:b);setNotice('价格、币种和汇率已保存，查询费用已重新计算');setPricingRevision(r=>r+1);}}
 async function exportData(format:'csv'|'xlsx'|'markdown'){
  try{const extension=format==='markdown'?'md':format;const path=await save({defaultPath:`TokenMonitor-${q.agent||'all'}.${extension}`,filters:[{name:extension.toUpperCase(),extensions:[extension]}]});if(path&&await action('export',{query:q,format,path}))setNotice(`已导出到 ${path}`);}catch(e){fail('action',`导出失败：${String(e)}`);}
 }
 const label=q.agent?(boot?.agents.find(([id])=>id===q.agent)?.[1]||q.agent):'全部 Agent';const t=data?.totals;
 const filters=Boolean(q.model||q.project!==null||q.session||q.search);
 function table(rows:Summary[],kind:Tab){return <SummaryTable key={kind} rows={rows} kind={kind as SummaryKind} onDrill={drill}/>; }
 return <CurrencyContext.Provider value={currency}><div className="app-shell">
  <aside className="sidebar"><div className="brand"><div className="brand-icon"><BarChart3 size={22}/></div><div><b>TokenMonitor</b><small>LOCAL AGENT ANALYTICS</small></div></div><nav className="sidebar-nav" aria-label="Agent 导航"><div className="sidebar-label">工作空间</div><button className={`side-item ${q.agent===null&&tab!=='service'&&tab!=='settings'?'active':''}`} onClick={()=>chooseAgent(null)}><Layers size={18}/>综合总览</button><div className="sidebar-label">Agent 工具</div>{(boot?.agents||[['codex','Codex']]).map(([id,name])=><button key={id} className={`side-item ${q.agent===id&&tab!=='service'&&tab!=='settings'?'active':''}`} onClick={()=>chooseAgent(id)}><Cpu size={16}/>{name}<span className={`source-dot ${sourceRows.find(s=>s.agent===id)?.state==='ready'?'ready':''}`}/></button>)}</nav><div className="sidebar-bottom"><button className={`side-item ${tab==='service'?'active':''}`} onClick={()=>setTab('service')}><Terminal size={17}/>日志</button><button className={`side-item ${tab==='settings'?'active':''}`} onClick={()=>setTab('settings')}><Settings2 size={17}/>设置与模型价格</button><div className="offline"><ShieldCheck size={15}/>纯本地 · 无网络请求</div></div></aside>
  <main className="workspace"><ErrorBoundary key={tab} label="分析界面"><header className="topbar"><div className="breadcrumb">本地用量 <ChevronRight size={14}/><strong>{tab==='settings'?'设置':tab==='service'?'日志':label}</strong></div><div className="header-actions"><div className="service-controls" aria-label="后台控制"><button className="primary" disabled={busy||status.running} onClick={()=>void action('start')}><Play size={15}/>启动</button><button className="secondary" disabled={busy||!status.running} onClick={()=>void action('stop')}><Square size={15}/>停止</button><button className="secondary" disabled={busy||status.stopping} onClick={()=>void action('restart')}><RefreshCw size={15}/>重启</button></div><span className={`status ${status.running?'online':''}`}><i/>{status.stopping?'正在停止':status.scanning?'正在扫描':status.running?'后台运行中':'后台已停止'}</span><button className="icon-button" title="切换浅色/深色" aria-label="切换浅色或深色主题" onClick={()=>setTheme(theme==='dark'?'light':'dark')}>{theme==='dark'?<Moon size={17}/>:<Sun size={17}/>}</button><button className="primary" disabled={busy||status.scanning} onClick={()=>void action('scan')}><RefreshCw size={15} className={status.scanning?'spin':''}/>{status.scanning?'扫描中':'扫描本地日志'}</button></div></header>
   {visible&&<div role="alert" className="banner error">{visible.message}<button className="icon-button" aria-label="关闭错误" onClick={dismissBanner}><X size={15}/></button></div>}{notice&&<div role="status" className="banner">{notice}<button className="icon-button" aria-label="关闭提示" onClick={()=>setNotice('')}><X size={15}/></button></div>}
   {tab!=='settings'&&tab!=='service'&&<><section className="page-heading"><div><p className="eyebrow">{q.agent==='codex'?'CODEX WORKSPACE':'USAGE EXPLORER'}</p><h1>{label} 用量分析</h1><p>从每条本地记录出发，看清时间、模型、项目和会话中的消耗。</p></div><div className="exports"><ArrowDownToLine size={15}/><button onClick={()=>void exportData('xlsx')}>Excel</button><button onClick={()=>void exportData('csv')}>CSV</button><button onClick={()=>void exportData('markdown')}>Markdown</button></div></section>
    <section className="filters"><div className="presets">{[[300,'近 5 小时'],[1440,'近 24 小时'],[10080,'近 7 天'],[43200,'近 30 天']] .map(([m,l])=><button key={m} className={q.end-q.start===Number(m)*60000?'selected':''} onClick={()=>quick(Number(m))}>{l}</button>)}</div><div className="date-fields"><label>开始<input aria-label="开始时间" type="datetime-local" step="60" value={startText} onChange={e=>setStartText(e.target.value)}/></label><span>→</span><label>结束（不含）<input aria-label="结束时间" type="datetime-local" step="60" value={endText} onChange={e=>setEndText(e.target.value)}/></label><button className="secondary" onClick={applyRange}>查询</button></div><small>本地时区 · 精确到分钟 · 起止时间固定，点击快捷周期更新至当前分钟</small>{rangeError&&<p role="alert" className="error-text">{rangeError}</p>}</section>
    <div className="subnav">{tabs.map(([id,name])=><button key={id} className={tab===id?'active':''} onClick={()=>setTab(id)}>{name}</button>)}</div>
    {filters&&<div className="filter-chips"><span>筛选：{[q.model,q.project,q.session,q.search].filter(x=>x!==null&&x!=='').join(' / ')}</span><button onClick={()=>setQ({...q,model:null,project:null,session:null,search:''})}><X size={13}/>清除筛选</button></div>}
    {!data?(errors.query?<FailureNotice title="本地数据读取失败" message={errors.query} onRetry={()=>void refresh(true)}/>:<Empty text="正在读取本地缓存…" hint="首次使用需要扫描本机日志，读取完成后会自动显示。"/>):<>
     {tab==='overview'&&<><section className="hero panel"><div className="hero-summary"><p className="eyebrow">{label} · 使用概览</p><div className="hero-value">{compact(t!.totalTokens)}<span>tokens</span></div><p className="hero-cost">{money(t!.knownCostUsd)} <span>本地价格估算 · {currency.code}</span></p>{t!.unpricedEvents>0&&<p className="pricing-note">仅合计已定价用量；另有 {n(t!.unpricedEvents)} 条未定价，共 {n(t!.unpricedTokens)} Tokens，未计入费用。<button onClick={()=>setTab('settings')}>配置模型价格 →</button></p>}<div className="distribution"><h3>主要消耗项目</h3>{[...data.projects].sort((a,b)=>b.totalTokens-a.totalTokens).slice(0,3).map((p,i)=><button key={p.key} onClick={()=>drill(p,'projects')}><div><span>{i+1}. {p.label.split(/[\\/]/).filter(Boolean).at(-1)||'未记录项目'}</span><b>{compact(p.totalTokens)}</b></div><div className="bar-track"><i style={{width:`${t!.totalTokens?p.totalTokens/t!.totalTokens*100:0}%`}}/></div></button>)}</div></div><UsageTrend data={data}/></section>
      <section className="metrics"><Metric icon={<Layers size={16}/>} label="用量记录" value={n(t!.events)} hint={`${data.sessions.length} 个会话 · ${data.models.length} 个模型`}/><Metric icon={<Database size={16}/>} label="缓存命中" value={`${(t!.tokens.cached/Math.max(1,t!.tokens.input+t!.tokens.cached+t!.tokens.cacheWrite)*100).toFixed(1)}%`} hint={`${n(t!.tokens.cached)} 缓存读取 tokens`}/><Metric icon={<Clock3 size={16}/>} label="平均每分钟" value={compact(t!.totalTokens/Math.max(1,(q.end-q.start)/60000))} hint={`选定 ${(q.end-q.start)/60000} 分钟`}/><Metric icon={<Coins size={16}/>} label="百万 Tokens 成本" value={t!.costUsd==null?'未完整定价':money(t!.knownCostUsd/Math.max(1,t!.totalTokens)*1e6)} hint="估算费用，不代表实际账单"/></section>
      {q.agent==='codex'&&<QuotaPanel data={data}/>}
      {!q.agent&&<section className="panel"><div className="panel-heading"><h2>Agent 用量分布</h2><span>选择一个工具查看独立明细</span></div><div className="agent-grid">{(boot?.agents||[]).map(([id,name])=>{const a=data.agents.find(a=>a.key===id);return <button key={id} className="agent-card" onClick={()=>chooseAgent(id)}><Cpu size={18}/><b>{name}</b><strong>{compact(a?.totalTokens||0)}</strong><span>{a?`${a.events} 条用量`:'选定范围内无记录'}</span></button>})}</div></section>}
      <section className="panel"><div className="panel-heading"><h2>模型消耗</h2><button onClick={()=>setTab('models')}>查看全部 →</button></div>{table(data.models,'models')}</section>
     </>}
     {(['models','projects','days','months','sessions'] as Tab[]).includes(tab)&&<section className="panel"><div className="panel-heading"><h2>{tabs.find(([id])=>id===tab)?.[1]}用量明细</h2><label className="search"><Search size={15}/><input aria-label="搜索" placeholder="搜索标题 / 模型 / 项目 / 会话 ID" value={searchDraft} onChange={e=>{setSearchDraft(e.target.value);commitSearch(e.target.value);}} onKeyDown={e=>{if(e.key==='Enter')commitSearch.flush();}}/></label></div>{table(data[tab as 'models'|'projects'|'days'|'months'|'sessions'],tab)}</section>}
     {tab==='requests'&&<EventDetailTable query={q} revision={pricingRevision} onFilterSession={(agent,session)=>setQ({...q,agent,session})} onReveal={path=>void action('reveal',{path})}/>}
     {tab==='tools'&&<section className="panel"><div className="panel-heading"><h2>工具调用活动</h2><span>仅展示日志实际记录的调用；按模型/项目筛选时按会话关联</span></div>{q.agent==='antigravity'?<Empty text="Antigravity 的本地用量库未提供已验证的工具调用字段"/>:<><details><summary>全部工具调用次数 · {n(data.activityCount)} 条</summary><div className="tool-counts">{Object.entries(data.tools).sort((a,b)=>b[1]-a[1]).map(([name,count])=><span key={name}><Terminal size={14}/>{name}<b>{n(count)}</b></span>)}</div></details><ActivityTable query={q} onReveal={path=>void action('reveal',{path})}/></>}</section>}
    </>}
   </>}
   {tab==='service'&&<><section className="page-heading"><div><p className="eyebrow">LOCAL LOGS</p><h1>日志</h1><p>查看后台运行状态、数据来源和本地采集日志。</p></div></section><section className="panel service-panel"><div><h2>{status.stopping?'后台正在停止':status.running?'后台正在运行':'后台已停止'}</h2><p>127.0.0.1:{settings?.port} · {status.pid?`PID ${status.pid}`:'未连接'} · {status.scanning?'扫描中':'空闲'}</p></div></section><section className="panel"><div className="panel-heading"><h2>数据来源状态</h2><span>找不到来源不等同于用量为零</span></div><div className="source-list">{sourceRows.map((s,index)=><div key={`${s.agent}:${index}`}><b>{s.agent}</b><span>{({ready:'已索引',warning:'部分成功（存在无效记录）',scanning:'扫描中',missing:'未发现文件',error:'读取异常',disabled:'已禁用',stopped:'已停止'} as Record<string,string>)[s.state]||s.state}</span><small>{countOrNull(s.files)} 文件 · {countOrNull(s.reused)} 复用 · {countOrNull(s.malformedLines)} 无效行 · {timeOrNull(s.updatedAt)}</small>{s.partial&&<p className="error-text">此来源的状态由旧版本写入，部分字段无法读取，请重新扫描。</p>}{s.errors.map((e,i)=><p key={i} className="error-text">{e}</p>)}{s.unreadableErrors>0&&<p className="error-text">另有 {s.unreadableErrors} 条错误记录无法解析。</p>}</div>)}</div></section><section className="panel"><div className="panel-heading"><h2>服务日志</h2><button onClick={()=>void request<{text:string}>('logs').then(r=>setLogs(r.text))}>刷新</button></div><pre className="logs">{logs||'暂无日志'}</pre></section></>}
   {tab==='settings'&&settings&&<><section className="page-heading"><div><p className="eyebrow">PREFERENCES</p><h1>设置与模型价格</h1><p>所有配置保存在本机。修改价格无需重新扫描日志。</p></div></section><section className="panel settings-panel"><h2>外观与运行</h2><div className="settings-grid"><label>主题<select value={theme} onChange={e=>setTheme(e.target.value)}><option value="light">浅色</option><option value="dark">深色</option><option value="system">跟随系统</option></select></label><label>本地服务端口<input type="number" min="1" max="65535" value={settings.port} onChange={e=>setSettings({...settings,port:Number(e.target.value)})}/></label><label>扫描间隔（秒）<input type="number" min="10" max="86400" value={settings.refreshSeconds} onChange={e=>setSettings({...settings,refreshSeconds:Number(e.target.value)})}/></label><label className="checkbox"><input type="checkbox" checked={boot?.autostart||false} onChange={async e=>{const enabled=e.target.checked;if(await action('autostart',{enabled}))setBoot(b=>b?{...b,autostart:enabled}:b);}}/>登录后自动启动并留在托盘</label></div><p className="muted">缓存与配置：{boot?.dataDir}</p></section><section className="panel settings-panel"><h2>币种与汇率</h2><CurrencySettings text={priceText} onChange={setPriceText}/><button className="primary" disabled={busy} onClick={()=>void savePrices()}>保存币种、汇率与价格</button>{priceError&&<p role="alert" className="error-text">{priceError}</p>}</section><section className="panel settings-panel"><h2>本地 Agent 数据目录</h2><p>每行一个绝对路径。Codex 可配置 sessions、archived_sessions 或其他本地日志根目录。SQLite 来源选择数据库文件。</p>{boot?.agents.map(([id,name])=><div className="source-setting" key={id}><label className="checkbox"><input type="checkbox" checked={!settings.disabledAgents.includes(id)} onChange={e=>setSettings({...settings,disabledAgents:e.target.checked?settings.disabledAgents.filter(a=>a!==id):[...settings.disabledAgents,id]})}/>{name}</label><textarea aria-label={`${name} 数据路径`} rows={id==='antigravity'?3:2} value={(settings.roots[id]||[]).join('\n')} onChange={e=>setSettings({...settings,roots:{...settings.roots,[id]:e.target.value.split('\n')}})}/></div>)}<button className="primary" disabled={busy} onClick={async()=>{if(await action('save_settings',{...settings,roots:Object.fromEntries(Object.entries(settings.roots).map(([id,paths])=>[id,paths.map(p=>p.trim()).filter(Boolean)]))}))setNotice('设置已保存');}}>保存运行与数据源设置</button></section><PriceCatalog text={boot?.prices||''}/><section className="panel settings-panel"><h2>模型价格 JSON</h2><p>价格单位为对应 currency / 百万 Tokens。每个模型可配置多条生效价格；不填写 effectiveFrom 的记录作为基础价格。零价格表示免费，缺少模型表示未知。</p><details><summary>查看配置示例</summary><pre>{JSON.stringify({version:1,currency:'USD',displayCurrency:'CNY',usdCny:7,aliases:{'日志中的模型名':'my-model'},models:{'my-model':[{currency:'CNY',input:1,cached:0.1,cacheWrite:1.25,output:4},{currency:'CNY',effectiveFrom:'2026-09-20T00:00:00+08:00',input:2,cached:0.2,cacheWrite:2.5,output:8}]}},null,2)}</pre><small>示例汇率与价格仅演示格式，不代表当前汇率或官方价格。</small></details><textarea className="price-editor" aria-label="模型价格 JSON" spellCheck={false} value={priceText} onChange={e=>setPriceText(e.target.value)}/><button className="primary" disabled={busy} onClick={()=>void savePrices()}>验证并保存价格</button>{priceError&&<p role="alert" className="error-text" style={{marginTop:12}}>{priceError}</p>}</section></>}
   <footer><span><HardDrive size={13}/>数据留在你的电脑上</span><span>TokenMonitor 2.0 · 本地日志统计 / JSON 定价</span></footer>
  </ErrorBoundary></main>{selected&&<ErrorBoundary label="会话回放" onClose={()=>setSelected(null)}><SessionDetailModal query={q} session={selected} onClose={()=>setSelected(null)}/></ErrorBoundary>} {busy&&<div className="busy-toast" role="status" aria-live="polite"><Loader2 className="spin" size={16}/>正在处理…</div>}
 </div></CurrencyContext.Provider>
}

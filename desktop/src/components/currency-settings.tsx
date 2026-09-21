import { useState } from 'react';
import { parseExchangeRateDraft } from '../lib/rate-draft';

function readConfig(text:string):Record<string,unknown>|null {
  try {
    const config:unknown=JSON.parse(text);
    return config&&typeof config==='object'&&!Array.isArray(config)?config as Record<string,unknown>:null;
  } catch { return null; }
}

// The rate field keeps its own text so an in-progress decimal such as "7." survives
// the round trip through the parsed price JSON. A `type="number"` input bound to the
// parsed value drops the decimal separator, which turned "7.2" into "72" and inflated
// every CNY cost by a factor of ten.
function ExchangeRateField({value,onCommit}:{value:number|null;onCommit:(value:number|null)=>void}) {
  const [draft,setDraft]=useState(value===null?'':String(value));
  const [committed,setCommitted]=useState<number|null>(value);
  // An edit made elsewhere (the JSON editor, a saved bootstrap) wins over this draft.
  if(committed!==value) { setCommitted(value); setDraft(value===null?'':String(value)); }
  const parsed=parseExchangeRateDraft(draft);
  return <label>本地汇率：1 USD = 多少 CNY
    <input
      aria-label="美元兑人民币本地汇率"
      aria-invalid={!parsed.ok}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      placeholder="请输入采用的汇率"
      value={draft}
      onChange={event=>{
        const text=event.target.value;
        setDraft(text);
        const next=parseExchangeRateDraft(text);
        // Unparseable or half-typed text leaves the stored rate untouched; only an
        // emptied field clears it.
        if(!next.ok||(next.value===null&&text.trim()!=='')) return;
        onCommit(next.value);
      }}
      onBlur={event=>setDraft(parseExchangeRateDraft(event.target.value).display)}
    />
    {!parsed.ok&&<span className="table-note">汇率只能填写十进制数字，例如 7.2。</span>}
  </label>;
}

export function CurrencySettings({text,onChange}:{text:string;onChange:(text:string)=>void}) {
  const config=readConfig(text);
  if(!config) return <p className="table-note">请先修正下方 JSON，才能编辑币种和汇率。</p>;
  const update=(key:string,value:unknown)=>onChange(JSON.stringify({...config,[key]:value},null,2));
  const rate=typeof config.usdCny==='number'&&Number.isFinite(config.usdCny)?config.usdCny:null;
  return <div className="settings-grid">
    <label>统一显示币种<select aria-label="统一显示币种" value={String(config.displayCurrency||'USD').toUpperCase()} onChange={e=>update('displayCurrency',e.target.value)}><option value="USD">美元 USD</option><option value="CNY">人民币 CNY</option></select></label>
    <ExchangeRateField value={rate} onCommit={value=>update('usdCny',value)}/>
    <p className="table-note">手动汇率，不联网更新。下方保存后应用于所有页面和导出，也重新换算历史用量；原始价格数字不变。每条模型价格可用 currency 指定 USD 或 CNY，省略时使用 JSON 顶层 currency。</p>
  </div>;
}

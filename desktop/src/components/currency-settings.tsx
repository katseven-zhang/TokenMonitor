export function CurrencySettings({text,onChange}:{text:string;onChange:(text:string)=>void}) {
  let config:Record<string,unknown>;
  try { config=JSON.parse(text); if(!config||typeof config!=='object'||Array.isArray(config)) return null; } catch { return <p className="table-note">请先修正下方 JSON，才能编辑币种和汇率。</p>; }
  const update=(key:string,value:unknown)=>onChange(JSON.stringify({...config,[key]:value},null,2));
  return <div className="settings-grid">
    <label>统一显示币种<select aria-label="统一显示币种" value={String(config.displayCurrency||'USD').toUpperCase()} onChange={e=>update('displayCurrency',e.target.value)}><option value="USD">美元 USD</option><option value="CNY">人民币 CNY</option></select></label>
    <label>本地汇率：1 USD = 多少 CNY<input aria-label="美元兑人民币本地汇率" type="number" min="0.000001" step="any" placeholder="请输入采用的汇率" value={typeof config.usdCny==='number'?config.usdCny:''} onChange={e=>update('usdCny',e.target.value===''?null:Number(e.target.value))}/></label>
    <p className="table-note">手动汇率，不联网更新。下方保存后应用于所有页面和导出，也重新换算历史用量；原始价格数字不变。每条模型价格可用 currency 指定 USD 或 CNY，省略时使用 JSON 顶层 currency。</p>
  </div>;
}

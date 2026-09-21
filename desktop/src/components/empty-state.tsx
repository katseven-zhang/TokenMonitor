import { Database } from 'lucide-react';

// Extracted from App so a panel that is still loading can be tested apart from a panel
// that genuinely has no rows.
export function Empty({text='这个时间范围内没有用量记录',hint='选择其他时间范围，或在设置中检查本地数据目录。'}:{text?:string;hint?:string}={}) {
  return <div className="empty"><Database size={32}/><h3>{text}</h3><p>{hint}</p></div>;
}

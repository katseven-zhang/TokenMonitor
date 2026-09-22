import { Database } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// Extracted from App so a panel that is still loading can be tested apart from a panel
// that genuinely has no rows. The defaults are locale keys, not baked-in Chinese: this
// component is the empty state every table falls back to (task #72).
export function Empty({text,hint}:{text?:string;hint?:string}={}) {
  const {t}=useTranslation();
  return <div className="empty"><Database size={32}/><h3>{text??t('empty.usage_title')}</h3><p>{hint??t('empty.usage_hint')}</p></div>;
}

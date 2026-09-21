import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { minutesUntilReset } from '../lib/quota-observations';
import { sharedQuotaClock, type QuotaClock } from '../lib/quota-clock';
import { formatTimestamp } from '../lib/localized-format';

/**
 * The only part of the quota panel that cares what time it is. Task #72 criterion 8 moved
 * the one-second tick out of `QuotaPanel` and into this leaf so a passing second cannot
 * re-render the up-to-500-row observation history that sits next to it. It subscribes to a
 * shared reference-counted clock, so three windows still cost one timer.
 */
export function QuotaWindowCountdown({ reset, language, clock = sharedQuotaClock() }:{reset:number|null;language:string;clock?:QuotaClock}) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => clock.now());
  useEffect(() => clock.subscribe(setNow), [clock]);
  if (reset === null) return <>{t('quota.reset_unrecorded')}</>;
  const minutes = minutesUntilReset(now, reset);
  return <>{formatTimestamp(reset, language)} · {minutes === 0 ? t('quota.reset_passed') : t('quota.reset_in_minutes',{minutes})}</>;
}

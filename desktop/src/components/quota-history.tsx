import { useTranslation } from 'react-i18next';
import { quotaWindowName, type QuotaHistoryRow } from '../lib/quota-observations';
import { formatTimestamp } from '../lib/localized-format';

/**
 * The observation history table, kept apart from the countdown on purpose: it renders up to
 * 500 rows and reads nothing but its rows and the active language, so a per-second tick has
 * no way to reach it. A missing percentage or reset timestamp stays a visible gap.
 */
export function QuotaHistoryTable({ rows, language }:{rows:QuotaHistoryRow[];language:string}) {
  const { t } = useTranslation();
  if (!rows.length) return <p className="table-note">{t('quota.history_empty')}</p>;
  const percent = (value:number|null) => value === null ? t('quota.unknown') : `${value.toFixed(1)}%`;
  return <div className="table-wrap quota-history-table"><table>
    <thead><tr>
      <th>{t('quota.col_observed')}</th><th>{t('quota.col_window')}</th><th>{t('quota.col_used')}</th>
      <th>{t('quota.col_remaining')}</th><th>{t('quota.col_reset')}</th><th>{t('quota.col_session')}</th>
    </tr></thead>
    <tbody>{rows.map((row,index)=><tr key={`${row.ts}:${row.session}:${row.key}:${index}`}>
      <td>{formatTimestamp(row.ts, language)}</td><td>{quotaWindowName(row,t)}</td>
      <td className="number">{percent(row.used)}</td><td className="number">{percent(row.remaining)}</td>
      <td>{row.reset === null ? t('quota.unrecorded') : formatTimestamp(row.reset, language)}</td>
      <td className="long-cell">{row.session}</td>
    </tr>)}</tbody>
  </table></div>;
}

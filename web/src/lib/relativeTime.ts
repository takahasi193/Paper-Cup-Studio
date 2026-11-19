const rtf =
  typeof Intl !== 'undefined' && typeof Intl.RelativeTimeFormat === 'function'
    ? new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' })
    : null;

export function formatRelativeTime(isoOrDate: string): string {
  if (!isoOrDate) return '';
  const time = Date.parse(isoOrDate);
  if (!Number.isFinite(time)) return '';

  const diffSec = Math.round((time - Date.now()) / 1000);
  const absSec = Math.abs(diffSec);

  if (!rtf) {
    return new Date(time).toLocaleDateString('zh-CN');
  }

  if (absSec < 45) return '刚刚';
  if (absSec < 3600) return rtf.format(Math.round(diffSec / 60), 'minute');
  if (absSec < 86400) return rtf.format(Math.round(diffSec / 3600), 'hour');
  if (absSec < 2592000) return rtf.format(Math.round(diffSec / 86400), 'day');
  if (absSec < 31536000) return rtf.format(Math.round(diffSec / 2592000), 'month');
  return rtf.format(Math.round(diffSec / 31536000), 'year');
}

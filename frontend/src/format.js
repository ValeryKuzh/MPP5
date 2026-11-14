const compact = new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 });
const full = new Intl.NumberFormat('ru-RU');
const dateFmt = new Intl.DateTimeFormat('ru-RU', { year: 'numeric', month: 'short', day: 'numeric' });
const dateTimeFmt = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'medium' });

export const num = (v) => (v == null ? '—' : full.format(v));
export const short = (v) => (v == null ? '—' : compact.format(v));
export const date = (v) => (v ? dateFmt.format(new Date(v)) : '—');
export const dateTime = (v) => (v ? dateTimeFmt.format(new Date(v)) : '—');

export function ago(v) {
  if (!v) return '—';
  const diff = (Date.now() - new Date(v).getTime()) / 1000;
  const units = [
    [31536000, 'г.'],
    [2592000, 'мес.'],
    [86400, 'дн.'],
    [3600, 'ч.'],
    [60, 'мин.'],
  ];
  for (const [sec, label] of units) if (diff >= sec) return `${Math.floor(diff / sec)} ${label} назад`;
  return 'только что';
}

/** Ссылка на страницу репозитория: /repos/owner/name */
export const repoPath = (fullName) => `/repos/${fullName}`;
export const packagePath = (name) => `/packages/${name}`;

const dtf = new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short' });
const df = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' });

export const fmtDateTime = (iso: string | null | undefined): string => (iso ? dtf.format(new Date(iso)) : '–');
export const fmtDate = (iso: string | null | undefined): string => (iso ? df.format(new Date(iso)) : '–');

export function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return '–';
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  const label = mins < 1 ? 'gerade eben' : mins < 60 ? `${mins} Min.` : mins < 48 * 60 ? `${Math.round(mins / 60)} Std.` : `${Math.round(mins / 1440)} Tagen`;
  if (mins < 1) return label;
  return diff > 0 ? `in ${label}` : `vor ${label}`;
}

export const fmtUsd = (v: number | null | undefined, digits = 2): string =>
  v == null ? '–' : `$${v.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: Math.max(digits, 4) })}`;

export const fmtNum = (v: number | null | undefined): string => (v == null ? '–' : Math.round(v).toLocaleString('de-DE'));

export function fmtTokens(v: number | null | undefined): string {
  if (v == null) return '–';
  if (v >= 1_000_000) return `${(v / 1_000_000).toLocaleString('de-DE', { maximumFractionDigits: 2 })} Mio.`;
  if (v >= 10_000) return `${Math.round(v / 1000).toLocaleString('de-DE')} Tsd.`;
  return v.toLocaleString('de-DE');
}

export function fmtDuration(fromIso: string | null, toIso: string | null): string {
  if (!fromIso) return '–';
  const ms = (toIso ? new Date(toIso).getTime() : Date.now()) - new Date(fromIso).getTime();
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${s % 60} s`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}

export const pct = (v: number | null | undefined): string => (v == null ? '–' : `${Math.round(v)} %`);

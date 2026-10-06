import type { Schedule } from '../../shared/domain.ts';

/** Berechnet den nächsten Ausführungszeitpunkt eines Zeit-Triggers (lokale Zeit des Servers). */
export function computeNextRun(s: Pick<Schedule, 'kind' | 'interval_minutes' | 'time_of_day' | 'weekday' | 'day_of_month'>, from: Date): Date | null {
  const [h, m] = parseTime(s.time_of_day);
  switch (s.kind) {
    case 'interval': {
      const minutes = Math.max(5, Number(s.interval_minutes) || 0);
      return new Date(from.getTime() + minutes * 60_000);
    }
    case 'daily': {
      const d = new Date(from.getFullYear(), from.getMonth(), from.getDate(), h, m);
      if (d <= from) d.setDate(d.getDate() + 1);
      return d;
    }
    case 'weekly': {
      const target = Math.min(7, Math.max(1, Number(s.weekday) || 1)); // 1 = Montag … 7 = Sonntag
      const d = new Date(from.getFullYear(), from.getMonth(), from.getDate(), h, m);
      const iso = d.getDay() || 7;
      d.setDate(d.getDate() + ((target - iso + 7) % 7));
      if (d <= from) d.setDate(d.getDate() + 7);
      return d;
    }
    case 'monthly': {
      const day = Math.min(28, Math.max(1, Number(s.day_of_month) || 1));
      const d = new Date(from.getFullYear(), from.getMonth(), day, h, m);
      if (d <= from) d.setMonth(d.getMonth() + 1);
      return d;
    }
    default:
      return null;
  }
}

function parseTime(t: string | null): [number, number] {
  const match = /^(\d{1,2}):(\d{2})$/.exec((t ?? '').trim());
  if (!match) return [8, 0];
  return [Math.min(23, Number(match[1])), Math.min(59, Number(match[2]))];
}

export function describeSchedule(s: Schedule): string {
  const days = ['', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
  switch (s.kind) {
    case 'interval':
      return `alle ${s.interval_minutes} Minuten`;
    case 'daily':
      return `täglich um ${s.time_of_day}`;
    case 'weekly':
      return `jeden ${days[s.weekday ?? 1]} um ${s.time_of_day}`;
    case 'monthly':
      return `monatlich am ${s.day_of_month}. um ${s.time_of_day}`;
    default:
      return s.kind;
  }
}

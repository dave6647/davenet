import type { Db } from '../db/database.ts';
import { nowIso } from '../db/database.ts';
import type { FinanceEntry, FinanceKind, FinanceTotals } from '../../shared/domain.ts';
import { NotFoundError, numOrNull } from './util.ts';

// ---------------------------------------------------------------- Einnahmen, Ausgaben und Owner-Zeit je Produkt

function mapEntry(r: Record<string, unknown>): FinanceEntry {
  return {
    ...(r as unknown as FinanceEntry),
    opportunity_id: (r.opportunity_id as string) ?? null,
    amount_eur: numOrNull(r.amount_eur),
    hours: numOrNull(r.hours),
  };
}

export const emptyTotals = (): FinanceTotals => ({ revenue_eur: 0, expense_eur: 0, hours: 0, entries: 0 });

export interface FinanceFilter {
  opportunity_id?: string;
  kind?: FinanceKind;
  /** Datum ab (inklusive, YYYY-MM-DD). */
  from?: string;
  /** Datum bis (exklusive, YYYY-MM-DD). */
  to?: string;
}

function where(f: FinanceFilter): { sql: string; params: string[] } {
  const parts: string[] = [];
  const params: string[] = [];
  if (f.opportunity_id) {
    parts.push('opportunity_id = ?');
    params.push(f.opportunity_id);
  }
  if (f.kind) {
    parts.push('kind = ?');
    params.push(f.kind);
  }
  if (f.from) {
    parts.push('date >= ?');
    params.push(f.from);
  }
  if (f.to) {
    parts.push('date < ?');
    params.push(f.to);
  }
  return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params };
}

export class FinanceRepo {
  constructor(private readonly db: Db) {}

  create(e: Omit<FinanceEntry, 'id' | 'created_at'>): FinanceEntry {
    const r = this.db.run(
      'INSERT INTO finance_entries (opportunity_id, kind, amount_eur, hours, date, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      e.opportunity_id,
      e.kind,
      e.amount_eur,
      e.hours,
      e.date,
      e.note,
      nowIso(),
    );
    return this.require(r.lastInsertRowid);
  }

  get(id: number): FinanceEntry | undefined {
    const r = this.db.get('SELECT * FROM finance_entries WHERE id = ?', id);
    return r ? mapEntry(r) : undefined;
  }

  require(id: number): FinanceEntry {
    const e = this.get(id);
    if (!e) throw new NotFoundError(`Buchung #${id}`);
    return e;
  }

  delete(id: number): FinanceEntry {
    const e = this.require(id);
    this.db.run('DELETE FROM finance_entries WHERE id = ?', id);
    return e;
  }

  list(f: FinanceFilter & { limit?: number } = {}): FinanceEntry[] {
    const w = where(f);
    return this.db
      .all(`SELECT * FROM finance_entries ${w.sql} ORDER BY date DESC, id DESC LIMIT ?`, ...w.params, f.limit ?? 500)
      .map(mapEntry);
  }

  totals(f: FinanceFilter = {}): FinanceTotals {
    const w = where(f);
    const r = this.db.get<{ revenue: number | null; expense: number | null; hours: number | null; n: number }>(
      `SELECT SUM(CASE WHEN kind = 'revenue' THEN amount_eur END) AS revenue,
              SUM(CASE WHEN kind = 'expense' THEN amount_eur END) AS expense,
              SUM(CASE WHEN kind = 'time' THEN hours END) AS hours,
              COUNT(*) AS n
       FROM finance_entries ${w.sql}`,
      ...w.params,
    )!;
    return { revenue_eur: r.revenue ?? 0, expense_eur: r.expense ?? 0, hours: r.hours ?? 0, entries: r.n };
  }

  /** Summen je Opportunity (Schlüssel '' = Buchungen ohne Produktbezug). */
  totalsByOpportunity(f: Omit<FinanceFilter, 'opportunity_id'> = {}): Map<string, FinanceTotals> {
    const w = where(f);
    const rows = this.db.all<{ oid: string | null; revenue: number | null; expense: number | null; hours: number | null; n: number }>(
      `SELECT opportunity_id AS oid,
              SUM(CASE WHEN kind = 'revenue' THEN amount_eur END) AS revenue,
              SUM(CASE WHEN kind = 'expense' THEN amount_eur END) AS expense,
              SUM(CASE WHEN kind = 'time' THEN hours END) AS hours,
              COUNT(*) AS n
       FROM finance_entries ${w.sql}
       GROUP BY opportunity_id`,
      ...w.params,
    );
    return new Map(rows.map((r) => [r.oid ?? '', { revenue_eur: r.revenue ?? 0, expense_eur: r.expense ?? 0, hours: r.hours ?? 0, entries: r.n }]));
  }
}

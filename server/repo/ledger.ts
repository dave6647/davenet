import type { Db } from '../db/database.ts';
import { nowIso } from '../db/database.ts';
import type { BillingMode, UsageEvent } from '../../shared/domain.ts';
import { numOrNull, toBool } from './util.ts';

function mapUsage(r: Record<string, unknown>): UsageEvent {
  return {
    ...(r as unknown as UsageEvent),
    job_id: numOrNull(r.job_id),
    provider_units: numOrNull(r.provider_units),
    quota_remaining: numOrNull(r.quota_remaining),
    duration_ms: numOrNull(r.duration_ms),
    success: toBool(r.success),
  };
}

export interface UsageTotals {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  tool_calls: number;
  monetary_cost_usd: number;
  equivalent_cost_usd: number;
}

export type NewUsageEvent = Omit<UsageEvent, 'id' | 'ts'> & { ts?: string };

export const LEDGER_GROUPS = ['agent_id', 'provider_id', 'model_name', 'opportunity_id', 'job_type', 'day', 'month'] as const;
export type LedgerGroup = (typeof LEDGER_GROUPS)[number];

const SUMS = `COUNT(*) AS events, COALESCE(SUM(requests),0) AS requests, COALESCE(SUM(input_tokens),0) AS input_tokens,
  COALESCE(SUM(output_tokens),0) AS output_tokens, COALESCE(SUM(cache_read_tokens),0) AS cache_read_tokens,
  COALESCE(SUM(cache_write_tokens),0) AS cache_write_tokens, COALESCE(SUM(tool_calls),0) AS tool_calls,
  COALESCE(SUM(monetary_cost_usd),0) AS monetary_cost_usd, COALESCE(SUM(equivalent_cost_usd),0) AS equivalent_cost_usd`;

export class LedgerRepo {
  constructor(private readonly db: Db) {}

  add(e: NewUsageEvent): UsageEvent {
    const r = this.db.run(
      `INSERT INTO usage_events (ts, job_id, job_type, agent_id, provider_id, model_id, model_name, opportunity_id, purpose,
        billing_mode, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, requests, tool_calls, provider_units,
        monetary_cost_usd, equivalent_cost_usd, quota_period, quota_remaining, duration_ms, success)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      e.ts ?? nowIso(),
      e.job_id,
      e.job_type,
      e.agent_id,
      e.provider_id,
      e.model_id,
      e.model_name,
      e.opportunity_id,
      e.purpose,
      e.billing_mode,
      Math.round(e.input_tokens),
      Math.round(e.output_tokens),
      Math.round(e.cache_read_tokens),
      Math.round(e.cache_write_tokens),
      e.requests,
      e.tool_calls,
      e.provider_units,
      e.monetary_cost_usd,
      e.equivalent_cost_usd,
      e.quota_period,
      e.quota_remaining,
      e.duration_ms,
      e.success,
    );
    return mapUsage(this.db.get('SELECT * FROM usage_events WHERE id = ?', r.lastInsertRowid)!);
  }

  totals(filter: { since?: string | null; until?: string | null; provider_id?: string; agent_id?: string; billing_mode?: BillingMode } = {}): UsageTotals {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.since) {
      where.push('ts >= ?');
      params.push(filter.since);
    }
    if (filter.until) {
      where.push('ts < ?');
      params.push(filter.until);
    }
    if (filter.provider_id) {
      where.push('provider_id = ?');
      params.push(filter.provider_id);
    }
    if (filter.agent_id) {
      where.push('agent_id = ?');
      params.push(filter.agent_id);
    }
    if (filter.billing_mode) {
      where.push('billing_mode = ?');
      params.push(filter.billing_mode);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.db.get<UsageTotals>(`SELECT ${SUMS} FROM usage_events ${w}`, ...params)!;
  }

  /** Ältester Eintrag eines Providers seit `since` – für die Reset-Schätzung rollierender Fenster. */
  oldestSince(providerId: string, since: string): string | null {
    return this.db.get<{ ts: string | null }>('SELECT MIN(ts) AS ts FROM usage_events WHERE provider_id = ? AND ts >= ?', providerId, since)?.ts ?? null;
  }

  grouped(group: LedgerGroup, filter: { since?: string | null; until?: string | null } = {}): (UsageTotals & { key: string | null; events: number })[] {
    const keyExpr = group === 'day' ? 'substr(ts, 1, 10)' : group === 'month' ? 'substr(ts, 1, 7)' : group;
    const where: string[] = [];
    const params: string[] = [];
    if (filter.since) {
      where.push('ts >= ?');
      params.push(filter.since);
    }
    if (filter.until) {
      where.push('ts < ?');
      params.push(filter.until);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.db.all(
      `SELECT ${keyExpr} AS key, ${SUMS} FROM usage_events ${w} GROUP BY ${keyExpr} ORDER BY ${group === 'day' || group === 'month' ? 'key' : 'equivalent_cost_usd DESC'}`,
      ...params,
    );
  }

  list(filter: { job_id?: number; provider_id?: string; agent_id?: string; opportunity_id?: string; limit?: number; offset?: number } = {}): {
    items: UsageEvent[];
    total: number;
  } {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.job_id !== undefined) {
      where.push('job_id = ?');
      params.push(filter.job_id);
    }
    if (filter.provider_id) {
      where.push('provider_id = ?');
      params.push(filter.provider_id);
    }
    if (filter.agent_id) {
      where.push('agent_id = ?');
      params.push(filter.agent_id);
    }
    if (filter.opportunity_id) {
      where.push('opportunity_id = ?');
      params.push(filter.opportunity_id);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM usage_events ${w}`, ...params)!.n;
    const items = this.db
      .all(`SELECT * FROM usage_events ${w} ORDER BY id DESC LIMIT ? OFFSET ?`, ...params, filter.limit ?? 100, filter.offset ?? 0)
      .map(mapUsage);
    return { items, total };
  }
}

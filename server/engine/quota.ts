import type { Model, Provider, QuotaStatus, Settings } from '../../shared/domain.ts';
import type { Store } from '../repo/store.ts';
import type { CallUsage } from '../providers/types.ts';

/** Zeitfenster der aktuellen Kontingent-Periode eines Providers (lokale Zeit). */
export function periodWindow(p: Provider, now: Date): { start: Date | null; next: Date | null; key: string } {
  const hour = clampInt(p.quota_reset_hour, 0, 23);
  switch (p.quota_period) {
    case 'monthly': {
      const day = clampInt(p.quota_reset_day, 1, 28);
      let start = new Date(now.getFullYear(), now.getMonth(), day, hour);
      if (start > now) start = new Date(now.getFullYear(), now.getMonth() - 1, day, hour);
      const next = new Date(start.getFullYear(), start.getMonth() + 1, day, hour);
      return { start, next, key: `${start.getFullYear()}-${pad(start.getMonth() + 1)}` };
    }
    case 'weekly': {
      const target = clampInt(p.quota_reset_day, 1, 7); // 1 = Montag … 7 = Sonntag
      const iso = now.getDay() || 7;
      let start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((iso - target + 7) % 7), hour);
      if (start > now) start = new Date(start.getFullYear(), start.getMonth(), start.getDate() - 7, hour);
      const next = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7, hour);
      return { start, next, key: `KW-${localDate(start)}` };
    }
    case 'daily': {
      let start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour);
      if (start > now) start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, hour);
      const next = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1, hour);
      return { start, next, key: localDate(start) };
    }
    case 'rolling': {
      const hours = Math.max(1, p.quota_period_hours || 5);
      return { start: new Date(now.getTime() - hours * 3600_000), next: null, key: `${hours}h-Fenster` };
    }
    default:
      return { start: null, next: null, key: 'gesamt' };
  }
}

export function monthStart(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

export function computeQuota(store: Store, p: Provider, now: Date, runningJobs = 0): QuotaStatus {
  const win = periodWindow(p, now);
  let since = win.start?.toISOString() ?? null;
  if (p.quota_counter_reset_at && (!since || p.quota_counter_reset_at > since)) since = p.quota_counter_reset_at;
  const totals = store.ledger.totals({ since, provider_id: p.id });
  const used =
    p.quota_unit === 'tokens'
      ? totals.input_tokens + totals.output_tokens
      : p.quota_unit === 'requests'
        ? totals.requests
        : p.quota_unit === 'cost_usd'
          ? totals.equivalent_cost_usd
          : 0;
  const limit = p.quota_unit === 'none' ? null : p.quota_limit;
  const remaining = limit == null ? null : Math.max(0, limit - used);
  const counterExhausted = limit != null && used >= limit;

  let nextReset = win.next?.toISOString() ?? null;
  if (p.quota_period === 'rolling' && since) {
    const oldest = store.ledger.oldestSince(p.id, since);
    nextReset = oldest ? new Date(new Date(oldest).getTime() + Math.max(1, p.quota_period_hours) * 3600_000).toISOString() : null;
  }

  const nowIso = now.toISOString();
  const signalled = !!p.exhausted_until && p.exhausted_until > nowIso;
  const exhausted = counterExhausted || signalled;
  let exhaustedUntil: string | null = null;
  let reason: string | null = null;
  if (signalled) {
    exhaustedUntil = p.exhausted_until;
    reason = p.exhausted_reason ?? 'Provider meldet erschöpftes Kontingent';
  }
  if (counterExhausted) {
    const counterUntil = nextReset;
    if (!exhaustedUntil || (counterUntil && counterUntil > exhaustedUntil)) exhaustedUntil = counterUntil;
    reason = `Kontingent ausgeschöpft (${formatAmount(used, p.quota_unit)} von ${formatAmount(limit!, p.quota_unit)})`;
  }

  const month = store.ledger.totals({ since: monthStart(now).toISOString(), provider_id: p.id });
  const costLimitReached = p.monthly_cost_limit_usd != null && month.monetary_cost_usd >= p.monthly_cost_limit_usd;

  return {
    unit: p.quota_unit,
    period: p.quota_period,
    period_key: win.key,
    period_start: since,
    next_reset: nextReset,
    used,
    limit,
    remaining,
    exhausted,
    exhausted_until: exhaustedUntil,
    reason,
    month_cost_usd: month.monetary_cost_usd,
    month_equivalent_usd: month.equivalent_cost_usd,
    cost_limit_reached: costLimitReached,
    running_jobs: runningJobs,
  };
}

/** Gegenwert eines Aufrufs zum Listenpreis (USD). */
export function priceOf(model: Pick<Model, 'input_price_per_mtok' | 'output_price_per_mtok'> | undefined, u: CallUsage): number {
  if (u.reportedCostUsd != null) return u.reportedCostUsd;
  if (!model) return 0;
  const inP = model.input_price_per_mtok;
  const outP = model.output_price_per_mtok;
  const tokens = u.inputTokens * inP + u.cacheReadTokens * inP * 0.1 + u.cacheWriteTokens * inP * 1.25 + u.outputTokens * outP;
  return tokens / 1e6 + u.webSearches * 0.01; // Websuche: ca. 10 USD pro 1000 Suchen
}

/** Budget-Status des Gesamtsystems (nur echte Geldausgaben, Konzept §1 "Budget-first"). */
export function systemBudget(store: Store, settings: Settings, now: Date): {
  spent: number;
  limit: number | null;
  pct: number | null;
  warning: boolean;
  exceeded: boolean;
} {
  const spent = store.ledger.totals({ since: monthStart(now).toISOString() }).monetary_cost_usd;
  const limit = settings.system_monthly_budget_usd;
  if (limit == null || limit <= 0) return { spent, limit: null, pct: null, warning: false, exceeded: false };
  const pct = (spent / limit) * 100;
  return { spent, limit, pct, warning: pct >= settings.budget_warning_pct, exceeded: spent >= limit };
}

export function agentMonthSpend(store: Store, agentId: string, now: Date): number {
  return store.ledger.totals({ since: monthStart(now).toISOString(), agent_id: agentId }).monetary_cost_usd;
}

function clampInt(v: number, min: number, max: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

const pad = (n: number) => String(n).padStart(2, '0');
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function formatAmount(v: number, unit: string): string {
  if (unit === 'cost_usd') return `$${v.toFixed(2)}`;
  return `${Math.round(v).toLocaleString('de-DE')} ${unit === 'tokens' ? 'Tokens' : 'Requests'}`;
}

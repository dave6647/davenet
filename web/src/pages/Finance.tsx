import { useState } from 'react';
import type { ProviderView, UsageEvent } from '../../../shared/domain.ts';
import { qs } from '../api.ts';
import { Bar, Card, ErrorBox, Loading, PageHead, Tabs } from '../components/ui.tsx';
import { fmtDate, fmtDateTime, fmtNum, fmtTokens, fmtUsd } from '../format.ts';
import { useApi } from '../live.ts';
import { useJobTypeLabel } from '../meta.tsx';
import { ProviderStatusBadge, PlanWindows } from './Providers.tsx';

interface Row {
  key: string | null;
  events: number;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  tool_calls: number;
  monetary_cost_usd: number;
  equivalent_cost_usd: number;
}
interface Summary {
  since: string;
  totals: Row;
  groups: Record<string, Row[]>;
  budget: { spent: number; limit: number | null; pct: number | null; warning: boolean; exceeded: boolean };
}

type Range = 'month' | 'last_month' | '7d' | '30d' | 'all';
const RANGES: { key: Range; label: string }[] = [
  { key: 'month', label: 'Dieser Monat' },
  { key: 'last_month', label: 'Letzter Monat' },
  { key: '7d', label: '7 Tage' },
  { key: '30d', label: '30 Tage' },
  { key: 'all', label: 'Gesamt' },
];

function rangeParams(r: Range): { from?: string; to?: string } {
  const now = new Date();
  switch (r) {
    case 'month':
      return { from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString() };
    case 'last_month':
      return { from: new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString(), to: new Date(now.getFullYear(), now.getMonth(), 1).toISOString() };
    case '7d':
      return { from: new Date(Date.now() - 7 * 86400_000).toISOString() };
    case '30d':
      return { from: new Date(Date.now() - 30 * 86400_000).toISOString() };
    default:
      return { from: '1970-01-01T00:00:00.000Z' };
  }
}

const GROUPS: { key: string; label: string }[] = [
  { key: 'agent_id', label: 'Nach Agent' },
  { key: 'provider_id', label: 'Nach Provider' },
  { key: 'model_name', label: 'Nach Modell' },
  { key: 'job_type', label: 'Nach Job-Typ' },
  { key: 'opportunity_id', label: 'Nach Opportunity / Projekt' },
  { key: 'day', label: 'Nach Tag' },
];

export function Finance() {
  const [range, setRange] = useState<Range>('month');
  const [group, setGroup] = useState('agent_id');
  const params = rangeParams(range);
  const summary = useApi<Summary>(`/api/ledger/summary${qs(params)}`, ['ledger']);
  const providers = useApi<ProviderView[]>('/api/providers', ['provider', 'ledger']);
  const events = useApi<{ items: UsageEvent[]; total: number }>('/api/ledger/events?limit=50', ['ledger']);
  const jobLabel = useJobTypeLabel();
  if (summary.error) return <ErrorBox error={summary.error} />;
  if (!summary.data) return <Loading />;
  const t = summary.data.totals;
  const b = summary.data.budget;
  const rows = summary.data.groups[group] ?? [];
  const keyLabel = (k: string | null) => (k == null ? '–' : group === 'job_type' ? jobLabel(k) : group === 'day' ? fmtDate(k) : k);

  return (
    <>
      <PageHead title="Kosten & Kontingente" subtitle="Usage- und Kosten-Ledger (Konzept §12): jeder Modellaufruf wird protokolliert." />
      <div className="row">
        {RANGES.map((r) => (
          <button key={r.key} className={`small ${range === r.key ? 'primary' : ''}`} onClick={() => setRange(r.key)}>
            {r.label}
          </button>
        ))}
      </div>

      <div className="grid grid-4">
        <div className="card stat">
          <span className="label">Echte Kosten</span>
          <span className="value">{fmtUsd(t.monetary_cost_usd)}</span>
          <span className="hint">Pay-as-you-go-Abrechnung</span>
        </div>
        <div className="card stat">
          <span className="label">Gegenwert (Listenpreis)</span>
          <span className="value">{fmtUsd(t.equivalent_cost_usd)}</span>
          <span className="hint">inkl. über Abos abgedeckter Nutzung</span>
        </div>
        <div className="card stat">
          <span className="label">Modellaufrufe</span>
          <span className="value">{fmtNum(t.requests)}</span>
          <span className="hint">{fmtNum(t.tool_calls)} Werkzeugaufrufe</span>
        </div>
        <div className="card stat">
          <span className="label">Tokens</span>
          <span className="value">{fmtTokens(t.input_tokens + t.output_tokens)}</span>
          <span className="hint">
            {fmtTokens(t.input_tokens)} In · {fmtTokens(t.output_tokens)} Out · {fmtTokens(t.cache_read_tokens)} aus Cache
          </span>
        </div>
      </div>

      <Card title="Systembudget (aktueller Monat)" actions={<a href="#/settings">Budget einstellen →</a>}>
        {b.limit == null ? (
          <span className="muted">Kein Systembudget gesetzt.</span>
        ) : (
          <>
            <Bar value={b.spent} max={b.limit} />
            <div className="small muted" style={{ marginTop: 4 }}>
              {fmtUsd(b.spent)} von {fmtUsd(b.limit)} ausgegeben.{' '}
              {b.exceeded
                ? 'Budget ausgeschöpft – kostenpflichtige Provider sind gesperrt.'
                : b.warning
                  ? 'Warnschwelle erreicht – nur noch Jobs mit hoher Priorität auf kostenpflichtigen Providern.'
                  : 'Im Rahmen.'}
            </div>
          </>
        )}
      </Card>

      <Card title="Provider-Kontingente">
        {!providers.data ? (
          <Loading />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Status</th>
                  <th>Kontingent</th>
                  <th className="num">Kosten Monat</th>
                  <th className="num">Gegenwert Monat</th>
                </tr>
              </thead>
              <tbody>
                {providers.data.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <a href={`#/providers/${p.id}`}>{p.name}</a>
                    </td>
                    <td>
                      <ProviderStatusBadge p={p} />
                    </td>
                    <td style={{ minWidth: 220 }}>
                      {p.quota.limit != null ? (
                        <>
                          <Bar value={p.quota.used} max={p.quota.limit} />
                          <span className="small muted">
                            {fmtTokens(p.quota.used)} / {fmtTokens(p.quota.limit)} {p.quota.unit} · {p.quota.period_key} · Reset {fmtDateTime(p.quota.next_reset)}
                          </span>
                        </>
                      ) : p.plan_info ? (
                        <PlanWindows info={p.plan_info} compact />
                      ) : (
                        <span className="small muted">kein festes Kontingent</span>
                      )}
                    </td>
                    <td className="num">
                      {fmtUsd(p.quota.month_cost_usd)}
                      {p.monthly_cost_limit_usd != null && <div className="small muted">Limit {fmtUsd(p.monthly_cost_limit_usd)}</div>}
                    </td>
                    <td className="num">{fmtUsd(p.quota.month_equivalent_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Auswertung">
        <Tabs value={group} onChange={setGroup} tabs={GROUPS.map((g) => ({ key: g.key, label: g.label }))} />
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{GROUPS.find((g) => g.key === group)?.label.replace('Nach ', '')}</th>
                <th className="num">Aufrufe</th>
                <th className="num">Input</th>
                <th className="num">Output</th>
                <th className="num">Cache</th>
                <th className="num">Kosten</th>
                <th className="num">Gegenwert</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key ?? '_'}>
                  <td>
                    {group === 'opportunity_id' && r.key ? <a href={`#/opportunities/${r.key}`}>{r.key}</a> : group === 'agent_id' && r.key ? <a href={`#/agents/${r.key}`}>{r.key}</a> : keyLabel(r.key)}
                  </td>
                  <td className="num">{fmtNum(r.requests)}</td>
                  <td className="num">{fmtTokens(r.input_tokens)}</td>
                  <td className="num">{fmtTokens(r.output_tokens)}</td>
                  <td className="num">{fmtTokens(r.cache_read_tokens + r.cache_write_tokens)}</td>
                  <td className="num">{fmtUsd(r.monetary_cost_usd, 4)}</td>
                  <td className="num">{fmtUsd(r.equivalent_cost_usd, 4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <div className="empty">Keine Daten im gewählten Zeitraum.</div>}
        </div>
      </Card>

      <Card title="Letzte Modellaufrufe">
        {!events.data ? (
          <Loading />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Zeit</th>
                  <th>Job</th>
                  <th>Agent</th>
                  <th>Provider / Modell</th>
                  <th className="num">Tokens</th>
                  <th>Periode</th>
                  <th className="num">Kosten</th>
                  <th className="num">Gegenwert</th>
                </tr>
              </thead>
              <tbody>
                {events.data.items.map((e) => (
                  <tr key={e.id}>
                    <td className="small nowrap">{fmtDateTime(e.ts)}</td>
                    <td className="small">
                      {e.job_id ? <a href={`#/jobs/${e.job_id}`}>#{e.job_id}</a> : '–'} {e.job_type ? jobLabel(e.job_type) : e.purpose}
                    </td>
                    <td className="small">{e.agent_id ?? '–'}</td>
                    <td className="small">
                      {e.provider_id}
                      <div className="mono muted">{e.model_name}</div>
                    </td>
                    <td className="num">{fmtTokens(e.input_tokens + e.output_tokens)}</td>
                    <td className="small muted">{e.quota_period}</td>
                    <td className="num">{fmtUsd(e.monetary_cost_usd, 4)}</td>
                    <td className="num">{fmtUsd(e.equivalent_cost_usd, 4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!events.data.items.length && <div className="empty">Noch keine Modellaufrufe.</div>}
          </div>
        )}
      </Card>
    </>
  );
}

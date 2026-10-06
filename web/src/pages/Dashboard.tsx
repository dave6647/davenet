import { useState } from 'react';
import { OPPORTUNITY_STATUSES, OPPORTUNITY_STATUS_LABELS, type AuditEntry, type Job, type ProviderView } from '../../../shared/domain.ts';
import { Badge, Bar, Card, ErrorBox, JobStatusBadge, Loading, PageHead } from '../components/ui.tsx';
import { fmtDateTime, fmtRelative, fmtTokens, fmtUsd } from '../format.ts';
import { useApi } from '../live.ts';
import { useJobTypeLabel } from '../meta.tsx';
import { navigate } from '../router.ts';
import { NewJobDialog } from './Jobs.tsx';
import { PlanWindows } from './Providers.tsx';

interface Overview {
  company_name: string;
  engine: { paused: boolean; running: number; max_concurrent: number };
  jobs: Record<string, number>;
  opportunities: Record<string, number>;
  approvals_pending: number;
  budget: { spent: number; limit: number | null; pct: number | null; warning: boolean; exceeded: boolean };
  month: { requests: number; input_tokens: number; output_tokens: number; monetary_cost_usd: number; equivalent_cost_usd: number };
  providers: ProviderView[];
  recent_jobs: Job[];
  recent_audit: AuditEntry[];
  alerts: { level: 'info' | 'warn' | 'error'; text: string; link?: string }[];
}

export function Dashboard() {
  const { data, error } = useApi<Overview>('/api/overview', ['job', 'opportunity', 'approval', 'provider', 'ledger', 'audit', 'settings']);
  const label = useJobTypeLabel();
  const [newJob, setNewJob] = useState<string | null>(null);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const j = data.jobs;
  const inPipeline = ['DISCOVERED', 'SCREENING', 'RESEARCH', 'EVALUATION', 'PROPOSED'].reduce((s, k) => s + (data.opportunities[k] ?? 0), 0);
  const inDev = ['APPROVED', 'DEVELOPMENT', 'REVIEW', 'READY'].reduce((s, k) => s + (data.opportunities[k] ?? 0), 0);

  return (
    <>
      <PageHead
        title={`Übersicht – ${data.company_name}`}
        subtitle="Was läuft, was wartet, was kostet es?"
        actions={
          <>
            <button onClick={() => setNewJob('opportunity_scan')}>Research-Zyklus starten</button>
            <button onClick={() => navigate('/opportunities?new=1')}>Idee erfassen</button>
            <button onClick={() => setNewJob('executive_briefing')}>Executive Briefing</button>
          </>
        }
      />
      {data.alerts.map((a, i) => (
        <div key={i} className={`alert ${a.level}`}>
          {a.link ? <a href={a.link}>{a.text}</a> : a.text}
        </div>
      ))}

      <div className="grid grid-4">
        <div className="card stat" onClick={() => navigate('/approvals')} style={{ cursor: 'pointer' }}>
          <span className="label">Offene Freigaben</span>
          <span className="value">{data.approvals_pending}</span>
          <span className="hint">Projektstart, Release, Provider-Wechsel</span>
        </div>
        <div className="card stat" onClick={() => navigate('/jobs')} style={{ cursor: 'pointer' }}>
          <span className="label">Jobs aktiv</span>
          <span className="value">{j.RUNNING ?? 0} laufen</span>
          <span className="hint">
            {j.QUEUED ?? 0} in Warteschlange · {j.WAITING_FOR_PROVIDER_QUOTA ?? 0} warten auf Kontingent · {j.WAITING_FOR_APPROVAL ?? 0} auf Freigabe
          </span>
          {j.BLOCKED ? (
            <span className="hint" style={{ color: 'var(--err)' }}>
              ⚠ {j.BLOCKED} blockiert – Eingreifen nötig
            </span>
          ) : null}
        </div>
        <div className="card stat" onClick={() => navigate('/opportunities')} style={{ cursor: 'pointer' }}>
          <span className="label">Opportunities in Prüfung</span>
          <span className="value">{inPipeline}</span>
          <span className="hint">
            {inDev} in Umsetzung · {data.opportunities.DEPLOYED ?? 0} veröffentlicht · {data.opportunities.REJECTED ?? 0} verworfen
          </span>
        </div>
        <div className="card stat" onClick={() => navigate('/finance')} style={{ cursor: 'pointer' }}>
          <span className="label">Kosten diesen Monat</span>
          <span className="value">{fmtUsd(data.month.monetary_cost_usd)}</span>
          <span className="hint">
            Gegenwert zum Listenpreis {fmtUsd(data.month.equivalent_cost_usd)} · {fmtTokens(data.month.input_tokens + data.month.output_tokens)} Tokens
          </span>
          {data.budget.limit != null && (
            <div style={{ marginTop: 6 }}>
              <Bar value={data.budget.spent} max={data.budget.limit} />
              <span className="hint">
                Budget {fmtUsd(data.budget.spent)} von {fmtUsd(data.budget.limit)}
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-2">
        <Card title="Provider & Kontingente" actions={<a href="#/providers">verwalten →</a>}>
          <ul className="list-plain">
            {data.providers.map((p) => (
              <li key={p.id} style={{ opacity: p.enabled ? 1 : 0.55 }}>
                <div className="row">
                  <span className={`dot ${!p.enabled ? '' : p.quota.exhausted || p.quota.cost_limit_reached || p.health_status === 'error' ? 'err' : 'ok'}`} />
                  <a href={`#/providers/${p.id}`}>
                    <strong>{p.name}</strong>
                  </a>
                  <span className="spacer" />
                  {!p.enabled ? (
                    <Badge>inaktiv</Badge>
                  ) : p.quota.exhausted ? (
                    <Badge kind="warn" title={p.quota.reason ?? ''}>
                      erschöpft · Reset {fmtRelative(p.quota.exhausted_until)}
                    </Badge>
                  ) : p.quota.cost_limit_reached ? (
                    <Badge kind="err">Kostenlimit erreicht</Badge>
                  ) : (
                    <Badge kind="ok">verfügbar</Badge>
                  )}
                </div>
                {p.enabled && p.quota.limit != null && (
                  <div style={{ marginTop: 4 }}>
                    <Bar value={p.quota.used} max={p.quota.limit} />
                    <span className="small muted">
                      {fmtTokens(p.quota.used)} / {fmtTokens(p.quota.limit)} {p.quota.unit} · Periode {p.quota.period_key}
                    </span>
                  </div>
                )}
                {p.enabled && p.plan_info && <PlanWindows info={p.plan_info} compact />}
                {p.enabled && p.billing_mode === 'pay_as_you_go' && (
                  <div className="small muted">
                    Kosten Monat {fmtUsd(p.quota.month_cost_usd)}
                    {p.monthly_cost_limit_usd != null ? ` von ${fmtUsd(p.monthly_cost_limit_usd)}` : ''}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Opportunity-Pipeline" actions={<a href="#/opportunities">Board →</a>}>
          <div className="table-wrap">
            <table>
              <tbody>
                {OPPORTUNITY_STATUSES.filter((s) => data.opportunities[s]).map((s) => (
                  <tr key={s} className="clickable" onClick={() => navigate(`/opportunities?status=${s}`)}>
                    <td>{OPPORTUNITY_STATUS_LABELS[s]}</td>
                    <td className="num">{data.opportunities[s]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!Object.keys(data.opportunities).length && <div className="empty">Noch keine Opportunities – starte einen Research-Zyklus oder erfasse eine Idee.</div>}
          </div>
        </Card>
      </div>

      <div className="grid grid-2">
        <Card title="Letzte Jobs" actions={<a href="#/jobs">alle →</a>}>
          <div className="table-wrap">
            <table>
              <tbody>
                {data.recent_jobs.map((job) => (
                  <tr key={job.id} className="clickable" onClick={() => navigate(`/jobs/${job.id}`)}>
                    <td className="nowrap muted">#{job.id}</td>
                    <td>
                      <div>{job.title}</div>
                      <div className="small muted">
                        {label(job.type)} · {job.agent_id}
                      </div>
                    </td>
                    <td>
                      <JobStatusBadge status={job.status} />
                    </td>
                    <td className="nowrap small muted">{fmtRelative(job.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!data.recent_jobs.length && <div className="empty">Noch keine Jobs.</div>}
          </div>
        </Card>
        <Card title="Aktivität" actions={<a href="#/audit">Audit-Log →</a>}>
          <ul className="list-plain small scroll-y">
            {data.recent_audit.map((e) => (
              <li key={e.id}>
                <span className="muted">{fmtDateTime(e.ts)}</span> · <strong>{e.actor}</strong> {e.action}
                {e.entity_id ? (
                  <span className="muted">
                    {' '}
                    ({e.entity_type} {e.entity_id})
                  </span>
                ) : null}
                {e.level >= 2 && (
                  <>
                    {' '}
                    <Badge kind="warn">Level {e.level}</Badge>
                  </>
                )}
              </li>
            ))}
          </ul>
        </Card>
      </div>
      {newJob && <NewJobDialog initialType={newJob} onClose={() => setNewJob(null)} />}
    </>
  );
}

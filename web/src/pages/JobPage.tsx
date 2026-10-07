import { useState } from 'react';
import { PRIORITIES, PROVIDER_POLICIES, PROVIDER_POLICY_LABELS, type Agent, type Approval, type Artifact, type Job, type UsageEvent } from '../../../shared/domain.ts';
import { api } from '../api.ts';
import { ArtifactList } from '../components/artifacts.tsx';
import { Card, ErrorBox, Field, JobStatusBadge, Loading, PageHead, PriorityBadge, Select, useAction, ApprovalStatusBadge } from '../components/ui.tsx';
import { fmtDateTime, fmtDuration, fmtTokens, fmtUsd } from '../format.ts';
import { useApi } from '../live.ts';
import { useJobTypeLabel } from '../meta.tsx';
import { navigate } from '../router.ts';

interface JobDetail {
  job: Job;
  usage: UsageEvent[];
  artifacts: Artifact[];
  children: Job[];
  approvals: Approval[];
}

const OPEN = ['QUEUED', 'RUNNING', 'WAITING_FOR_PROVIDER_QUOTA', 'WAITING_FOR_APPROVAL', 'BLOCKED'];

export function JobPage({ id }: { id: number }) {
  const { data, error } = useApi<JobDetail>(`/api/jobs/${id}`, ['job', 'ledger', 'approval']);
  const agents = useApi<Agent[]>('/api/agents', ['agent']);
  const label = useJobTypeLabel();
  const { run, busy } = useAction();
  const [showOutput, setShowOutput] = useState(false);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const j = data.job;
  const editable = j.status !== 'RUNNING' && OPEN.includes(j.status);

  const cancel = () => run(() => api.post(`/api/jobs/${id}/cancel`), 'Job abgebrochen');
  const retry = () => run(() => api.post(`/api/jobs/${id}/retry`), 'Job neu eingereiht');
  const update = (patch: Record<string, unknown>) => run(() => api.put(`/api/jobs/${id}`, patch), 'Job geändert');

  return (
    <>
      <PageHead
        title={
          <>
            #{j.id} {j.title}
          </>
        }
        subtitle={
          <>
            {label(j.type)} · <JobStatusBadge status={j.status} />
          </>
        }
        actions={
          <>
            <button onClick={() => navigate('/jobs')}>← Jobs</button>
            {OPEN.includes(j.status) && (
              <button className="danger" disabled={busy} onClick={cancel}>
                Abbrechen
              </button>
            )}
            {['FAILED', 'CANCELLED', 'BLOCKED', 'WAITING_FOR_PROVIDER_QUOTA'].includes(j.status) && (
              <button className="primary" disabled={busy} onClick={retry}>
                {j.status === 'FAILED' || j.status === 'CANCELLED' ? 'Wiederholen' : 'Jetzt erneut prüfen'}
              </button>
            )}
          </>
        }
      />
      {j.error && <div className="alert error">{j.error}</div>}
      {!j.error && j.wait_reason && <div className={`alert ${j.status === 'BLOCKED' ? 'error' : 'warn'}`}>{j.wait_reason}</div>}

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(280px, 1fr)' }}>
        <div className="grid" style={{ alignContent: 'start' }}>
          <Card title="Details">
            <dl className="kv">
              <dt>Agent</dt>
              <dd>{j.agent_id ? <a href={`#/agents/${j.agent_id}`}>{j.agent_id}</a> : '–'}</dd>
              {j.opportunity_id && (
                <>
                  <dt>Opportunity</dt>
                  <dd>
                    <a href={`#/opportunities/${j.opportunity_id}`}>{j.opportunity_id}</a>
                    {j.task_id ? ` · Task ${j.task_id}` : ''}
                  </dd>
                </>
              )}
              <dt>Provider / Modell</dt>
              <dd>{j.model_id ?? 'noch nicht zugewiesen'}</dd>
              {j.forced_provider_id && (
                <>
                  <dt>Festgelegt</dt>
                  <dd>
                    {j.forced_provider_id} (per Freigabe) {j.forced_model_id}
                  </dd>
                </>
              )}
              <dt>Priorität</dt>
              <dd>
                <PriorityBadge p={j.priority} />
              </dd>
              <dt>Versuche</dt>
              <dd>
                {j.attempts} von {j.max_attempts}
              </dd>
              <dt>Erstellt</dt>
              <dd>
                {fmtDateTime(j.created_at)} von {j.created_by}
                {j.parent_job_id && (
                  <>
                    {' '}
                    (Folgejob von <a href={`#/jobs/${j.parent_job_id}`}>#{j.parent_job_id}</a>)
                  </>
                )}
              </dd>
              <dt>Laufzeit</dt>
              <dd>{j.started_at ? fmtDuration(j.started_at, j.finished_at) : '–'}</dd>
              {j.not_before && (
                <>
                  <dt>Frühester Start</dt>
                  <dd>{fmtDateTime(j.not_before)}</dd>
                </>
              )}
              <dt>Verbrauch</dt>
              <dd>
                {fmtTokens(j.input_tokens)} In / {fmtTokens(j.output_tokens)} Out · Kosten {fmtUsd(j.cost_usd)} · Gegenwert {fmtUsd(j.equivalent_cost_usd)}
              </dd>
            </dl>
          </Card>

          {j.type === 'image_generation' && j.status === 'COMPLETED' && typeof (j.output as { file?: unknown })?.file === 'string' && (
            <Card title="Bild">
              <img
                src={`/api/memory/raw?path=${encodeURIComponent((j.output as { file: string }).file)}`}
                alt={j.title}
                style={{ maxWidth: '100%', maxHeight: 520, borderRadius: 6 }}
              />
              <div className="small muted mono">company/{(j.output as { file: string }).file}</div>
              {(j.output as { workspace_file?: string | null }).workspace_file && (
                <div className="small muted">Im Projekt-Workspace: {(j.output as { workspace_file: string }).workspace_file}</div>
              )}
            </Card>
          )}
          {j.output != null && (
            <Card title="Ergebnis (strukturiert)" actions={<button className="small" onClick={() => setShowOutput(!showOutput)}>{showOutput ? 'einklappen' : 'anzeigen'}</button>}>
              {showOutput ? <pre>{JSON.stringify(j.output, null, 2)}</pre> : <span className="muted small">Die verdichteten Ergebnisse liegen als Artefakte im Unternehmensgedächtnis (rechts).</span>}
            </Card>
          )}

          <Card title="Protokoll">
            <ul className="list-plain small scroll-y">
              {[...j.log].reverse().map((l, i) => (
                <li key={i} style={{ color: l.level === 'error' ? 'var(--err)' : l.level === 'warn' ? 'var(--warn)' : undefined }}>
                  <span className="muted">{fmtDateTime(l.ts)}</span> {l.msg}
                </li>
              ))}
              {!j.log.length && <li className="muted">noch keine Einträge</li>}
            </ul>
          </Card>

          <Card title="Modellaufrufe (Usage-Ledger)">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Zeit</th>
                    <th>Zweck</th>
                    <th>Provider / Modell</th>
                    <th className="num">Input</th>
                    <th className="num">Output</th>
                    <th className="num">Cache</th>
                    <th className="num">Tools</th>
                    <th className="num">Kosten</th>
                    <th className="num">Gegenwert</th>
                  </tr>
                </thead>
                <tbody>
                  {data.usage.map((u) => (
                    <tr key={u.id}>
                      <td className="nowrap small">{fmtDateTime(u.ts)}</td>
                      <td className="small">{u.purpose}</td>
                      <td className="small">
                        {u.provider_id}
                        <div className="mono muted">{u.model_name}</div>
                      </td>
                      <td className="num">{fmtTokens(u.input_tokens)}</td>
                      <td className="num">{fmtTokens(u.output_tokens)}</td>
                      <td className="num">{fmtTokens(u.cache_read_tokens + u.cache_write_tokens)}</td>
                      <td className="num">{u.tool_calls}</td>
                      <td className="num">{fmtUsd(u.monetary_cost_usd, 4)}</td>
                      <td className="num">{fmtUsd(u.equivalent_cost_usd, 4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!data.usage.length && <div className="empty">Noch keine Modellaufrufe.</div>}
            </div>
          </Card>
        </div>

        <div className="grid" style={{ alignContent: 'start' }}>
          {editable && (
            <Card title="Anpassen">
              <div className="grid">
                <Field label="Priorität">
                  <Select value={j.priority} options={PRIORITIES.map((p) => ({ value: p.value, label: p.label }))} onChange={(v) => v != null && update({ priority: v })} />
                </Field>
                <Field label="Agent">
                  <Select value={j.agent_id} options={(agents.data ?? []).map((a) => ({ value: a.id, label: a.name }))} onChange={(v) => v && update({ agent_id: v })} />
                </Field>
                <Field label="Provider-Policy">
                  <Select value={j.policy_override} allowEmpty="wie Agent" options={PROVIDER_POLICIES.map((p) => ({ value: p, label: PROVIDER_POLICY_LABELS[p] }))} onChange={(v) => update({ policy_override: v })} />
                </Field>
              </div>
            </Card>
          )}
          <Card title="Artefakte">
            <ArtifactList artifacts={data.artifacts} />
          </Card>
          {data.approvals.length > 0 && (
            <Card title="Freigaben">
              <ul className="list-plain small">
                {data.approvals.map((a) => (
                  <li key={a.id}>
                    <a href="#/approvals">#{a.id}</a> {a.title} <ApprovalStatusBadge status={a.status} />
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {data.children.length > 0 && (
            <Card title="Folgejobs">
              <ul className="list-plain small">
                {data.children.map((c) => (
                  <li key={c.id}>
                    <a href={`#/jobs/${c.id}`}>#{c.id}</a> {c.title} <JobStatusBadge status={c.status} />
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Card title="Eingabe">
            <pre>{JSON.stringify(j.input, null, 2)}</pre>
          </Card>
        </div>
      </div>
    </>
  );
}

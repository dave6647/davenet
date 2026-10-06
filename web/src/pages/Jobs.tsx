import { useMemo, useState } from 'react';
import { PRIORITIES, PROVIDER_POLICIES, PROVIDER_POLICY_LABELS, type Agent, type Job, type JobRoute, type JobStatus, type Opportunity, type Task } from '../../../shared/domain.ts';
import { api, qs } from '../api.ts';
import { Card, ErrorBox, Field, JobStatusBadge, Loading, Modal, PageHead, PriorityBadge, Select, TextArea, TextInput, NumberInput, useAction } from '../components/ui.tsx';
import { fmtRelative, fmtTokens, fmtUsd } from '../format.ts';
import { useApi } from '../live.ts';
import { useJobTypeLabel, useMeta } from '../meta.tsx';
import { navigate, setQuery, useRoute } from '../router.ts';

const FILTERS: { key: string; label: string; statuses: JobStatus[] | null }[] = [
  { key: 'open', label: 'Offen', statuses: ['QUEUED', 'RUNNING', 'WAITING_FOR_PROVIDER_QUOTA', 'WAITING_FOR_APPROVAL', 'BLOCKED'] },
  { key: 'RUNNING', label: 'Laufend', statuses: ['RUNNING'] },
  { key: 'waiting', label: 'Wartend', statuses: ['QUEUED', 'WAITING_FOR_PROVIDER_QUOTA', 'WAITING_FOR_APPROVAL'] },
  { key: 'BLOCKED', label: 'Blockiert', statuses: ['BLOCKED'] },
  { key: 'COMPLETED', label: 'Abgeschlossen', statuses: ['COMPLETED'] },
  { key: 'FAILED', label: 'Fehlgeschlagen', statuses: ['FAILED', 'CANCELLED'] },
  { key: 'all', label: 'Alle', statuses: null },
];

export function Jobs() {
  const route = useRoute();
  const meta = useMeta();
  const label = useJobTypeLabel();
  const filterKey = route.query.get('status') ?? 'open';
  const filter = FILTERS.find((f) => f.key === filterKey) ?? { key: filterKey, label: filterKey, statuses: [filterKey as JobStatus] };
  const type = route.query.get('type') ?? '';
  const agent = route.query.get('agent') ?? '';
  const page = Number(route.query.get('page') ?? 0);
  const path = `/api/jobs${qs({ status: filter.statuses?.join(','), type, agent_id: agent, limit: 50, offset: page * 50 })}`;
  const jobs = useApi<{ items: Job[]; total: number }>(path, ['job']);
  const agents = useApi<Agent[]>('/api/agents', ['agent']);
  const [create, setCreate] = useState(false);
  const { run } = useAction();

  const cancel = (id: number) => run(() => api.post(`/api/jobs/${id}/cancel`), 'Job abgebrochen');
  const retry = (id: number) => run(() => api.post(`/api/jobs/${id}/retry`), 'Job neu eingereiht');

  return (
    <>
      <PageHead
        title="Jobs"
        subtitle="Agents laufen nur pro Job. Wartende Jobs werden nach Kontingent-Reset automatisch fortgesetzt."
        actions={
          <button className="primary" onClick={() => setCreate(true)}>
            + Neuer Job
          </button>
        }
      />
      <div className="row">
        {FILTERS.map((f) => (
          <button key={f.key} className={`small ${filter.key === f.key ? 'primary' : ''}`} onClick={() => setQuery({ status: f.key, page: null })}>
            {f.label}
          </button>
        ))}
        <span className="spacer" />
        <div style={{ width: 200 }}>
          <Select value={type || null} allowEmpty="alle Job-Typen" options={meta.job_types.map((t) => ({ value: t.key, label: t.label }))} onChange={(v) => setQuery({ type: v, page: null })} />
        </div>
        <div style={{ width: 200 }}>
          <Select value={agent || null} allowEmpty="alle Agents" options={(agents.data ?? []).map((a) => ({ value: a.id, label: a.name }))} onChange={(v) => setQuery({ agent: v, page: null })} />
        </div>
      </div>
      <Card>
        <ErrorBox error={jobs.error} />
        {!jobs.data ? (
          <Loading />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Job</th>
                  <th>Agent</th>
                  <th>Status</th>
                  <th>Provider / Modell</th>
                  <th>Prio</th>
                  <th className="num">Tokens</th>
                  <th className="num">Kosten</th>
                  <th>Aktualisiert</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {jobs.data.items.map((j) => (
                  <tr key={j.id} className="clickable" onClick={() => navigate(`/jobs/${j.id}`)}>
                    <td className="muted">{j.id}</td>
                    <td>
                      {j.title}
                      <div className="small muted">
                        {label(j.type)}
                        {j.opportunity_id ? ` · ${j.opportunity_id}` : ''}
                        {j.attempts > 1 ? ` · Versuch ${j.attempts}` : ''}
                      </div>
                    </td>
                    <td className="small">{j.agent_id}</td>
                    <td style={{ maxWidth: 320 }}>
                      <JobStatusBadge status={j.status} />
                      {(j.wait_reason || j.error) && <div className="small muted wrap-anywhere">{j.error ?? j.wait_reason}</div>}
                    </td>
                    <td className="small">{j.model_id ?? '–'}</td>
                    <td>
                      <PriorityBadge p={j.priority} />
                    </td>
                    <td className="num">{fmtTokens(j.input_tokens + j.output_tokens)}</td>
                    <td className="num">
                      {fmtUsd(j.cost_usd)}
                      {j.equivalent_cost_usd > 0 && <div className="small muted">≙ {fmtUsd(j.equivalent_cost_usd)}</div>}
                    </td>
                    <td className="small muted nowrap">{fmtRelative(j.updated_at)}</td>
                    <td onClick={(e) => e.stopPropagation()} className="nowrap">
                      {['QUEUED', 'RUNNING', 'WAITING_FOR_PROVIDER_QUOTA', 'WAITING_FOR_APPROVAL', 'BLOCKED'].includes(j.status) && (
                        <button className="small danger" onClick={() => cancel(j.id)}>
                          Abbrechen
                        </button>
                      )}
                      {['FAILED', 'CANCELLED', 'BLOCKED', 'WAITING_FOR_PROVIDER_QUOTA'].includes(j.status) && (
                        <button className="small" onClick={() => retry(j.id)}>
                          {j.status === 'WAITING_FOR_PROVIDER_QUOTA' || j.status === 'BLOCKED' ? 'Jetzt prüfen' : 'Wiederholen'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!jobs.data.items.length && <div className="empty">Keine Jobs in dieser Ansicht.</div>}
            {jobs.data.total > 50 && (
              <div className="row" style={{ marginTop: 10 }}>
                <span className="muted small">
                  {page * 50 + 1}–{Math.min(jobs.data.total, (page + 1) * 50)} von {jobs.data.total}
                </span>
                <span className="spacer" />
                <button className="small" disabled={page === 0} onClick={() => setQuery({ page: String(page - 1) })}>
                  ← zurück
                </button>
                <button className="small" disabled={(page + 1) * 50 >= jobs.data.total} onClick={() => setQuery({ page: String(page + 1) })}>
                  weiter →
                </button>
              </div>
            )}
          </div>
        )}
      </Card>
      {create && <NewJobDialog onClose={() => setCreate(false)} />}
    </>
  );
}

type RouteRow = { key: string; route: JobRoute };

/** Dialog für manuelle Jobs / Aufträge des Owners. */
export function NewJobDialog({ onClose, initialType, initialAgent, initialOpportunity }: { onClose: () => void; initialType?: string; initialAgent?: string | null; initialOpportunity?: string }) {
  const meta = useMeta();
  const manualTypes = meta.job_types.filter((t) => t.manual);
  const [type, setType] = useState(initialType ?? manualTypes[0]?.key ?? 'owner_directive');
  const def = meta.job_types.find((t) => t.key === type);
  const agents = useApi<Agent[]>('/api/agents', ['agent']);
  const routes = useApi<RouteRow[]>('/api/routes', ['route']);
  const opps = useApi<Opportunity[]>('/api/opportunities', ['opportunity']);
  const [agentId, setAgentId] = useState<string | null>(initialAgent ?? null);
  const [oppId, setOppId] = useState<string | null>(initialOpportunity ?? null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [input, setInput] = useState<Record<string, unknown>>({});
  const [priority, setPriority] = useState<number | null>(null);
  const [policy, setPolicy] = useState<string | null>(null);
  const oppDetail = useApi<{ tasks: Task[] }>(def?.requires_task && oppId ? `/api/opportunities/${oppId}` : null, ['task']);
  const { run, busy } = useAction();

  const routeAgent = routes.data?.find((r) => r.key === type)?.route.agent_id ?? def?.default_agent;
  const needsAgent = type === 'custom';
  const missing = useMemo(() => {
    if (!def) return 'Job-Typ wählen';
    for (const f of def.input_fields) if (f.required && !String(input[f.key] ?? '').trim()) return `${f.label} fehlt`;
    if (def.requires_opportunity && !oppId) return 'Opportunity wählen';
    if (def.requires_task && !taskId) return 'Task wählen';
    if (needsAgent && !agentId) return 'Agent wählen';
    return null;
  }, [def, input, oppId, taskId, needsAgent, agentId]);

  const submit = () =>
    run(async () => {
      const job = await api.post<Job>('/api/jobs', {
        type,
        agent_id: agentId || null,
        input,
        opportunity_id: oppId,
        task_id: taskId,
        priority: priority ?? undefined,
        policy_override: policy,
      });
      onClose();
      navigate(`/jobs/${job.id}`);
    }, 'Job angelegt');

  return (
    <Modal
      title={type === 'owner_directive' ? 'Auftrag an die Leitung' : 'Neuer Job'}
      onClose={onClose}
      footer={
        <>
          {missing && <span className="small muted">{missing}</span>}
          <button onClick={onClose}>Abbrechen</button>
          <button className="primary" disabled={busy || !!missing} onClick={submit}>
            Anlegen
          </button>
        </>
      }
    >
      <Field label="Job-Typ">
        <Select
          value={type}
          options={manualTypes.map((t) => ({ value: t.key, label: `${t.label} (${t.department_hint})` }))}
          onChange={(v) => {
            if (!v) return;
            setType(v);
            setInput({});
            setTaskId(null);
          }}
        />
      </Field>
      {def && <div className="alert info small">{def.description}</div>}
      {type === 'owner_directive' && (
        <p className="small muted" style={{ margin: 0 }}>
          Beschreibe frei, was du erreichen willst. Der Executive Orchestrator zerlegt den Auftrag in konkrete Jobs (Scans, Recherchen, freie Aufträge an
          Agents). Projektstarts und Veröffentlichungen bleiben deine Entscheidung.
        </p>
      )}
      {def?.input_fields.map((f) => (
        <Field key={f.key} label={`${f.label}${f.required ? ' *' : ''}`}>
          {f.type === 'textarea' ? (
            <TextArea value={String(input[f.key] ?? '')} onChange={(v) => setInput({ ...input, [f.key]: v })} rows={5} />
          ) : f.type === 'number' ? (
            <NumberInput value={input[f.key] == null ? null : Number(input[f.key])} onChange={(v) => setInput({ ...input, [f.key]: v })} />
          ) : (
            <TextInput value={String(input[f.key] ?? '')} onChange={(v) => setInput({ ...input, [f.key]: v })} />
          )}
        </Field>
      ))}
      {(def?.requires_opportunity || type === 'custom') && (
        <Field label={`Opportunity${def?.requires_opportunity ? ' *' : ' (optional)'}`}>
          <Select
            value={oppId}
            allowEmpty="— wählen —"
            options={(opps.data ?? []).map((o) => ({ value: o.id, label: `${o.id} ${o.title} (${o.status})` }))}
            onChange={(v) => {
              setOppId(v);
              setTaskId(null);
            }}
          />
        </Field>
      )}
      {def?.requires_task && oppId && (
        <Field label="Task *">
          <Select value={taskId} allowEmpty="— wählen —" options={(oppDetail.data?.tasks ?? []).map((t) => ({ value: t.id, label: `${t.key} ${t.title} (${t.status})` }))} onChange={setTaskId} />
        </Field>
      )}
      <div className="form-grid">
        <Field label={needsAgent ? 'Agent *' : 'Agent'} help={needsAgent ? undefined : `Standard laut Zuständigkeit: ${routeAgent ?? '–'}`}>
          <Select value={agentId} allowEmpty={needsAgent ? '— wählen —' : 'laut Zuständigkeit'} options={(agents.data ?? []).filter((a) => a.enabled).map((a) => ({ value: a.id, label: a.name }))} onChange={setAgentId} />
        </Field>
        <Field label="Priorität">
          <Select value={priority} allowEmpty="Standard des Agents" options={PRIORITIES.map((p) => ({ value: p.value, label: p.label }))} onChange={setPriority} />
        </Field>
        <Field label="Provider-Policy für diesen Job" full>
          <Select value={policy} allowEmpty="wie Agent" options={PROVIDER_POLICIES.map((p) => ({ value: p, label: PROVIDER_POLICY_LABELS[p] }))} onChange={setPolicy} />
        </Field>
      </div>
    </Modal>
  );
}

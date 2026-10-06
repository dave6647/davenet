import { useEffect, useState } from 'react';
import {
  CAPABILITIES,
  CAPABILITY_LABELS,
  EFFORTS,
  PRIORITIES,
  PROVIDER_POLICIES,
  PROVIDER_POLICY_LABELS,
  TOOLS,
  TOOL_KEYS,
  type Agent,
  type Department,
  type Job,
  type JobRoute,
  type ProviderView,
  type ToolKey,
} from '../../../shared/domain.ts';
import { api } from '../api.ts';
import { Badge, CapBadge, Card, Check, ConfirmButton, ErrorBox, Field, JobStatusBadge, Loading, NumberInput, PageHead, Select, TextArea, TextInput, useAction } from '../components/ui.tsx';
import { fmtRelative, fmtTokens, fmtUsd } from '../format.ts';
import { useApi } from '../live.ts';
import { useJobTypeLabel } from '../meta.tsx';
import { navigate, useRoute } from '../router.ts';
import { NewJobDialog } from './Jobs.tsx';

interface AgentDetail {
  agent: Agent;
  month: { requests: number; input_tokens: number; output_tokens: number; monetary_cost_usd: number; equivalent_cost_usd: number };
  total: { requests: number; monetary_cost_usd: number; equivalent_cost_usd: number };
  jobs: Job[];
  routes: JobRoute[];
  candidates: { provider: { id: string; name: string }; models: { id: string; label: string; tier: string }[] }[];
}

const NEW_AGENT: Partial<Agent> = {
  id: '',
  name: '',
  department_id: null,
  description: '',
  instructions: '',
  capability: 'MEDIUM',
  min_context_tokens: 0,
  tools: [],
  allowed_providers: [],
  provider_policy: 'WAIT',
  priority: 1,
  effort: null,
  max_job_cost_usd: 1,
  max_input_tokens: 40000,
  max_output_tokens: 8000,
  max_tool_calls: 10,
  max_runtime_sec: 900,
  monthly_budget_usd: null,
  enabled: true,
  sort_order: 50,
};

export function AgentPage({ id }: { id?: string }) {
  const isNew = !id || id === 'new';
  const route = useRoute();
  const detail = useApi<AgentDetail>(isNew ? null : `/api/agents/${id}`, ['agent', 'job', 'ledger', 'route', 'provider']);
  const deps = useApi<Department[]>('/api/departments', ['department']);
  const providers = useApi<ProviderView[]>('/api/providers', ['provider']);
  const [form, setForm] = useState<Partial<Agent> | null>(isNew ? { ...NEW_AGENT, department_id: route.query.get('department') } : null);
  const [dirty, setDirty] = useState(false);
  const [customJob, setCustomJob] = useState(false);
  const { run, busy } = useAction();
  const label = useJobTypeLabel();

  useEffect(() => {
    if (!isNew && detail.data && !dirty) setForm(detail.data.agent);
  }, [detail.data, isNew, dirty]);

  if (detail.error) return <ErrorBox error={detail.error} />;
  if (!form || !deps.data || !providers.data) return <Loading />;

  const set = <K extends keyof Agent>(k: K, v: Agent[K]) => {
    setForm({ ...form, [k]: v });
    setDirty(true);
  };

  const save = () =>
    run(async () => {
      const { created_at: _c, updated_at: _u, id: agentId, ...body } = form as Agent;
      if (isNew) {
        const created = await api.post<Agent>('/api/agents', { id: agentId, ...body });
        setDirty(false);
        navigate(`/agents/${created.id}`);
      } else {
        await api.put(`/api/agents/${id}`, body);
        setDirty(false);
        detail.reload();
      }
    }, 'Agent gespeichert');

  const remove = () =>
    run(async () => {
      await api.del(`/api/agents/${id}`);
      navigate('/organisation');
    }, 'Agent gelöscht');

  const toggleTool = (t: ToolKey, on: boolean) => set('tools', on ? [...(form.tools ?? []), t] : (form.tools ?? []).filter((x) => x !== t));
  const allowed = form.allowed_providers ?? [];
  const toggleProvider = (pid: string, on: boolean) => set('allowed_providers', on ? [...allowed, pid] : allowed.filter((x) => x !== pid));
  const moveProvider = (pid: string, dir: -1 | 1) => {
    const i = allowed.indexOf(pid);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= allowed.length) return;
    const next = [...allowed];
    [next[i], next[j]] = [next[j], next[i]];
    set('allowed_providers', next);
  };

  return (
    <>
      <PageHead
        title={isNew ? 'Neuer Agent' : form.name}
        subtitle={isNew ? 'Ein Agent ist eine Rolle mit Verantwortung, Berechtigungen und Limits – kein fest verdrahtetes Modell.' : <span className="mono">{form.id}</span>}
        actions={
          <>
            <button onClick={() => navigate('/organisation')}>← Organisation</button>
            {!isNew && <button onClick={() => setCustomJob(true)}>Auftrag an diesen Agent</button>}
            {!isNew && (
              <ConfirmButton className="danger" confirm={`Agent ${form.name} wirklich löschen?`} onConfirm={remove}>
                Löschen
              </ConfirmButton>
            )}
            <button className="primary" disabled={busy || !form.name || !form.id || (!dirty && !isNew)} onClick={save}>
              Speichern
            </button>
          </>
        }
      />
      {dirty && <div className="alert warn">Ungespeicherte Änderungen</div>}

      <div className="grid" style={{ gridTemplateColumns: isNew ? '1fr' : 'minmax(0, 2fr) minmax(280px, 1fr)' }}>
        <div className="grid">
          <Card title="Rolle">
            <div className="form-grid">
              <Field label="Kennung (agent_id)" help="z. B. RESEARCH_ANALYST – nicht mehr änderbar">
                <TextInput value={form.id} disabled={!isNew} onChange={(v) => set('id', v.toUpperCase().replace(/[^A-Z0-9_-]/g, '_'))} />
              </Field>
              <Field label="Name">
                <TextInput value={form.name} onChange={(v) => set('name', v)} />
              </Field>
              <Field label="Abteilung">
                <Select value={form.department_id ?? null} allowEmpty="— ohne Abteilung —" options={deps.data.map((d) => ({ value: d.id, label: d.name }))} onChange={(v) => set('department_id', v)} />
              </Field>
              <Field label="Status">
                <Check checked={!!form.enabled} onChange={(v) => set('enabled', v)} label="Agent aktiv" />
              </Field>
              <Field label="Verantwortung (kurz)" full>
                <TextInput value={form.description} onChange={(v) => set('description', v)} />
              </Field>
              <Field label="Rollen-Anweisungen" help="Wird jedem Job dieses Agents als Rollenbeschreibung mitgegeben." full>
                <TextArea value={form.instructions} onChange={(v) => set('instructions', v)} rows={7} />
              </Field>
            </div>
          </Card>

          <Card title="Modell-Anforderungen & Provider">
            <div className="form-grid">
              <Field label="Capability-Klasse" help="Der Router wählt ein Modell dieser Klasse.">
                <Select value={form.capability} options={CAPABILITIES.map((c) => ({ value: c, label: CAPABILITY_LABELS[c] }))} onChange={(v) => v && set('capability', v)} />
              </Field>
              <Field label="Mindest-Kontextfenster (Tokens)" help="z. B. 64000 – Modelle mit kleinerem Kontext werden ignoriert.">
                <NumberInput value={form.min_context_tokens} onChange={(v) => set('min_context_tokens', v ?? 0)} step={1000} />
              </Field>
              <Field label="Provider-Policy bei erschöpftem Kontingent">
                <Select value={form.provider_policy} options={PROVIDER_POLICIES.map((p) => ({ value: p, label: PROVIDER_POLICY_LABELS[p] }))} onChange={(v) => v && set('provider_policy', v)} />
              </Field>
              <Field label="Effort (optional)" help="Denktiefe, falls das Modell es unterstützt.">
                <Select value={form.effort ?? null} allowEmpty="Standard des Modells" options={EFFORTS.map((e) => ({ value: e, label: e }))} onChange={(v) => set('effort', v)} />
              </Field>
              <Field label="Erlaubte Provider (Reihenfolge = Präferenz)" help="Keiner ausgewählt = alle aktiven Provider nach Priorität. Der erste ist der vorgesehene Provider." full>
                <div className="list-plain">
                  {[...allowed.map((pid) => providers.data!.find((p) => p.id === pid)).filter((p): p is ProviderView => !!p), ...providers.data.filter((p) => !allowed.includes(p.id))].map((p) => {
                    const on = allowed.includes(p.id);
                    return (
                      <div key={p.id} className="row">
                        <Check checked={on} onChange={(v) => toggleProvider(p.id, v)} label={`${on ? `${allowed.indexOf(p.id) + 1}. ` : ''}${p.name}`} />
                        {!p.enabled && <Badge>inaktiv</Badge>}
                        <Badge>{p.billing_mode === 'pay_as_you_go' ? 'Pay-as-you-go' : 'Abo'}</Badge>
                        {on && (
                          <>
                            <button className="small" type="button" onClick={() => moveProvider(p.id, -1)}>
                              ↑
                            </button>
                            <button className="small" type="button" onClick={() => moveProvider(p.id, 1)}>
                              ↓
                            </button>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              </Field>
            </div>
          </Card>

          <Card title="Werkzeuge (Tool Gateway)">
            <div className="list-plain">
              {TOOL_KEYS.map((t) => (
                <Check
                  key={t}
                  checked={(form.tools ?? []).includes(t)}
                  onChange={(v) => toggleTool(t, v)}
                  label={
                    <span>
                      <strong>{TOOLS[t].label}</strong> <span className="muted">– {TOOLS[t].description} (Level {TOOLS[t].level})</span>
                    </span>
                  }
                />
              ))}
            </div>
            <p className="small muted">Ein Job nutzt nur Werkzeuge, die sowohl der Job-Typ vorsieht als auch der Agent besitzt.</p>
          </Card>

          <Card title="Limits & Budget (Budget-first)">
            <div className="form-grid-3">
              <Field label="Standard-Priorität">
                <Select value={form.priority} options={PRIORITIES.map((p) => ({ value: p.value, label: p.label }))} onChange={(v) => set('priority', v ?? 1)} />
              </Field>
              <Field label="Max. Kosten pro Job (USD)" help="leer = kein Limit; gilt für kostenpflichtige Provider">
                <NumberInput value={form.max_job_cost_usd} onChange={(v) => set('max_job_cost_usd', v)} step={0.1} />
              </Field>
              <Field label="Monatsbudget (USD)" help="leer = kein Limit">
                <NumberInput value={form.monthly_budget_usd} onChange={(v) => set('monthly_budget_usd', v)} step={1} />
              </Field>
              <Field label="Max. Input-Tokens (Kontext)">
                <NumberInput value={form.max_input_tokens} onChange={(v) => set('max_input_tokens', v ?? 40000)} step={1000} />
              </Field>
              <Field label="Max. Output-Tokens">
                <NumberInput value={form.max_output_tokens} onChange={(v) => set('max_output_tokens', v ?? 8000)} step={1000} />
              </Field>
              <Field label="Max. Tool-Aufrufe">
                <NumberInput value={form.max_tool_calls} onChange={(v) => set('max_tool_calls', v ?? 0)} />
              </Field>
              <Field label="Max. Laufzeit (Sekunden)">
                <NumberInput value={form.max_runtime_sec} onChange={(v) => set('max_runtime_sec', v ?? 900)} step={60} />
              </Field>
              <Field label="Sortierung">
                <NumberInput value={form.sort_order} onChange={(v) => set('sort_order', v ?? 0)} />
              </Field>
            </div>
          </Card>
        </div>

        {!isNew && detail.data && (
          <div className="grid" style={{ alignContent: 'start' }}>
            <Card title="Verbrauch">
              <dl className="kv">
                <dt>Monat</dt>
                <dd>
                  {detail.data.month.requests} Aufrufe · {fmtTokens(detail.data.month.input_tokens + detail.data.month.output_tokens)} Tokens
                </dd>
                <dt>Kosten Monat</dt>
                <dd>
                  {fmtUsd(detail.data.month.monetary_cost_usd)} <span className="muted">(Gegenwert {fmtUsd(detail.data.month.equivalent_cost_usd)})</span>
                </dd>
                <dt>Gesamt</dt>
                <dd>
                  {detail.data.total.requests} Aufrufe · {fmtUsd(detail.data.total.monetary_cost_usd)}
                </dd>
              </dl>
            </Card>
            <Card title="Router-Vorschau">
              <p className="small muted" style={{ marginTop: 0 }}>
                Provider in Präferenzreihenfolge mit passenden Modellen (Kontext ≥ {fmtTokens(form.min_context_tokens ?? 0)}). Benötigt: <CapBadge c={form.capability ?? 'MEDIUM'} />
              </p>
              <ol className="small" style={{ paddingLeft: 18, margin: 0 }}>
                {detail.data.candidates.map((c) => (
                  <li key={c.provider.id}>
                    <strong>{c.provider.name}</strong>:{' '}
                    {c.models.length ? (
                      c.models.map((m) => (
                        <span key={m.id} style={{ marginRight: 6 }}>
                          {m.label} <span className="muted">({m.tier})</span>
                          {m.tier === form.capability ? ' ✓' : ''}
                        </span>
                      ))
                    ) : (
                      <span className="muted">kein passendes Modell</span>
                    )}
                  </li>
                ))}
              </ol>
              {!detail.data.candidates.length && <div className="alert warn small">Kein aktiver Provider erlaubt – Jobs dieses Agents werden blockiert.</div>}
            </Card>
            <Card title="Zuständig für">
              {detail.data.routes.length ? (
                <div className="chips">
                  {detail.data.routes.map((r) => (
                    <Badge key={r.job_type} kind={r.enabled ? 'info' : undefined}>
                      {label(r.job_type)}
                      {r.capability_override ? ` (${r.capability_override})` : ''}
                    </Badge>
                  ))}
                </div>
              ) : (
                <span className="muted small">Keine Job-Typen zugeordnet (nur freie Aufträge).</span>
              )}
            </Card>
            <Card title="Letzte Jobs">
              <ul className="list-plain small">
                {detail.data.jobs.map((j) => (
                  <li key={j.id}>
                    <a href={`#/jobs/${j.id}`}>#{j.id}</a> {j.title} <JobStatusBadge status={j.status} /> <span className="muted">{fmtRelative(j.updated_at)}</span>
                  </li>
                ))}
                {!detail.data.jobs.length && <li className="muted">noch keine</li>}
              </ul>
            </Card>
          </div>
        )}
      </div>
      {customJob && <NewJobDialog initialType="custom" initialAgent={form.id} onClose={() => setCustomJob(false)} />}
    </>
  );
}

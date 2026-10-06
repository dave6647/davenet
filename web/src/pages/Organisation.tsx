import { useState } from 'react';
import { APPROVAL_LEVELS, CAPABILITIES, TOOLS, type Agent, type Department, type JobRoute, type JobTypeInfo } from '../../../shared/domain.ts';
import { api } from '../api.ts';
import { Badge, CapBadge, Card, Check, ConfirmButton, ErrorBox, Field, Loading, Modal, NumberInput, PageHead, Select, TextArea, TextInput, useAction } from '../components/ui.tsx';
import { fmtUsd } from '../format.ts';
import { useApi } from '../live.ts';
import { navigate } from '../router.ts';

type AgentRow = Agent & { month: { requests: number; monetary_cost_usd: number; equivalent_cost_usd: number } | null };
type RouteRow = JobTypeInfo & { route: JobRoute };

export function Organisation() {
  const deps = useApi<Department[]>('/api/departments', ['department']);
  const agents = useApi<AgentRow[]>('/api/agents', ['agent', 'department', 'ledger']);
  const routes = useApi<RouteRow[]>('/api/routes', ['route', 'agent']);
  const [editDep, setEditDep] = useState<Partial<Department> | null>(null);
  const { run } = useAction();

  if (deps.error || agents.error) return <ErrorBox error={deps.error ?? agents.error} />;
  if (!deps.data || !agents.data) return <Loading />;

  const groups: { dep: Department | null; agents: AgentRow[] }[] = deps.data.map((d) => ({ dep: d, agents: agents.data!.filter((a) => a.department_id === d.id) }));
  const orphans = agents.data.filter((a) => !a.department_id || !deps.data!.some((d) => d.id === a.department_id));
  if (orphans.length) groups.push({ dep: null, agents: orphans });

  const deleteDep = (d: Department) =>
    run(async () => {
      await api.del(`/api/departments/${d.id}`);
      deps.reload();
      agents.reload();
    }, 'Abteilung gelöscht');

  return (
    <>
      <PageHead
        title="Organisation"
        subtitle="Abteilungen und Agents (Rollen). Agents sind an keinen Anbieter gebunden – das Modell wählt der Router zur Laufzeit."
        actions={
          <>
            <button onClick={() => setEditDep({})}>+ Abteilung</button>
            <button className="primary" onClick={() => navigate('/agents/new')}>
              + Agent
            </button>
          </>
        }
      />

      <div className="org">
        <div className="org-owner">OWNER – höchste Entscheidungsinstanz</div>
        {groups.map(({ dep, agents: list }) => (
          <div className="org-dept" key={dep?.id ?? '_none'}>
            <div className="org-dept-head">
              <strong>{dep ? dep.name : 'Ohne Abteilung'}</strong>
              {dep && <span className="muted small">{dep.description}</span>}
              <span className="spacer" />
              <span className="muted small">{list.length} Agent(s)</span>
              {dep && (
                <>
                  <button className="small" onClick={() => navigate(`/agents/new?department=${dep.id}`)}>
                    + Agent
                  </button>
                  <button className="small" onClick={() => setEditDep(dep)}>
                    Bearbeiten
                  </button>
                  <ConfirmButton
                    className="small danger"
                    confirm={`Abteilung "${dep.name}" löschen? Die Agents bleiben erhalten (ohne Abteilung).`}
                    onConfirm={() => deleteDep(dep)}
                  >
                    Löschen
                  </ConfirmButton>
                </>
              )}
            </div>
            <div className="org-agents">
              {list.map((a) => (
                <div key={a.id} className={`agent-card ${a.enabled ? '' : 'disabled'}`} onClick={() => navigate(`/agents/${a.id}`)}>
                  <div className="row">
                    <span className="title">{a.name}</span>
                    <span className="spacer" />
                    <CapBadge c={a.capability} />
                  </div>
                  <div className="mono muted">{a.id}</div>
                  <div className="small">{a.description}</div>
                  <div className="meta">
                    {!a.enabled && <Badge kind="err">deaktiviert</Badge>}
                    {a.tools.map((t) => (
                      <Badge key={t}>{TOOLS[t]?.label ?? t}</Badge>
                    ))}
                  </div>
                  <div className="small muted">
                    {a.provider_policy} · {a.allowed_providers.length ? a.allowed_providers.join(' → ') : 'alle aktiven Provider'}
                  </div>
                  <div className="small muted">
                    Monat: {a.month?.requests ?? 0} Aufrufe · {fmtUsd(a.month?.monetary_cost_usd ?? 0)} (Gegenwert {fmtUsd(a.month?.equivalent_cost_usd ?? 0)})
                  </div>
                </div>
              ))}
              {!list.length && <div className="muted small">Keine Agents in dieser Abteilung.</div>}
            </div>
          </div>
        ))}
      </div>

      <Card title="Zuständigkeiten (Job-Typ → Agent)">
        <p className="muted small" style={{ marginTop: 0 }}>
          Hier legst du fest, welcher Agent welchen Arbeitsschritt übernimmt. Rollen lassen sich so zusammenlegen oder aufteilen (Konzept §2, Phase 1/2).
          Optional kann ein Job-Typ eine andere Capability-Klasse nutzen als der Agent (z. B. Screening mit LOW). Deaktivierte Job-Typen werden in
          der Pipeline übersprungen.
        </p>
        {routes.data && agents.data && <RoutesTable rows={routes.data} agents={agents.data} reload={routes.reload} />}
      </Card>

      <Card title="Berechtigungen & Approval-Level (Konzept §14)">
        <table>
          <thead>
            <tr>
              <th>Level</th>
              <th>Freigabe</th>
              <th>Beispiele in Davenet</th>
            </tr>
          </thead>
          <tbody>
            {APPROVAL_LEVELS.map((l) => (
              <tr key={l.level}>
                <td>{l.level}</td>
                <td>{l.label}</td>
                <td className="muted">{l.examples}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {editDep && (
        <DepartmentDialog
          dep={editDep}
          onClose={() => setEditDep(null)}
          onSaved={() => {
            setEditDep(null);
            deps.reload();
          }}
        />
      )}
    </>
  );
}

function RoutesTable({ rows, agents, reload }: { rows: RouteRow[]; agents: AgentRow[]; reload: () => void }) {
  const { run } = useAction();
  const save = (key: string, patch: Partial<JobRoute>) =>
    run(async () => {
      await api.put(`/api/routes/${key}`, patch);
      reload();
    }, 'Zuständigkeit gespeichert');
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Job-Typ</th>
            <th>Zuständiger Agent</th>
            <th>Capability</th>
            <th>Aktiv</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>
                <strong>{r.label}</strong>
                <div className="small muted">{r.description}</div>
              </td>
              <td style={{ minWidth: 220 }}>
                <Select
                  value={r.route.agent_id}
                  allowEmpty="— kein Agent —"
                  options={agents.map((a) => ({ value: a.id, label: `${a.name} (${a.capability})${a.enabled ? '' : ' – deaktiviert'}` }))}
                  onChange={(v) => save(r.key, { agent_id: v })}
                />
              </td>
              <td style={{ minWidth: 160 }}>
                <Select
                  value={r.route.capability_override}
                  allowEmpty="wie Agent"
                  options={CAPABILITIES.map((c) => ({ value: c, label: c }))}
                  onChange={(v) => save(r.key, { capability_override: v })}
                />
              </td>
              <td>
                <Check checked={r.route.enabled} onChange={(v) => save(r.key, { enabled: v })} label="" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DepartmentDialog({ dep, onClose, onSaved }: { dep: Partial<Department>; onClose: () => void; onSaved: () => void }) {
  const isNew = !dep.id || !dep.created_at;
  const [form, setForm] = useState<Partial<Department>>({ sort_order: 10, ...dep });
  const { run, busy } = useAction();
  const save = () =>
    run(async () => {
      if (isNew) await api.post('/api/departments', form);
      else await api.put(`/api/departments/${dep.id}`, { name: form.name, description: form.description, sort_order: form.sort_order });
      onSaved();
    }, 'Abteilung gespeichert');
  return (
    <Modal
      title={isNew ? 'Neue Abteilung' : `Abteilung ${dep.name}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Abbrechen</button>
          <button className="primary" disabled={busy || !form.name || !form.id} onClick={save}>
            Speichern
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Kennung" help="z. B. marketing (nicht mehr änderbar)">
          <TextInput value={form.id} disabled={!isNew} onChange={(v) => setForm({ ...form, id: v })} />
        </Field>
        <Field label="Name">
          <TextInput value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
        </Field>
        <Field label="Beschreibung" full>
          <TextArea value={form.description} onChange={(v) => setForm({ ...form, description: v })} rows={3} />
        </Field>
        <Field label="Reihenfolge">
          <NumberInput value={form.sort_order} onChange={(v) => setForm({ ...form, sort_order: v ?? 0 })} />
        </Field>
      </div>
    </Modal>
  );
}


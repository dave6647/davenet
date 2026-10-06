import { useEffect, useState } from 'react';
import type { Approval, Artifact, Job, Opportunity, Task } from '../../../shared/domain.ts';
import { api, qs } from '../api.ts';
import { ArtifactList, ArtifactViewer } from '../components/artifacts.tsx';
import {
  ApprovalStatusBadge,
  Badge,
  Card,
  ConfirmButton,
  ErrorBox,
  Field,
  JobStatusBadge,
  Loading,
  Markdown,
  Modal,
  OppStatusBadge,
  PageHead,
  Tabs,
  TaskStatusBadge,
  TextArea,
  TextInput,
  useAction,
} from '../components/ui.tsx';
import { fmtDateTime, fmtRelative, fmtTokens, fmtUsd } from '../format.ts';
import { useApi } from '../live.ts';
import { useJobTypeLabel } from '../meta.tsx';
import { navigate } from '../router.ts';

interface Detail {
  opportunity: Opportunity;
  tasks: Task[];
  jobs: Job[];
  artifacts: Artifact[];
  approvals: Approval[];
  usage: { requests: number; input_tokens: number; output_tokens: number; monetary_cost_usd: number; equivalent_cost_usd: number } | null;
  workspace: { dir: string; files: { path: string; size: number }[] };
}

type Tab = 'overview' | 'project' | 'artifacts' | 'jobs';

const PRE_APPROVAL = ['DISCOVERED', 'SCREENING', 'RESEARCH', 'EVALUATION', 'PROPOSED', 'REJECTED', 'ON_HOLD'];
const IN_PROJECT = ['APPROVED', 'DEVELOPMENT', 'REVIEW', 'READY', 'DEPLOYED'];

export function OpportunityPage({ id }: { id: string }) {
  const { data, error } = useApi<Detail>(`/api/opportunities/${id}`, ['opportunity', 'task', 'job', 'approval', 'ledger']);
  const [tab, setTab] = useState<Tab>('overview');
  const [actionNote, setActionNote] = useState<{ action: string; label: string; help: string } | null>(null);
  const { run, busy } = useAction();
  const label = useJobTypeLabel();

  useEffect(() => {
    if (data && IN_PROJECT.includes(data.opportunity.status) && tab === 'overview' && data.tasks.length) setTab('project');
    // nur beim ersten Laden umschalten
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.opportunity.id]);

  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const o = data.opportunity;
  const pendingApproval = data.approvals.find((a) => a.status === 'PENDING');

  const action = (a: string, note?: string) =>
    run(async () => {
      await api.post(`/api/opportunities/${id}/action`, { action: a, note: note ?? null });
    }, 'Aktion ausgeführt');
  const remove = () =>
    run(async () => {
      await api.del(`/api/opportunities/${id}`);
      navigate('/opportunities');
    }, 'Opportunity gelöscht');

  const pre = PRE_APPROVAL.includes(o.status);
  const project = IN_PROJECT.includes(o.status) && o.status !== 'DEPLOYED';

  return (
    <>
      <PageHead
        title={
          <>
            <span className="muted">{o.id}</span> {o.title}
          </>
        }
        subtitle={
          <span className="row">
            <OppStatusBadge status={o.status} />
            {o.status_reason && <span className="muted">{o.status_reason}</span>}
          </span>
        }
        actions={
          <>
            <button onClick={() => navigate('/opportunities')}>← Pipeline</button>
            {pendingApproval && (
              <button className="primary" onClick={() => navigate('/approvals')}>
                Zur Freigabe
              </button>
            )}
          </>
        }
      />

      <Card>
        <div className="row">
          <strong>Aktionen:</strong>
          {pre && (
            <>
              <button disabled={busy} onClick={() => action('screen')} title="Schnelle Vorbewertung durch den Scout">
                Screening
              </button>
              <button disabled={busy} onClick={() => setActionNote({ action: 'research', label: 'Tiefenrecherche starten', help: 'Zusätzliche Fragen an den Analyst (optional)' })}>
                Tiefenrecherche
              </button>
              <button disabled={busy} onClick={() => action('evaluate')}>
                Bewerten
              </button>
              <button disabled={busy || o.status === 'PROPOSED'} onClick={() => action('propose')} title="Legt dir den Projektstart zur Freigabe vor">
                Zur Freigabe vorlegen
              </button>
            </>
          )}
          {project && (
            <>
              <button disabled={busy} onClick={() => setActionNote({ action: 'plan', label: 'MVP neu planen', help: 'Vorgaben für den Technical Planner (optional)' })}>
                {data.tasks.length ? 'Neu planen' : 'Planen'}
              </button>
              <button disabled={busy || !data.tasks.length} onClick={() => action('start_development')}>
                Umsetzung starten/fortsetzen
              </button>
              <button disabled={busy || !data.tasks.length || data.tasks.some((t) => t.status !== 'DONE')} onClick={() => action('request_release')}>
                Release anfordern
              </button>
            </>
          )}
          <span className="spacer" />
          {o.status !== 'REJECTED' && o.status !== 'DEPLOYED' && (
            <button className="danger" disabled={busy} onClick={() => setActionNote({ action: 'reject', label: 'Verwerfen', help: 'Begründung (optional)' })}>
              Verwerfen
            </button>
          )}
          {o.status !== 'ON_HOLD' && o.status !== 'DEPLOYED' && (
            <button disabled={busy} onClick={() => action('hold')}>
              Zurückstellen
            </button>
          )}
          {(o.status === 'REJECTED' || o.status === 'ON_HOLD') && (
            <button disabled={busy} onClick={() => action('reopen')}>
              Wieder öffnen
            </button>
          )}
          <ConfirmButton className="small danger" confirm={`${o.id} endgültig löschen?`} onConfirm={remove}>
            Löschen
          </ConfirmButton>
        </div>
      </Card>

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'overview', label: 'Überblick' },
          { key: 'project', label: `Projekt & Tasks (${data.tasks.length})` },
          { key: 'artifacts', label: `Artefakte (${data.artifacts.length})` },
          { key: 'jobs', label: `Jobs (${data.jobs.length})` },
        ]}
      />

      {tab === 'overview' && <Overview d={data} />}
      {tab === 'project' && <Project d={data} />}
      {tab === 'artifacts' && (
        <Card>
          <ArtifactList artifacts={data.artifacts} />
        </Card>
      )}
      {tab === 'jobs' && (
        <Card>
          <table>
            <tbody>
              {data.jobs.map((j) => (
                <tr key={j.id} className="clickable" onClick={() => navigate(`/jobs/${j.id}`)}>
                  <td className="muted">#{j.id}</td>
                  <td>
                    {j.title}
                    <div className="small muted">
                      {label(j.type)} · {j.agent_id}
                    </div>
                  </td>
                  <td>
                    <JobStatusBadge status={j.status} />
                  </td>
                  <td className="num">{fmtTokens(j.input_tokens + j.output_tokens)}</td>
                  <td className="small muted nowrap">{fmtRelative(j.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!data.jobs.length && <div className="empty">Keine Jobs.</div>}
        </Card>
      )}

      {actionNote && (
        <NoteDialog
          title={actionNote.label}
          help={actionNote.help}
          onClose={() => setActionNote(null)}
          onSubmit={(note) => {
            setActionNote(null);
            action(actionNote.action, note);
          }}
        />
      )}
    </>
  );
}

function NoteDialog({ title, help, onClose, onSubmit }: { title: string; help: string; onClose: () => void; onSubmit: (note: string) => void }) {
  const [note, setNote] = useState('');
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Abbrechen</button>
          <button className="primary" onClick={() => onSubmit(note)}>
            Ausführen
          </button>
        </>
      }
    >
      <Field label={help}>
        <TextArea value={note} onChange={setNote} rows={4} />
      </Field>
    </Modal>
  );
}

function Overview({ d }: { d: Detail }) {
  const o = d.opportunity;
  const [edit, setEdit] = useState(false);
  const [form, setForm] = useState(o);
  const { run, busy } = useAction();
  useEffect(() => setForm(o), [o]);
  const save = () =>
    run(async () => {
      await api.put(`/api/opportunities/${o.id}`, {
        title: form.title,
        problem: form.problem,
        target_customer: form.target_customer,
        proposed_solution: form.proposed_solution,
        competition_summary: form.competition_summary,
        revenue_model: form.revenue_model,
        notes: form.notes,
      });
      setEdit(false);
    }, 'Gespeichert');
  const fields: [keyof Opportunity, string][] = [
    ['problem', 'Problem'],
    ['target_customer', 'Zielkunden'],
    ['proposed_solution', 'Lösungsidee'],
    ['competition_summary', 'Wettbewerb'],
    ['revenue_model', 'Umsatzmodell'],
    ['notes', 'Notizen'],
  ];
  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(260px, 1fr)' }}>
      <Card
        title="Opportunity-Artefakt"
        actions={
          edit ? (
            <>
              <button className="small" onClick={() => setEdit(false)}>
                Abbrechen
              </button>
              <button className="small primary" disabled={busy} onClick={save}>
                Speichern
              </button>
            </>
          ) : (
            <button className="small" onClick={() => setEdit(true)}>
              Bearbeiten
            </button>
          )
        }
      >
        {edit ? (
          <div className="form-grid">
            <Field label="Titel" full>
              <TextInput value={form.title} onChange={(v) => setForm({ ...form, title: v })} />
            </Field>
            {fields.map(([k, l]) => (
              <Field key={k} label={l} full>
                <TextArea value={String(form[k] ?? '')} onChange={(v) => setForm({ ...form, [k]: v })} rows={3} />
              </Field>
            ))}
          </div>
        ) : (
          <dl className="kv">
            {fields.map(([k, l]) => (
              <div key={k} style={{ display: 'contents' }}>
                <dt>{l}</dt>
                <dd>{String(o[k] ?? '').trim() ? <Markdown text={String(o[k])} /> : <span className="muted">–</span>}</dd>
              </div>
            ))}
          </dl>
        )}
      </Card>
      <div className="grid" style={{ alignContent: 'start' }}>
        <Card title="Bewertung">
          <div className="stat">
            <span className="label">Gesamt-Score</span>
            <span className="value">{o.score ?? '–'}</span>
          </div>
          <dl className="kv" style={{ marginTop: 8 }}>
            <dt>Markt</dt>
            <dd>{o.market_score ?? '–'} / 10</dd>
            <dt>Technik</dt>
            <dd>{o.technical_score ?? '–'} / 10</dd>
            <dt>Risiko</dt>
            <dd>{o.risk_score ?? '–'} / 10 (hoch = riskant)</dd>
            <dt>Konfidenz</dt>
            <dd>{o.confidence ?? '–'}</dd>
            <dt>Herkunft</dt>
            <dd>{o.origin}</dd>
            <dt>Angelegt</dt>
            <dd>{fmtDateTime(o.created_at)}</dd>
          </dl>
        </Card>
        {d.usage && (
          <Card title="Verbrauch (gesamt)">
            <dl className="kv">
              <dt>Aufrufe</dt>
              <dd>{d.usage.requests}</dd>
              <dt>Tokens</dt>
              <dd>{fmtTokens(d.usage.input_tokens + d.usage.output_tokens)}</dd>
              <dt>Kosten</dt>
              <dd>
                {fmtUsd(d.usage.monetary_cost_usd)} <span className="muted">(Gegenwert {fmtUsd(d.usage.equivalent_cost_usd)})</span>
              </dd>
            </dl>
          </Card>
        )}
        <Card title={`Quellen (${o.sources.length})`}>
          <ul className="list-plain small">
            {o.sources.map((s, i) => (
              <li key={i}>
                <a href={s.url} target="_blank" rel="noopener noreferrer">
                  {s.title || s.url}
                </a>
                {s.note && <div className="muted">{s.note}</div>}
              </li>
            ))}
            {!o.sources.length && <li className="muted">keine</li>}
          </ul>
        </Card>
        <Card title="Freigaben">
          <ul className="list-plain small">
            {d.approvals.map((a) => (
              <li key={a.id}>
                #{a.id} {a.title} <ApprovalStatusBadge status={a.status} />
                {a.decision_note && <div className="muted">Notiz: {a.decision_note}</div>}
              </li>
            ))}
            {!d.approvals.length && <li className="muted">keine</li>}
          </ul>
        </Card>
      </div>
    </div>
  );
}

function Project({ d }: { d: Detail }) {
  const o = d.opportunity;
  const spec = d.artifacts.find((a) => a.kind === 'spec');
  const specContent = useApi<{ content: string }>(spec ? `/api/artifacts/${spec.id}` : null);
  const [addTask, setAddTask] = useState(false);
  const [file, setFile] = useState<string | null>(null);
  const [openArtifact, setOpenArtifact] = useState<number | null>(null);
  const { run, busy } = useAction();
  const taskAction = (t: Task, action: string) => run(() => api.post(`/api/tasks/${t.id}/action`, { action }), 'Aktion ausgeführt');
  const done = d.tasks.filter((t) => t.status === 'DONE').length;

  return (
    <div className="grid">
      <Card
        title={`Tasks (${done}/${d.tasks.length} erledigt)`}
        actions={
          <button className="small" onClick={() => setAddTask(true)}>
            + Task
          </button>
        }
      >
        {!d.tasks.length ? (
          <div className="empty">
            Noch keine Tasks. {['APPROVED', 'DEVELOPMENT'].includes(o.status) ? 'Die technische Planung erzeugt sie nach der Freigabe.' : 'Tasks entstehen nach der Freigabe des Projektstarts.'}
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Status</th>
                  <th>Abhängig von</th>
                  <th>Letztes Review</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {d.tasks.map((t) => {
                  const reports = d.artifacts.filter((a) => a.task_id === t.id);
                  return (
                    <tr key={t.id}>
                      <td style={{ maxWidth: 420 }}>
                        <strong>
                          {t.key} {t.title}
                        </strong>
                        <div className="small muted">{t.description}</div>
                        {t.acceptance_criteria.length > 0 && (
                          <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                            {t.acceptance_criteria.map((c, i) => (
                              <li key={i}>{c}</li>
                            ))}
                          </ul>
                        )}
                        {reports.length > 0 && (
                          <div className="small" style={{ marginTop: 4 }}>
                            {reports.map((a) => (
                              <button key={a.id} className="link" style={{ marginRight: 8 }} onClick={() => setOpenArtifact(a.id)}>
                                {a.title}
                              </button>
                            ))}
                          </div>
                        )}
                      </td>
                      <td>
                        <TaskStatusBadge status={t.status} />
                        {t.rework_count > 0 && <div className="small muted">Nacharbeit: {t.rework_count}×</div>}
                      </td>
                      <td className="small">{t.depends_on.join(', ') || '–'}</td>
                      <td className="small" style={{ maxWidth: 260 }}>
                        {t.last_review ? (
                          <>
                            <Badge kind={t.last_review.verdict === 'PASS' ? 'ok' : 'warn'}>{t.last_review.verdict}</Badge> {t.last_review.summary}
                          </>
                        ) : (
                          '–'
                        )}
                      </td>
                      <td className="nowrap">
                        {['TODO', 'BLOCKED', 'REWORK'].includes(t.status) && (
                          <button className="small" disabled={busy} onClick={() => taskAction(t, 'implement')}>
                            Umsetzen
                          </button>
                        )}{' '}
                        {['BLOCKED', 'IN_REVIEW'].includes(t.status) && (
                          <button className="small" disabled={busy} onClick={() => taskAction(t, 'review')}>
                            Review
                          </button>
                        )}{' '}
                        {t.status !== 'DONE' && (
                          <button className="small" disabled={busy} onClick={() => taskAction(t, 'mark_done')}>
                            Erledigt
                          </button>
                        )}{' '}
                        <ConfirmButton className="small danger" confirm={`Task ${t.key} löschen?`} onConfirm={() => taskAction(t, 'delete')}>
                          ✕
                        </ConfirmButton>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid grid-2">
        <Card title="MVP-Spezifikation">
          {spec ? specContent.data ? <Markdown text={specContent.data.content} /> : <Loading /> : <div className="muted small">Noch keine Spezifikation.</div>}
        </Card>
        <Card title={`Workspace (${d.workspace.files.length} Dateien)`}>
          <div className="small muted mono wrap-anywhere" style={{ marginBottom: 8 }}>
            {d.workspace.dir}
          </div>
          <ul className="list-plain small scroll-y">
            {d.workspace.files.map((f) => (
              <li key={f.path}>
                <button className="link" onClick={() => setFile(f.path)}>
                  {f.path}
                </button>{' '}
                <span className="muted">{f.size} B</span>
              </li>
            ))}
            {!d.workspace.files.length && <li className="muted">leer</li>}
          </ul>
        </Card>
      </div>
      {addTask && <TaskDialog oppId={o.id} onClose={() => setAddTask(false)} />}
      {file && <WorkspaceFile oppId={o.id} path={file} onClose={() => setFile(null)} />}
      {openArtifact != null && <ArtifactViewer id={openArtifact} onClose={() => setOpenArtifact(null)} />}
    </div>
  );
}

function WorkspaceFile({ oppId, path, onClose }: { oppId: string; path: string; onClose: () => void }) {
  const { data, error } = useApi<{ content: string }>(`/api/opportunities/${oppId}/workspace${qs({ path })}`);
  return (
    <Modal title={path} onClose={onClose} wide>
      <ErrorBox error={error} />
      {data ? path.endsWith('.md') ? <Markdown text={data.content} /> : <pre>{data.content}</pre> : <Loading />}
    </Modal>
  );
}

function TaskDialog({ oppId, onClose }: { oppId: string; onClose: () => void }) {
  const [f, setF] = useState({ title: '', description: '', criteria: '', depends: '' });
  const { run, busy } = useAction();
  const save = () =>
    run(async () => {
      await api.post(`/api/opportunities/${oppId}/tasks`, {
        title: f.title,
        description: f.description,
        acceptance_criteria: f.criteria.split('\n').map((s) => s.trim()).filter(Boolean),
        depends_on: f.depends.split(',').map((s) => s.trim()).filter(Boolean),
      });
      onClose();
    }, 'Task angelegt');
  return (
    <Modal
      title="Neue Task"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Abbrechen</button>
          <button className="primary" disabled={busy || !f.title.trim()} onClick={save}>
            Anlegen
          </button>
        </>
      }
    >
      <Field label="Titel *">
        <TextInput value={f.title} onChange={(v) => setF({ ...f, title: v })} />
      </Field>
      <Field label="Beschreibung">
        <TextArea value={f.description} onChange={(v) => setF({ ...f, description: v })} />
      </Field>
      <Field label="Akzeptanzkriterien (eine pro Zeile)">
        <TextArea value={f.criteria} onChange={(v) => setF({ ...f, criteria: v })} />
      </Field>
      <Field label="Abhängig von (Keys, kommagetrennt)" help="z. B. T1, T2">
        <TextInput value={f.depends} onChange={(v) => setF({ ...f, depends: v })} />
      </Field>
    </Modal>
  );
}

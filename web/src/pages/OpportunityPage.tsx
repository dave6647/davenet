import { useEffect, useState } from 'react';
import {
  CRITERIA,
  LEGAL_STATUS_LABELS,
  TEST_STATUS_LABELS,
  TEST_VERDICT_LABELS,
  type Approval,
  type Artifact,
  type FinanceEntry,
  type FinanceTotals,
  type Job,
  type LegalStatus,
  type Opportunity,
  type Task,
  type TestPlan,
  type TestStatus,
} from '../../../shared/domain.ts';
import { api, qs } from '../api.ts';
import { ArtifactList, ArtifactViewer } from '../components/artifacts.tsx';
import { FinanceEntryDialog, FinanceEntryTable, FinanceTotalsView, fmtEur, fmtHours } from '../components/finance.tsx';
import {
  ApprovalStatusBadge,
  Badge,
  Card,
  ConfirmButton,
  ErrorBox,
  Field,
  JobStatusBadge,
  NumberInput,
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
import { fmtDate, fmtDateTime, fmtRelative, fmtTokens, fmtUsd } from '../format.ts';
import { useApi } from '../live.ts';
import { useJobTypeLabel } from '../meta.tsx';
import { navigate } from '../router.ts';
import { RecommendationBadge } from './Portfolio.tsx';

interface Detail {
  opportunity: Opportunity;
  tasks: Task[];
  jobs: Job[];
  artifacts: Artifact[];
  approvals: Approval[];
  usage: { requests: number; input_tokens: number; output_tokens: number; monetary_cost_usd: number; equivalent_cost_usd: number } | null;
  workspace: { dir: string; files: { path: string; size: number }[] };
}

type Tab = 'overview' | 'test' | 'project' | 'artifacts' | 'jobs';

const PRE_APPROVAL = ['DISCOVERED', 'SCREENING', 'RESEARCH', 'EVALUATION', 'PROPOSED', 'REJECTED', 'ON_HOLD'];
const IN_PROJECT = ['APPROVED', 'DEVELOPMENT', 'REVIEW', 'READY', 'DEPLOYED'];
const IMAGE_FILE = /\.(png|jpe?g|webp|gif)$/i;

export function OpportunityPage({ id }: { id: string }) {
  const { data, error } = useApi<Detail>(`/api/opportunities/${id}`, ['opportunity', 'task', 'job', 'approval', 'ledger']);
  const [tab, setTab] = useState<Tab>('overview');
  const [actionNote, setActionNote] = useState<{ action: string; label: string; help: string } | null>(null);
  const { run, busy } = useAction();
  const label = useJobTypeLabel();

  useEffect(() => {
    if (data && IN_PROJECT.includes(data.opportunity.status) && tab === 'overview' && data.tasks.length) setTab('project');
    else if (data && data.opportunity.status === 'TESTING' && tab === 'overview') setTab('test');
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
  const testing = o.status === 'TESTING';
  const project = IN_PROJECT.includes(o.status) && o.status !== 'DEPLOYED';
  const testStatus = o.test?.status;
  const pendingTest = data.approvals.some((a) => a.status === 'PENDING' && a.type === 'TEST_START');

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
              <button
                disabled={busy || !o.test?.plan || pendingTest}
                onClick={() => action('propose_test')}
                title={o.test?.plan ? 'Legt dir den kleinen Nachfragetest zur Freigabe vor' : 'Testplan entsteht bei der Bewertung'}
              >
                Nachfragetest vorschlagen
              </button>
              <button disabled={busy} onClick={() => action('propose')} title="Ohne Nachfragetest direkt den Bau zur Freigabe vorlegen">
                Bau direkt vorschlagen
              </button>
            </>
          )}
          {testing && (
            <>
              {(testStatus === 'READY' || testStatus === 'PREPARING') && (
                <button className="primary" disabled={busy} onClick={() => action('test_live')} title="Deine Schritte sind erledigt – die Testlaufzeit beginnt">
                  Test ist live
                </button>
              )}
              {(testStatus === 'READY' || testStatus === 'RUNNING') && (
                <button
                  disabled={busy}
                  onClick={() => setActionNote({ action: 'test_result', label: 'Testergebnis erfassen', help: 'Was ist passiert? Zahlen und Beobachtungen (z. B. 3 Verkäufe, 40 Besuche, 2 Anfragen)' })}
                >
                  Ergebnis erfassen
                </button>
              )}
              {o.test?.result && testStatus !== 'EVALUATING' && (
                <button disabled={busy} onClick={() => action('evaluate_test')}>
                  Erneut auswerten
                </button>
              )}
              <button disabled={busy || data.approvals.some((a) => a.status === 'PENDING' && a.type === 'PROJECT_START')} onClick={() => action('propose')}>
                Bau vorschlagen
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
          {pre && o.status !== 'REJECTED' && (
            <button className="danger" disabled={busy} onClick={() => setActionNote({ action: 'reject', label: 'Verwerfen', help: 'Begründung (optional)' })}>
              Verwerfen
            </button>
          )}
          {(testing || IN_PROJECT.includes(o.status)) && (
            <button className="danger" disabled={busy} onClick={() => setActionNote({ action: 'stop', label: 'Beenden', help: 'Warum wird beendet? Laufende Listings, Abos oder Verträge beendest du selbst.' })}>
              Beenden
            </button>
          )}
          {o.status !== 'ON_HOLD' && pre && (
            <button disabled={busy} onClick={() => action('hold')}>
              Zurückstellen
            </button>
          )}
          {(o.status === 'REJECTED' || o.status === 'ON_HOLD' || o.status === 'STOPPED') && (
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
          { key: 'test', label: o.test ? `Test & Zahlen (${TEST_STATUS_LABELS[o.test.status]})` : 'Test & Zahlen' },
          { key: 'project', label: `Projekt & Tasks (${data.tasks.length})` },
          { key: 'artifacts', label: `Artefakte (${data.artifacts.length})` },
          { key: 'jobs', label: `Jobs (${data.jobs.length})` },
        ]}
      />

      {tab === 'overview' && <Overview d={data} />}
      {tab === 'test' && <TestAndNumbers d={data} />}
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
      <div className="grid" style={{ alignContent: 'start' }}>
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
      {o.criteria && <CriteriaCard o={o} />}
      </div>
      <div className="grid" style={{ alignContent: 'start' }}>
        <Card title="Bewertung">
          <div className="stat">
            <span className="label">Gesamt-Score</span>
            <span className="value">{o.score ?? '–'}</span>
          </div>
          {o.knockouts.length > 0 && (
            <div className="alert error small" style={{ marginTop: 8 }}>
              K.-o.: {o.knockouts.join('; ')}
            </div>
          )}
          <dl className="kv" style={{ marginTop: 8 }}>
            {!o.criteria && o.market_score != null && (
              <>
                <dt>Markt</dt>
                <dd>{o.market_score} / 10</dd>
                <dt>Technik</dt>
                <dd>{o.technical_score ?? '–'} / 10</dd>
                <dt>Risiko</dt>
                <dd>{o.risk_score ?? '–'} / 10 (hoch = riskant)</dd>
              </>
            )}
            <dt>Konfidenz</dt>
            <dd>{o.confidence ?? '–'}</dd>
            <dt>Herkunft</dt>
            <dd>{o.origin}</dd>
            <dt>Angelegt</dt>
            <dd>{fmtDateTime(o.created_at)}</dd>
          </dl>
        </Card>
        <LegalCard o={o} />
        {o.portfolio_note && (
          <Card title="Portfolio-Review">
            <RecommendationBadge r={o.portfolio_note.recommendation} /> <span className="small muted">{fmtDate(o.portfolio_note.at)}</span>
            <p className="small">{o.portfolio_note.reason}</p>
            {o.portfolio_note.forecast && <p className="small muted">Prognose: {o.portfolio_note.forecast}</p>}
          </Card>
        )}
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
  if (IMAGE_FILE.test(path)) {
    return (
      <Modal title={path} onClose={onClose} wide>
        <img src={`/api/opportunities/${oppId}/workspace/raw${qs({ path })}`} alt={path} style={{ maxWidth: '100%', borderRadius: 6 }} />
      </Modal>
    );
  }
  return <WorkspaceTextFile oppId={oppId} path={path} onClose={onClose} />;
}

function WorkspaceTextFile({ oppId, path, onClose }: { oppId: string; path: string; onClose: () => void }) {
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

// ---------------------------------------------------------------- Bewertung, Rechtsprüfung, Test & Zahlen

function ScoreBar({ v }: { v: number }) {
  return (
    <div className={`bar ${v < 4 ? 'err' : v < 6 ? 'warn' : ''}`} style={{ width: 110 }} role="meter" aria-valuenow={v} aria-valuemin={0} aria-valuemax={10}>
      <span style={{ width: `${Math.max(0, Math.min(10, v)) * 10}%` }} />
    </div>
  );
}

function CriteriaCard({ o }: { o: Opportunity }) {
  const c = o.criteria ?? {};
  return (
    <Card title="Bewertung nach 13 Kriterien" actions={<span className="small muted">10 = am besten, auch bei Aufwand und Risiko</span>}>
      <div className="table-wrap">
        <table>
          <tbody>
            {CRITERIA.map((k) => {
              const v = c[k.key];
              return (
                <tr key={k.key}>
                  <td className="nowrap" title={k.question}>
                    {k.label}
                  </td>
                  <td className="nowrap">{v ? <ScoreBar v={v.score} /> : null}</td>
                  <td className="num nowrap">{v ? v.score : '–'}</td>
                  <td className="small muted">{v?.note || ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

const LEGAL_KIND: Record<LegalStatus, 'ok' | 'warn' | 'err'> = { green: 'ok', yellow: 'warn', red: 'err' };

function LegalCard({ o }: { o: Opportunity }) {
  const l = o.legal;
  if (!l) {
    return (
      <Card title="Rechtliche Prüfung">
        <div className="muted small">Noch nicht geprüft – entsteht im Screening (vorläufig) und in der Tiefenrecherche.</div>
      </Card>
    );
  }
  const h = (v: number | null) => (v == null ? '–' : v.toLocaleString('de-DE'));
  return (
    <Card title="Rechtliche Prüfung" actions={<span className="small muted">{l.source === 'research' ? 'Tiefenrecherche' : 'Screening (vorläufig)'}</span>}>
      <Badge kind={LEGAL_KIND[l.status]}>{LEGAL_STATUS_LABELS[l.status]}</Badge>
      {l.how_possible && <p className="small">{l.how_possible}</p>}
      {l.source === 'research' && (
        <p className="small muted">
          Aufwand einmalig {h(l.effort_one_time_hours)} Std. / {h(l.effort_one_time_eur)} € · laufend {h(l.effort_ongoing_hours_month)} Std. /{' '}
          {h(l.effort_ongoing_eur_month)} € pro Monat
        </p>
      )}
      {l.steps.length > 0 && (
        <ol className="small" style={{ paddingLeft: 18 }}>
          {l.steps.map((s, i) => (
            <li key={i}>
              <strong>{s.step}</strong>
              {s.details && <span className="muted"> – {s.details}</span>}
            </li>
          ))}
        </ol>
      )}
      {l.open_questions.length > 0 && (
        <>
          <div className="small">
            <strong>Offene Fragen</strong>
          </div>
          <ul className="small" style={{ paddingLeft: 18 }}>
            {l.open_questions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </>
      )}
      <div className="small muted">Keine Rechtsberatung – im Zweifel fachlich prüfen lassen.</div>
    </Card>
  );
}

const TEST_KIND: Record<TestStatus, 'ok' | 'warn' | 'err' | 'info' | 'accent'> = {
  PROPOSED: 'warn',
  PREPARING: 'info',
  READY: 'warn',
  RUNNING: 'accent',
  EVALUATING: 'info',
  PASSED: 'ok',
  FAILED: 'err',
};

function PlanView({ p }: { p: TestPlan }) {
  return (
    <>
      <dl className="kv">
        <dt>Hypothese</dt>
        <dd>{p.hypothesis}</dd>
        <dt>Kanal</dt>
        <dd>{p.channel}</dd>
        <dt>Budget</dt>
        <dd>
          {fmtEur(p.budget_eur)} extern · {fmtHours(p.owner_hours)} deine Zeit
        </dd>
        <dt>Laufzeit</dt>
        <dd>{p.duration_days} Tage</dd>
        <dt>Messgröße</dt>
        <dd>{p.metric}</dd>
        <dt>Erfolg, wenn</dt>
        <dd>
          <strong>{p.success_criterion}</strong>
        </dd>
      </dl>
      <div className="grid grid-2" style={{ marginTop: 10 }}>
        <div>
          <strong className="small">Deine Schritte</strong>
          <ul className="small" style={{ paddingLeft: 18 }}>
            {p.owner_steps.length ? p.owner_steps.map((x, i) => <li key={i}>{x}</li>) : <li className="muted">keine</li>}
          </ul>
        </div>
        <div>
          <strong className="small">Bereitet Davenet vor</strong>
          <ul className="small" style={{ paddingLeft: 18 }}>
            {p.materials.length ? p.materials.map((x, i) => <li key={i}>{x}</li>) : <li className="muted">nichts</li>}
          </ul>
        </div>
      </div>
    </>
  );
}

function sumEntries(entries: FinanceEntry[], since?: string): FinanceTotals {
  const t: FinanceTotals = { revenue_eur: 0, expense_eur: 0, hours: 0, entries: 0 };
  for (const e of entries) {
    if (since && e.date < since) continue;
    t.entries++;
    if (e.kind === 'revenue') t.revenue_eur += e.amount_eur ?? 0;
    else if (e.kind === 'expense') t.expense_eur += e.amount_eur ?? 0;
    else t.hours += e.hours ?? 0;
  }
  return t;
}

function TestAndNumbers({ d }: { d: Detail }) {
  const o = d.opportunity;
  const t = o.test;
  const entries = useApi<FinanceEntry[]>(`/api/finance/entries${qs({ opportunity_id: o.id, limit: 500 })}`, ['finance']);
  const [add, setAdd] = useState(false);
  const [fixed, setFixed] = useState<number | null>(o.fixed_costs_eur_month);
  const [kit, setKit] = useState<number | null>(null);
  const { run, busy } = useAction();
  useEffect(() => setFixed(o.fixed_costs_eur_month), [o.fixed_costs_eur_month]);
  const testKit = d.artifacts.find((a) => a.kind === 'test_kit');
  const evaluation = d.artifacts.find((a) => a.kind === 'test_evaluation');
  const list = entries.data ?? [];
  const since30 = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const saveFixed = () => run(() => api.put(`/api/opportunities/${o.id}`, { fixed_costs_eur_month: fixed }), 'Fixkosten gespeichert');

  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 3fr) minmax(280px, 2fr)' }}>
      <div className="grid" style={{ alignContent: 'start' }}>
        <Card
          title={t ? `Nachfragetest${t.attempt > 1 ? ` – Versuch ${t.attempt}` : ''}` : 'Nachfragetest'}
          actions={t && <Badge kind={TEST_KIND[t.status]}>{TEST_STATUS_LABELS[t.status]}</Badge>}
        >
          {!t ? (
            <div className="empty">Noch kein Testplan. Er entsteht bei der Bewertung – erst wird die Nachfrage getestet, dann gebaut.</div>
          ) : (
            <>
              {t.guardrail_issues.length > 0 && <div className="alert warn small">Leitplanken überschritten: {t.guardrail_issues.join('; ')}</div>}
              {(t.started_at || t.ends_at) && (
                <div className="small" style={{ marginBottom: 8 }}>
                  {t.started_at && <>Gestartet {fmtDate(t.started_at)} · </>}
                  {t.ends_at && (
                    <>
                      geplantes Ende <strong>{fmtDate(t.ends_at)}</strong> ({fmtRelative(t.ends_at)})
                    </>
                  )}
                </div>
              )}
              <PlanView p={t.plan} />
              {testKit && (
                <div className="small" style={{ marginTop: 8 }}>
                  <button className="link" onClick={() => setKit(testKit.id)}>
                    Testpaket mit Checkliste öffnen
                  </button>
                </div>
              )}
              {t.result && (
                <div className="card" style={{ background: 'var(--panel-2)', marginTop: 10 }}>
                  <strong className="small">Ergebnis laut dir</strong> <span className="small muted">{fmtDateTime(t.result.recorded_at)}</span>
                  <div className="small">
                    <Markdown text={t.result.notes} />
                  </div>
                </div>
              )}
              {t.evaluation && (
                <div className="card" style={{ background: 'var(--panel-2)', marginTop: 10 }}>
                  <strong className="small">Auswertung: {TEST_VERDICT_LABELS[t.evaluation.verdict]}</strong>{' '}
                  <Badge kind={t.evaluation.success_criterion_met ? 'ok' : 'err'}>{t.evaluation.success_criterion_met ? 'Kriterium erfüllt' : 'Kriterium verfehlt'}</Badge>
                  <div className="small">
                    <Markdown text={t.evaluation.summary} />
                  </div>
                  {evaluation && (
                    <button className="link small" onClick={() => setKit(evaluation.id)}>
                      Auswertung öffnen
                    </button>
                  )}
                </div>
              )}
              {t.history.length > 0 && (
                <details style={{ marginTop: 10 }}>
                  <summary className="small">Frühere Versuche ({t.history.length})</summary>
                  {t.history.map((h) => (
                    <div key={h.attempt} className="small" style={{ marginTop: 6 }}>
                      <strong>Versuch {h.attempt}:</strong> {h.plan.channel} – {h.evaluation ? `${TEST_VERDICT_LABELS[h.evaluation.verdict]}: ${h.evaluation.summary}` : 'ohne Auswertung'}
                    </div>
                  ))}
                </details>
              )}
            </>
          )}
        </Card>
      </div>
      <div className="grid" style={{ alignContent: 'start' }}>
        <Card title="Einnahmen & Aufwand" actions={<button className="small" onClick={() => setAdd(true)}>+ Buchung</button>}>
          <div className="grid grid-2">
            <div>
              <div className="small muted">Gesamt</div>
              <FinanceTotalsView t={sumEntries(list)} />
            </div>
            <div>
              <div className="small muted">Letzte 30 Tage</div>
              <FinanceTotalsView t={sumEntries(list, since30)} />
            </div>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <Field label="Laufende Fixkosten (€/Monat)">
              <NumberInput value={fixed} onChange={setFixed} step={1} min={0} />
            </Field>
            <button className="small" disabled={busy || fixed === o.fixed_costs_eur_month} onClick={saveFixed} style={{ alignSelf: 'flex-end' }}>
              Speichern
            </button>
          </div>
          {d.usage && (
            <p className="small muted" style={{ marginBottom: 0 }}>
              KI-Kosten: {fmtUsd(d.usage.monetary_cost_usd)} real (Gegenwert {fmtUsd(d.usage.equivalent_cost_usd)})
            </p>
          )}
        </Card>
        <Card title={`Buchungen (${list.length})`}>{entries.data ? <FinanceEntryTable entries={list} /> : <Loading />}</Card>
      </div>
      {add && <FinanceEntryDialog opportunityId={o.id} onClose={() => setAdd(false)} />}
      {kit != null && <ArtifactViewer id={kit} onClose={() => setKit(null)} />}
    </div>
  );
}

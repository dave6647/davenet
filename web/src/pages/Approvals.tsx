import { useState } from 'react';
import { APPROVAL_TYPE_LABELS, type Approval, type GuardrailStatus } from '../../../shared/domain.ts';
import { api } from '../api.ts';
import { ApprovalStatusBadge, Badge, Card, Empty, ErrorBox, Field, Loading, Markdown, PageHead, Tabs, TextArea, useAction } from '../components/ui.tsx';
import { fmtDateTime, fmtRelative } from '../format.ts';
import { useApi } from '../live.ts';

export function Approvals() {
  const [tab, setTab] = useState<'open' | 'done'>('open');
  const pending = useApi<Approval[]>('/api/approvals?status=PENDING', ['approval']);
  const all = useApi<Approval[]>(tab === 'done' ? '/api/approvals?limit=300' : null, ['approval']);
  const guard = useApi<GuardrailStatus>('/api/guardrails', ['opportunity', 'approval', 'settings']);
  if (pending.error) return <ErrorBox error={pending.error} />;
  const starts = (pending.data ?? []).filter((a) => a.type === 'TEST_START' || a.type === 'PROJECT_START').length;
  const full = guard.data && guard.data.parallel.used >= guard.data.parallel.max;

  return (
    <>
      <PageHead
        title="Freigaben"
        subtitle="Autonomie endet an definierten Approval Gates: Nachfragetest, Projektstart, Beenden, Release und Provider-Wechsel entscheidest du."
      />
      {guard.data && starts > 0 && (
        <div className={`alert ${full ? 'warn' : 'info'}`}>
          {full
            ? `Alle Plätze für Tests/Projekte sind belegt (${guard.data.parallel.used}/${guard.data.parallel.max}: ${guard.data.parallel.ids.join(', ')}). Test- und Projektfreigaben gehen erst, wenn etwas endet – oder du die Grenze in den Einstellungen erhöhst.`
            : `Plätze für Tests/Projekte: ${guard.data.parallel.used} von ${guard.data.parallel.max} belegt.`}
        </div>
      )}
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'open', label: `Offen (${pending.data?.length ?? 0})` },
          { key: 'done', label: 'Entschieden' },
        ]}
      />
      {tab === 'open' &&
        (!pending.data ? (
          <Loading />
        ) : pending.data.length ? (
          pending.data.map((a) => <ApprovalCard key={a.id} a={a} />)
        ) : (
          <Card>
            <Empty>Keine offenen Freigaben – alles entschieden.</Empty>
          </Card>
        ))}
      {tab === 'done' && (
        <Card>
          {!all.data ? (
            <Loading />
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Art</th>
                    <th>Titel</th>
                    <th>Status</th>
                    <th>Notiz</th>
                    <th>Entschieden</th>
                  </tr>
                </thead>
                <tbody>
                  {all.data
                    .filter((a) => a.status !== 'PENDING')
                    .map((a) => (
                      <tr key={a.id}>
                        <td className="muted">{a.id}</td>
                        <td>{APPROVAL_TYPE_LABELS[a.type]}</td>
                        <td>
                          {a.title}
                          <div className="small">
                            {a.opportunity_id && <a href={`#/opportunities/${a.opportunity_id}`}>{a.opportunity_id}</a>}{' '}
                            {a.job_id && <a href={`#/jobs/${a.job_id}`}>Job #{a.job_id}</a>}
                          </div>
                        </td>
                        <td>
                          <ApprovalStatusBadge status={a.status} />
                        </td>
                        <td className="small">{a.decision_note ?? '–'}</td>
                        <td className="small muted nowrap">{fmtDateTime(a.decided_at)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </>
  );
}

function ApprovalCard({ a }: { a: Approval }) {
  const [note, setNote] = useState('');
  const { run, busy } = useAction();
  const decide = (decision: 'APPROVED' | 'REJECTED') =>
    run(() => api.post(`/api/approvals/${a.id}/decide`, { decision, note: note || null }), decision === 'APPROVED' ? 'Freigegeben' : 'Abgelehnt');
  const payload = a.payload as Record<string, unknown>;
  return (
    <Card
      title={
        <span className="row">
          <Badge kind="warn">{APPROVAL_TYPE_LABELS[a.type]}</Badge>
          <Badge>Level {a.level}</Badge>
          {a.title}
        </span>
      }
      actions={<span className="small muted">{fmtRelative(a.created_at)}</span>}
    >
      <div className="row small" style={{ marginBottom: 8 }}>
        {a.opportunity_id && (
          <a href={`#/opportunities/${a.opportunity_id}`}>
            Opportunity {a.opportunity_id} öffnen →
          </a>
        )}
        {a.job_id && <a href={`#/jobs/${a.job_id}`}>Job #{a.job_id} öffnen →</a>}
        {(a.type === 'PROJECT_START' || a.type === 'TEST_START') && payload.score != null && (
          <span className="muted">
            Score {String(payload.score)}
            {payload.market_score != null && ` · Markt ${String(payload.market_score)} · Technik ${String(payload.technical_score)} · Risiko ${String(payload.risk_score)}`}
          </span>
        )}
      </div>
      <div className="card" style={{ background: 'var(--panel-2)' }}>
        <Markdown text={a.summary || '–'} />
      </div>
      <div className="grid" style={{ marginTop: 12 }}>
        <Field
          label="Notiz / Vorgaben (optional)"
          help={
            a.type === 'PROJECT_START'
              ? 'Bei Freigabe gehen deine Vorgaben direkt an die technische Planung.'
              : a.type === 'TEST_START'
                ? 'Bei Freigabe gehen deine Vorgaben an die Testvorbereitung.'
                : undefined
          }
        >
          <TextArea value={note} onChange={setNote} rows={2} />
        </Field>
        <div className="btn-row">
          <button className="ok solid" disabled={busy} onClick={() => decide('APPROVED')}>
            ✓ Freigeben
          </button>
          <button className="danger solid" disabled={busy} onClick={() => decide('REJECTED')}>
            ✕ Ablehnen
          </button>
        </div>
      </div>
    </Card>
  );
}

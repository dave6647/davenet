import { useState } from 'react';
import { OPPORTUNITY_STATUSES, OPPORTUNITY_STATUS_LABELS, type Opportunity, type OpportunityStatus } from '../../../shared/domain.ts';
import { api } from '../api.ts';
import { Card, Check, ErrorBox, Field, Loading, Modal, OppStatusBadge, PageHead, TextArea, TextInput, useAction } from '../components/ui.tsx';
import { fmtRelative } from '../format.ts';
import { useApi } from '../live.ts';
import { navigate, setQuery, useRoute } from '../router.ts';
import { NewJobDialog } from './Jobs.tsx';

const BOARD: OpportunityStatus[] = ['DISCOVERED', 'SCREENING', 'RESEARCH', 'EVALUATION', 'PROPOSED', 'APPROVED', 'DEVELOPMENT', 'REVIEW', 'READY', 'DEPLOYED'];

export function scoreLabel(o: Opportunity): string {
  if (o.score == null) return '–';
  return `${o.score}`;
}

export function Opportunities() {
  const route = useRoute();
  const status = route.query.get('status');
  const view = route.query.get('view') ?? (status ? 'table' : 'board');
  const opps = useApi<Opportunity[]>('/api/opportunities', ['opportunity']);
  const [scan, setScan] = useState(false);
  if (opps.error) return <ErrorBox error={opps.error} />;
  if (!opps.data) return <Loading />;
  const list = status ? opps.data.filter((o) => o.status === status) : opps.data;
  const closed = opps.data.filter((o) => o.status === 'REJECTED' || o.status === 'ON_HOLD');

  return (
    <>
      <PageHead
        title="Opportunities"
        subtitle="Research- und Opportunity-Pipeline (Konzept §8): entdecken → prüfen → bewerten → Freigabe → Umsetzung → Release."
        actions={
          <>
            <button onClick={() => setScan(true)}>Research-Zyklus starten</button>
            <button className="primary" onClick={() => setQuery({ new: '1' })}>
              + Idee erfassen
            </button>
          </>
        }
      />
      <div className="row">
        <button className={`small ${view === 'board' ? 'primary' : ''}`} onClick={() => setQuery({ view: 'board', status: null })}>
          Board
        </button>
        <button className={`small ${view === 'table' ? 'primary' : ''}`} onClick={() => setQuery({ view: 'table' })}>
          Tabelle
        </button>
        {view === 'table' && (
          <>
            <span className="spacer" />
            <select value={status ?? ''} onChange={(e) => setQuery({ status: e.target.value || null })} style={{ width: 240 }}>
              <option value="">alle Status</option>
              {OPPORTUNITY_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {OPPORTUNITY_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </>
        )}
      </div>

      {view === 'board' ? (
        <>
          <div className="board">
            {BOARD.map((s) => {
              const col = opps.data!.filter((o) => o.status === s);
              return (
                <div className="board-col" key={s}>
                  <div className="board-col-head">
                    <span>{OPPORTUNITY_STATUS_LABELS[s]}</span>
                    <span>{col.length}</span>
                  </div>
                  {col.map((o) => (
                    <div key={o.id} className="opp-card" onClick={() => navigate(`/opportunities/${o.id}`)}>
                      <div className="small muted">{o.id}</div>
                      <strong>{o.title}</strong>
                      <div className="small muted">
                        Score {scoreLabel(o)} · {fmtRelative(o.updated_at)}
                      </div>
                      {o.status_reason && <div className="small muted">{o.status_reason.slice(0, 100)}</div>}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
          {closed.length > 0 && (
            <Card title={`Verworfen / zurückgestellt (${closed.length})`}>
              <OppTable list={closed} />
            </Card>
          )}
        </>
      ) : (
        <Card>
          <OppTable list={list} />
        </Card>
      )}
      {route.query.get('new') && <NewOpportunityDialog onClose={() => setQuery({ new: null })} />}
      {scan && <NewJobDialog initialType="opportunity_scan" onClose={() => setScan(false)} />}
    </>
  );
}

function OppTable({ list }: { list: Opportunity[] }) {
  if (!list.length) return <div className="empty">Keine Opportunities.</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Titel</th>
            <th>Status</th>
            <th className="num">Score</th>
            <th className="num">Markt</th>
            <th className="num">Technik</th>
            <th className="num">Risiko</th>
            <th>Aktualisiert</th>
          </tr>
        </thead>
        <tbody>
          {list.map((o) => (
            <tr key={o.id} className="clickable" onClick={() => navigate(`/opportunities/${o.id}`)}>
              <td className="nowrap muted">{o.id}</td>
              <td>
                {o.title}
                {o.status_reason && <div className="small muted">{o.status_reason.slice(0, 160)}</div>}
              </td>
              <td>
                <OppStatusBadge status={o.status} />
              </td>
              <td className="num">{scoreLabel(o)}</td>
              <td className="num">{o.market_score ?? '–'}</td>
              <td className="num">{o.technical_score ?? '–'}</td>
              <td className="num">{o.risk_score ?? '–'}</td>
              <td className="small muted nowrap">{fmtRelative(o.updated_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NewOpportunityDialog({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState({ title: '', problem: '', target_customer: '', proposed_solution: '', revenue_model: '', notes: '', screen: true });
  const { run, busy } = useAction();
  const save = () =>
    run(async () => {
      const o = await api.post<Opportunity>('/api/opportunities', f);
      onClose();
      navigate(`/opportunities/${o.id}`);
    }, 'Idee erfasst');
  return (
    <Modal
      title="Eigene Idee erfassen"
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
      <div className="form-grid">
        <Field label="Titel *" full>
          <TextInput value={f.title} onChange={(v) => setF({ ...f, title: v })} />
        </Field>
        <Field label="Problem" full>
          <TextArea value={f.problem} onChange={(v) => setF({ ...f, problem: v })} rows={3} />
        </Field>
        <Field label="Zielkunden">
          <TextInput value={f.target_customer} onChange={(v) => setF({ ...f, target_customer: v })} />
        </Field>
        <Field label="Umsatzmodell">
          <TextInput value={f.revenue_model} onChange={(v) => setF({ ...f, revenue_model: v })} />
        </Field>
        <Field label="Lösungsidee" full>
          <TextArea value={f.proposed_solution} onChange={(v) => setF({ ...f, proposed_solution: v })} rows={3} />
        </Field>
        <Field label="Notizen" full>
          <TextArea value={f.notes} onChange={(v) => setF({ ...f, notes: v })} rows={2} />
        </Field>
        <Field label="Weiteres Vorgehen" full>
          <Check checked={f.screen} onChange={(v) => setF({ ...f, screen: v })} label="Direkt ins Screening geben (danach automatisch Recherche & Bewertung, falls bestanden)" />
        </Field>
      </div>
    </Modal>
  );
}

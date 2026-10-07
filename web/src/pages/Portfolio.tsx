import { useState } from 'react';
import {
  PORTFOLIO_RECOMMENDATION_LABELS,
  TEST_STATUS_LABELS,
  type Artifact,
  type FinanceEntry,
  type FinanceTotals,
  type GuardrailStatus,
  type Job,
  type PortfolioItem,
  type PortfolioRecommendation,
} from '../../../shared/domain.ts';
import { api } from '../api.ts';
import { ArtifactViewer } from '../components/artifacts.tsx';
import { FinanceEntryDialog, FinanceEntryTable, fmtEur, fmtHours } from '../components/finance.tsx';
import { Badge, Bar, Card, ErrorBox, Loading, OppStatusBadge, PageHead, useAction } from '../components/ui.tsx';
import { fmtDate, fmtDateTime, fmtUsd } from '../format.ts';
import { useApi } from '../live.ts';
import { navigate } from '../router.ts';

interface PortfolioData {
  items: PortfolioItem[];
  guardrails: GuardrailStatus;
  month: FinanceTotals;
  total: FinanceTotals;
  last_review: Artifact | null;
}

const REC_KIND: Record<PortfolioRecommendation, 'ok' | 'warn' | 'err' | 'accent'> = { keep: 'ok', expand: 'accent', adjust: 'warn', stop: 'err' };

export function RecommendationBadge({ r }: { r: PortfolioRecommendation }) {
  return <Badge kind={REC_KIND[r]}>{PORTFOLIO_RECOMMENDATION_LABELS[r]}</Badge>;
}

export function Portfolio() {
  const data = useApi<PortfolioData>('/api/portfolio', ['finance', 'opportunity', 'settings', 'job', 'artifact']);
  const entries = useApi<FinanceEntry[]>('/api/finance/entries?limit=100', ['finance']);
  const [add, setAdd] = useState(false);
  const [review, setReview] = useState<number | null>(null);
  const { run, busy } = useAction();
  if (data.error) return <ErrorBox error={data.error} />;
  if (!data.data) return <Loading />;
  const { items, guardrails: g, month, last_review } = data.data;
  const active = items.filter((i) => i.status !== 'STOPPED');
  const stopped = items.filter((i) => i.status === 'STOPPED');
  const startReview = () =>
    run(async () => {
      const job = await api.post<Job>('/api/jobs', { type: 'portfolio_review', input: {} });
      navigate(`/jobs/${job.id}`);
    }, 'Portfolio-Review gestartet');

  return (
    <>
      <PageHead
        title="Portfolio & Erträge"
        subtitle="Tests und Produkte mit Einnahmen, Ausgaben und deiner Zeit – Grundlage für Abbruchregel und monatlichen Portfolio-Review."
        actions={
          <>
            <button onClick={() => setAdd(true)}>+ Buchung</button>
            <button className="primary" disabled={busy} onClick={startReview}>
              Portfolio-Review jetzt erstellen
            </button>
          </>
        }
      />

      <div className="grid grid-4">
        <div className="card stat">
          <span className="label">Einnahmen diesen Monat</span>
          <span className="value">{fmtEur(month.revenue_eur)}</span>
          <span className="hint">gesamt {fmtEur(data.data.total.revenue_eur)}</span>
        </div>
        <div className="card stat">
          <span className="label">Ausgaben diesen Monat</span>
          <span className="value">{fmtEur(month.expense_eur)}</span>
          <span className="hint">Saldo Monat {fmtEur(month.revenue_eur - month.expense_eur)}</span>
        </div>
        <div className="card stat">
          <span className="label">Tests & Projekte gleichzeitig</span>
          <span className="value">
            {g.parallel.used} / {g.parallel.max}
          </span>
          <Bar value={g.parallel.used} max={g.parallel.max} />
          <span className="hint">{g.parallel.ids.length ? g.parallel.ids.join(', ') : 'alle Plätze frei'}</span>
        </div>
        <div className="card stat">
          <span className="label">Deine Zeit diese Woche</span>
          <span className="value">
            {fmtHours(g.owner_hours_week.used)} <span className="muted small">von {g.owner_hours_week.max}</span>
          </span>
          <Bar value={g.owner_hours_week.used} max={g.owner_hours_week.max} />
          <span className="hint">seit {fmtDate(g.owner_hours_week.week_start)} · als „Owner-Zeit“ buchen</span>
        </div>
      </div>

      <Card title={`Tests und Produkte (${active.length})`} actions={<a href="#/settings">Leitplanken einstellen →</a>}>
        <PortfolioTable items={active} />
        <p className="small muted" style={{ marginBottom: 0 }}>
          Leitplanken: je Test höchstens {fmtEur(g.test_budget_eur)} und {fmtHours(g.test_owner_hours)}; Fixkosten je Produkt höchstens{' '}
          {fmtEur(g.fixed_costs_eur_month)}/Monat, solange nicht durch Erträge gedeckt. Abbruch, wenn Aufwand oder Kosten den Ertrag stark übersteigen –
          Davenet schlägt vor, du entscheidest.
        </p>
      </Card>

      <div className="grid grid-2">
        <Card title="Letzter Portfolio-Review" actions={<a href="#/triggers">Zeitplan →</a>}>
          {last_review ? (
            <>
              <button className="link" onClick={() => setReview(last_review.id)}>
                {last_review.title}
              </button>{' '}
              <span className="small muted">{fmtDateTime(last_review.created_at)}</span>
              {last_review.summary && <p className="small">{last_review.summary}</p>}
            </>
          ) : (
            <div className="muted small">Noch kein Review. Er läuft automatisch am 1. jedes Monats (Trigger) oder jetzt über den Button oben.</div>
          )}
        </Card>
        <Card title={`Beendet (${stopped.length})`}>
          {stopped.length ? <PortfolioTable items={stopped} compact /> : <div className="muted small">Keine beendeten Produkte mit Buchungen.</div>}
        </Card>
      </div>

      <Card title="Buchungen" actions={<button className="small" onClick={() => setAdd(true)}>+ Buchung</button>}>
        {entries.data ? <FinanceEntryTable entries={entries.data} showOpportunity /> : <Loading />}
      </Card>

      {add && <FinanceEntryDialog onClose={() => setAdd(false)} />}
      {review != null && <ArtifactViewer id={review} onClose={() => setReview(null)} />}
    </>
  );
}

function PortfolioTable({ items, compact }: { items: PortfolioItem[]; compact?: boolean }) {
  if (!items.length) return <div className="empty">Noch keine Tests oder Produkte. Sie entstehen, wenn du einen Nachfragetest freigibst.</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Produkt</th>
            <th>Status</th>
            <th className="num">Einnahmen</th>
            <th className="num">Ausgaben</th>
            <th className="num">Saldo</th>
            <th className="num">Deine Zeit</th>
            {!compact && <th className="num">Fixkosten</th>}
            {!compact && <th className="num">KI-Kosten</th>}
            {!compact && <th>Empfehlung</th>}
          </tr>
        </thead>
        <tbody>
          {items.map((i) => {
            const saldo = i.total.revenue_eur - i.total.expense_eur;
            return (
              <tr key={i.id} className="clickable" onClick={() => navigate(`/opportunities/${i.id}`)}>
                <td>
                  <span className="muted">{i.id}</span> {i.title}
                </td>
                <td>
                  <OppStatusBadge status={i.status} />
                  {i.test_status && i.status === 'TESTING' && (
                    <div className="small muted">
                      Test: {TEST_STATUS_LABELS[i.test_status]}
                      {i.test_status === 'RUNNING' && i.test_ends_at ? ` bis ${fmtDate(i.test_ends_at)}` : ''}
                    </div>
                  )}
                </td>
                <td className="num nowrap">
                  {fmtEur(i.total.revenue_eur)}
                  <div className="small muted">30 T.: {fmtEur(i.last30.revenue_eur)}</div>
                </td>
                <td className="num nowrap">{fmtEur(i.total.expense_eur)}</td>
                <td className="num nowrap" style={{ color: saldo < 0 ? 'var(--err)' : undefined }}>
                  {fmtEur(saldo)}
                </td>
                <td className="num nowrap">{fmtHours(i.total.hours)}</td>
                {!compact && <td className="num nowrap">{i.fixed_costs_eur_month != null ? `${fmtEur(i.fixed_costs_eur_month)}/M.` : '–'}</td>}
                {!compact && (
                  <td className="num nowrap" title={`Gegenwert ${fmtUsd(i.ai_equivalent_usd)}`}>
                    {fmtUsd(i.ai_cost_usd)}
                  </td>
                )}
                {!compact && (
                  <td>
                    {i.portfolio_note ? (
                      <>
                        <RecommendationBadge r={i.portfolio_note.recommendation} />
                        <div className="small muted">{i.portfolio_note.reason.slice(0, 120)}</div>
                      </>
                    ) : (
                      <span className="muted">–</span>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

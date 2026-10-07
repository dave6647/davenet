import { useState } from 'react';
import { FINANCE_KIND_LABELS, FINANCE_KINDS, type FinanceEntry, type FinanceKind, type FinanceTotals, type Opportunity } from '../../../shared/domain.ts';
import { api } from '../api.ts';
import { fmtDate } from '../format.ts';
import { useApi } from '../live.ts';
import { Badge, ConfirmButton, Field, Modal, NumberInput, Select, TextInput, useAction } from './ui.tsx';

/** Euro-Betrag im deutschen Format. */
export const fmtEur = (v: number | null | undefined): string =>
  v == null ? '–' : `${v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

export const fmtHours = (v: number | null | undefined): string => (v == null ? '–' : `${v.toLocaleString('de-DE', { maximumFractionDigits: 2 })} Std.`);

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const KIND_BADGE: Record<FinanceKind, 'ok' | 'err' | 'info'> = { revenue: 'ok', expense: 'err', time: 'info' };

/** Einnahme, Ausgabe oder Owner-Zeit erfassen (optional fest einer Opportunity zugeordnet). */
export function FinanceEntryDialog({ opportunityId, onClose }: { opportunityId?: string; onClose: () => void }) {
  const opps = useApi<Opportunity[]>(opportunityId ? null : '/api/opportunities', ['opportunity']);
  const [kind, setKind] = useState<FinanceKind>('revenue');
  const [amount, setAmount] = useState<number | null>(null);
  const [date, setDate] = useState(today());
  const [note, setNote] = useState('');
  const [opp, setOpp] = useState<string | null>(opportunityId ?? null);
  const { run, busy } = useAction();
  const valid = amount != null && amount > 0;
  const save = () =>
    run(async () => {
      await api.post('/api/finance/entries', {
        opportunity_id: opp,
        kind,
        amount_eur: kind === 'time' ? null : amount,
        hours: kind === 'time' ? amount : null,
        date,
        note: note || null,
      });
      onClose();
    }, 'Gebucht');
  return (
    <Modal
      title="Buchung erfassen"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Abbrechen</button>
          <button className="primary" disabled={busy || !valid} onClick={save}>
            Speichern
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Art">
          <Select<FinanceKind> value={kind} onChange={(v) => v && setKind(v)} options={FINANCE_KINDS.map((k) => ({ value: k, label: FINANCE_KIND_LABELS[k] }))} />
        </Field>
        <Field label={kind === 'time' ? 'Stunden' : 'Betrag (€)'} help={kind === 'time' ? 'deine eigene Arbeitszeit' : 'brutto, wie gezahlt bzw. erhalten'}>
          <NumberInput value={amount} onChange={setAmount} step={kind === 'time' ? 0.25 : 0.5} min={0} />
        </Field>
        <Field label="Datum">
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        {!opportunityId && (
          <Field label="Produkt / Opportunity">
            <Select
              value={opp}
              onChange={setOpp}
              allowEmpty="ohne Produktbezug"
              options={(opps.data ?? []).map((o) => ({ value: o.id, label: `${o.id} ${o.title}` }))}
            />
          </Field>
        )}
        <Field label="Notiz" full>
          <TextInput value={note} onChange={setNote} placeholder="z. B. Etsy-Verkauf, Domain, Listing angelegt" />
        </Field>
      </div>
    </Modal>
  );
}

export function FinanceEntryTable({ entries, showOpportunity }: { entries: FinanceEntry[]; showOpportunity?: boolean }) {
  const { run } = useAction();
  if (!entries.length) return <div className="empty">Noch keine Buchungen.</div>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Datum</th>
            <th>Art</th>
            <th className="num">Betrag / Zeit</th>
            {showOpportunity && <th>Produkt</th>}
            <th>Notiz</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id}>
              <td className="nowrap">{fmtDate(e.date)}</td>
              <td>
                <Badge kind={KIND_BADGE[e.kind]}>{FINANCE_KIND_LABELS[e.kind]}</Badge>
              </td>
              <td className="num nowrap">{e.kind === 'time' ? fmtHours(e.hours) : `${e.kind === 'expense' ? '−' : '+'}${fmtEur(e.amount_eur)}`}</td>
              {showOpportunity && <td className="nowrap">{e.opportunity_id ? <a href={`#/opportunities/${e.opportunity_id}`}>{e.opportunity_id}</a> : <span className="muted">–</span>}</td>}
              <td className="small">{e.note || <span className="muted">–</span>}</td>
              <td>
                <ConfirmButton className="small danger" confirm="Buchung löschen?" onConfirm={() => run(() => api.del(`/api/finance/entries/${e.id}`), 'Gelöscht')}>
                  ✕
                </ConfirmButton>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Kompakte Summen: Einnahmen, Ausgaben, Saldo, Owner-Zeit. */
export function FinanceTotalsView({ t }: { t: FinanceTotals }) {
  const saldo = t.revenue_eur - t.expense_eur;
  return (
    <dl className="kv">
      <dt>Einnahmen</dt>
      <dd>{fmtEur(t.revenue_eur)}</dd>
      <dt>Ausgaben</dt>
      <dd>{fmtEur(t.expense_eur)}</dd>
      <dt>Saldo</dt>
      <dd style={{ color: saldo < 0 ? 'var(--err)' : undefined, fontWeight: 600 }}>{fmtEur(saldo)}</dd>
      <dt>Owner-Zeit</dt>
      <dd>{fmtHours(t.hours)}</dd>
    </dl>
  );
}

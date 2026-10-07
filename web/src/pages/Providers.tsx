import { useState } from 'react';
import { BILLING_MODE_LABELS, CAPABILITIES, type Model, type PlanInfo, type ProviderView } from '../../../shared/domain.ts';
import { api } from '../api.ts';
import { Badge, Bar, Card, ErrorBox, Field, Loading, Modal, PageHead, Select, TextInput, useAction } from '../components/ui.tsx';
import { fmtDateTime, fmtRelative, fmtTokens, fmtUsd } from '../format.ts';
import { useApi } from '../live.ts';
import { useMeta } from '../meta.tsx';
import { navigate } from '../router.ts';

const WINDOW_LABELS: Record<string, string> = { five_hour: '5-Stunden-Fenster', seven_day: '7-Tage-Fenster', seven_day_opus: '7 Tage (Opus)', seven_day_sonnet: '7 Tage (Sonnet)' };

/** Plan-Auslastung, wie sie die Claude-CLI meldet (5h-/7-Tage-Fenster). */
export function PlanWindows({ info, compact }: { info: PlanInfo; compact?: boolean }) {
  const entries = Object.entries(info.windows ?? {});
  if (!entries.length) return null;
  return (
    <div className="small" style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 4 }}>
      {entries.map(([name, w]) => (
        <div key={name}>
          <div className="row">
            <span className="muted">{WINDOW_LABELS[name] ?? name}</span>
            <span className="spacer" />
            {w.utilization == null && <span>–</span>}
            {w.resets_at && <span className="muted">Reset {fmtRelative(w.resets_at)}</span>}
          </div>
          {w.utilization != null && <Bar value={w.utilization} max={1} />}
        </div>
      ))}
      {!compact && <span className="muted">Stand {fmtDateTime(info.updated_at)} (gemeldet von der Claude-CLI beim letzten Aufruf)</span>}
    </div>
  );
}

export function ProviderStatusBadge({ p }: { p: ProviderView }) {
  if (!p.enabled) return <Badge>inaktiv</Badge>;
  if (p.quota.exhausted) return <Badge kind="warn">erschöpft bis {fmtDateTime(p.quota.exhausted_until)}</Badge>;
  if (p.quota.cost_limit_reached) return <Badge kind="err">Kostenlimit erreicht</Badge>;
  if (p.health_status === 'error') return <Badge kind="err">Fehler</Badge>;
  if (p.health_status === 'ok') return <Badge kind="ok">bereit</Badge>;
  return <Badge kind="info">nicht geprüft</Badge>;
}

export function Providers() {
  const providers = useApi<ProviderView[]>('/api/providers', ['provider', 'ledger']);
  const models = useApi<Model[]>('/api/models', ['provider']);
  const [create, setCreate] = useState(false);
  const { run } = useAction();
  const meta = useMeta();
  if (providers.error) return <ErrorBox error={providers.error} />;
  if (!providers.data || !models.data) return <Loading />;
  const typeLabel = (t: string) => meta.provider_types.find((x) => x.type === t)?.label ?? t;
  // Die Capability-Matrix betrifft nur Sprachmodelle – Bild-Provider werden ohne Klasse über den Designer genutzt
  const enabled = (providers.data.filter((p) => p.enabled)).filter((p) => meta.provider_types.find((t) => t.type === p.type)?.kind !== 'image');

  const test = (id: string) =>
    run(async () => {
      const r = await api.post<{ ok: boolean; message: string }>(`/api/providers/${id}/test`);
      if (!r.ok) throw new Error(r.message);
      return r;
    }, 'Verbindung OK');

  return (
    <>
      <PageHead
        title="Provider & Modelle"
        subtitle="Provider sind austauschbare Ressourcen hinter dem Router. Abos/Pläne werden über Kontingente gesteuert, Pay-as-you-go über Kostenlimits."
        actions={
          <button className="primary" onClick={() => setCreate(true)}>
            + Provider
          </button>
        }
      />

      <Card title="Provider">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Priorität</th>
                <th>Provider</th>
                <th>Abrechnung</th>
                <th>Status</th>
                <th>Kontingent</th>
                <th className="num">Kosten Monat</th>
                <th className="num">Gegenwert</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {providers.data.map((p) => (
                <tr key={p.id} className="clickable" onClick={() => navigate(`/providers/${p.id}`)}>
                  <td className="num">{p.priority}</td>
                  <td>
                    <strong>{p.name}</strong>
                    <div className="small muted">
                      {meta.provider_types.find((x) => x.type === p.type)?.kind === 'image' && <Badge kind="accent">Bilder</Badge>} {typeLabel(p.type)} ·{' '}
                      <span className="mono">{p.id}</span>
                    </div>
                  </td>
                  <td>{BILLING_MODE_LABELS[p.billing_mode]}</td>
                  <td>
                    <ProviderStatusBadge p={p} />
                    {p.health_message && <div className="small muted wrap-anywhere">{p.health_message}</div>}
                  </td>
                  <td style={{ minWidth: 180 }}>
                    {p.quota.limit != null ? (
                      <>
                        <Bar value={p.quota.used} max={p.quota.limit} />
                        <span className="small muted">
                          {fmtTokens(p.quota.used)} / {fmtTokens(p.quota.limit)} {p.quota.unit} ({p.quota.period_key})
                        </span>
                      </>
                    ) : p.plan_info ? (
                      <PlanWindows info={p.plan_info} compact />
                    ) : (
                      <span className="small muted">kein festes Kontingent</span>
                    )}
                  </td>
                  <td className="num">
                    {fmtUsd(p.quota.month_cost_usd)}
                    {p.monthly_cost_limit_usd != null && <div className="small muted">Limit {fmtUsd(p.monthly_cost_limit_usd)}</div>}
                  </td>
                  <td className="num">{fmtUsd(p.quota.month_equivalent_usd)}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <button className="small" onClick={() => test(p.id)}>
                      Testen
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Capability-Matrix (Konzept §4)">
        <p className="small muted" style={{ marginTop: 0 }}>
          Welche Modelle stehen je Capability-Klasse bei den aktiven Providern bereit? Agents fordern nur eine Klasse an – das konkrete Modell wählt der Router.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Capability</th>
                {enabled.map((p) => (
                  <th key={p.id}>{p.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {CAPABILITIES.map((c) => (
                <tr key={c}>
                  <td>
                    <strong>{c}</strong>
                  </td>
                  {enabled.map((p) => {
                    const ms = models.data!.filter((m) => m.provider_id === p.id && m.tier === c && m.enabled);
                    return <td key={p.id}>{ms.length ? ms.map((m) => m.label).join(', ') : <span className="muted">–</span>}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {!enabled.length && <div className="alert error">Kein Provider aktiv – Agents können nicht arbeiten.</div>}
        </div>
      </Card>
      {create && <NewProviderDialog onClose={() => setCreate(false)} />}
    </>
  );
}

function NewProviderDialog({ onClose }: { onClose: () => void }) {
  const meta = useMeta();
  const [type, setType] = useState(meta.provider_types[0]?.type ?? '');
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const { run, busy } = useAction();
  const info = meta.provider_types.find((t) => t.type === type);
  const create = () =>
    run(async () => {
      const p = await api.post<{ id: string }>('/api/providers', { id, name, type, enabled: false, priority: 50 });
      navigate(`/providers/${p.id}`);
    }, 'Provider angelegt – bitte Modelle & Kontingent konfigurieren');
  return (
    <Modal
      title="Neuer Provider"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Abbrechen</button>
          <button className="primary" disabled={busy || !id || !name} onClick={create}>
            Anlegen
          </button>
        </>
      }
    >
      <Field label="Typ">
        <Select value={type} options={meta.provider_types.map((t) => ({ value: t.type, label: t.label }))} onChange={(v) => v && setType(v)} />
      </Field>
      {info && <div className="alert info small">{info.description}</div>}
      <div className="form-grid">
        <Field label="Kennung" help="z. B. claude_abo_2">
          <TextInput value={id} onChange={(v) => setId(v.toLowerCase().replace(/[^a-z0-9_-]/g, '_'))} />
        </Field>
        <Field label="Name">
          <TextInput value={name} onChange={setName} placeholder="z. B. Claude-Abo (Zweitkonto)" />
        </Field>
      </div>
      <p className="small muted">
        Weitere Anbieter (z. B. OpenAI/Codex, Gemini, OpenRouter, Ollama) werden als zusätzlicher Provider-Typ im Code ergänzt (server/providers) – Agents,
        Router und Ledger bleiben unverändert.
      </p>
    </Modal>
  );
}

import { useEffect, useState } from 'react';
import {
  BILLING_MODES,
  BILLING_MODE_LABELS,
  CAPABILITIES,
  EXHAUSTION_POLICIES,
  EXHAUSTION_POLICY_LABELS,
  QUOTA_PERIODS,
  QUOTA_PERIOD_LABELS,
  QUOTA_UNITS,
  QUOTA_UNIT_LABELS,
  type Model,
  type Provider,
  type ProviderTypeInfo,
  type ProviderView,
} from '../../../shared/domain.ts';
import { api } from '../api.ts';
import { Badge, Bar, Card, Check, ConfirmButton, ErrorBox, Field, Loading, Modal, NumberInput, PageHead, Select, TextArea, TextInput, useAction } from '../components/ui.tsx';
import { fmtDateTime, fmtNum, fmtTokens, fmtUsd } from '../format.ts';
import { useApi } from '../live.ts';
import { navigate } from '../router.ts';
import { PlanWindows, ProviderStatusBadge } from './Providers.tsx';

interface Detail {
  provider: ProviderView;
  models: Model[];
  type: ProviderTypeInfo | null;
}

const WEEKDAYS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];

export function ProviderPage({ id }: { id: string }) {
  const detail = useApi<Detail>(`/api/providers/${id}`, ['provider', 'ledger']);
  const [form, setForm] = useState<Partial<Provider> | null>(null);
  const [dirty, setDirty] = useState(false);
  const [secret, setSecret] = useState('');
  const [editModel, setEditModel] = useState<Partial<Model> | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const { run, busy } = useAction();

  useEffect(() => {
    if (detail.data && !dirty) setForm(detail.data.provider);
  }, [detail.data, dirty]);

  if (detail.error) return <ErrorBox error={detail.error} />;
  if (!detail.data || !form) return <Loading />;
  const { provider: p, models, type } = detail.data;
  const set = <K extends keyof Provider>(k: K, v: Provider[K]) => {
    setForm({ ...form, [k]: v });
    setDirty(true);
  };
  const setConfig = (k: string, v: unknown) => set('config', { ...(form.config ?? {}), [k]: v });

  const save = () =>
    run(async () => {
      const body = {
        name: form.name,
        enabled: form.enabled,
        priority: form.priority,
        billing_mode: form.billing_mode,
        config: form.config,
        quota_unit: form.quota_unit,
        quota_limit: form.quota_limit,
        quota_period: form.quota_period,
        quota_period_hours: form.quota_period_hours,
        quota_reset_day: form.quota_reset_day,
        quota_reset_hour: form.quota_reset_hour,
        policy_on_exhaustion: form.policy_on_exhaustion,
        monthly_cost_limit_usd: form.monthly_cost_limit_usd,
        max_concurrent: form.max_concurrent,
        notes: form.notes,
      };
      await api.put(`/api/providers/${id}`, body);
      setDirty(false);
      detail.reload();
    }, 'Provider gespeichert');

  const test = () =>
    run(async () => {
      const r = await api.post<{ ok: boolean; message: string }>(`/api/providers/${id}/test`);
      setTestResult(r);
      detail.reload();
    });
  const resetQuota = () =>
    run(async () => {
      await api.post(`/api/providers/${id}/reset-quota`);
      detail.reload();
    }, 'Kontingent zurückgesetzt – wartende Jobs werden fortgesetzt');
  const saveSecret = (value: string | null) =>
    run(async () => {
      await api.put(`/api/providers/${id}/secret`, { value });
      setSecret('');
      detail.reload();
    }, value ? 'API-Key gespeichert' : 'API-Key entfernt');
  const remove = () =>
    run(async () => {
      await api.del(`/api/providers/${id}`);
      navigate('/providers');
    }, 'Provider gelöscht');
  const deleteModel = (m: Model) =>
    run(async () => {
      await api.del(`/api/models/${encodeURIComponent(m.id)}`);
      detail.reload();
    }, 'Modell gelöscht');

  const q = p.quota;
  return (
    <>
      <PageHead
        title={p.name}
        subtitle={
          <>
            {type?.label ?? p.type} · <span className="mono">{p.id}</span> · <ProviderStatusBadge p={p} />
          </>
        }
        actions={
          <>
            <button onClick={() => navigate('/providers')}>← Provider</button>
            <button onClick={test} disabled={busy}>
              Verbindung testen
            </button>
            <ConfirmButton className="danger" confirm={`Provider ${p.name} löschen? Modelle werden mit gelöscht.`} onConfirm={remove}>
              Löschen
            </ConfirmButton>
            <button className="primary" disabled={!dirty || busy} onClick={save}>
              Speichern
            </button>
          </>
        }
      />
      {testResult && <div className={`alert ${testResult.ok ? 'ok' : 'error'}`}>{testResult.message}</div>}
      {p.health_status === 'error' && !testResult && <div className="alert error">{p.health_message}</div>}
      {dirty && <div className="alert warn">Ungespeicherte Änderungen</div>}

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(280px, 1fr)' }}>
        <div className="grid">
          <Card title="Allgemein">
            <div className="form-grid">
              <Field label="Name">
                <TextInput value={form.name} onChange={(v) => set('name', v)} />
              </Field>
              <Field label="Status">
                <Check checked={!!form.enabled} onChange={(v) => set('enabled', v)} label="Provider aktiv (für den Router verfügbar)" />
              </Field>
              <Field label="Priorität" help="kleiner = bevorzugt (wenn ein Agent keine eigene Reihenfolge hat)">
                <NumberInput value={form.priority} onChange={(v) => set('priority', v ?? 100)} />
              </Field>
              <Field label="Max. parallele Jobs">
                <NumberInput value={form.max_concurrent} onChange={(v) => set('max_concurrent', v ?? 1)} min={1} />
              </Field>
              <Field label="Abrechnung">
                <Select value={form.billing_mode} options={BILLING_MODES.map((b) => ({ value: b, label: BILLING_MODE_LABELS[b] }))} onChange={(v) => v && set('billing_mode', v)} />
              </Field>
              <Field label="Verhalten bei Erschöpfung">
                <Select value={form.policy_on_exhaustion} options={EXHAUSTION_POLICIES.map((b) => ({ value: b, label: EXHAUSTION_POLICY_LABELS[b] }))} onChange={(v) => v && set('policy_on_exhaustion', v)} />
              </Field>
              {type?.config_fields.map((f) => (
                <Field key={f.key} label={f.label} help={f.help}>
                  {f.type === 'number' ? (
                    <NumberInput value={form.config?.[f.key] == null ? null : Number(form.config[f.key])} onChange={(v) => setConfig(f.key, v)} />
                  ) : (
                    <TextInput value={String(form.config?.[f.key] ?? '')} onChange={(v) => setConfig(f.key, v)} />
                  )}
                </Field>
              ))}
              <Field label="Notizen" full>
                <TextArea value={form.notes} onChange={(v) => set('notes', v)} rows={3} />
              </Field>
            </div>
          </Card>

          <Card title="Kontingent & Kosten (Konzept §5)">
            <div className="form-grid-3">
              <Field label="Einheit">
                <Select value={form.quota_unit} options={QUOTA_UNITS.map((u) => ({ value: u, label: QUOTA_UNIT_LABELS[u] }))} onChange={(v) => v && set('quota_unit', v)} />
              </Field>
              <Field label="Kontingent pro Periode" help="leer = unbegrenzt">
                <NumberInput value={form.quota_limit} onChange={(v) => set('quota_limit', v)} />
              </Field>
              <Field label="Periode">
                <Select value={form.quota_period} options={QUOTA_PERIODS.map((u) => ({ value: u, label: QUOTA_PERIOD_LABELS[u] }))} onChange={(v) => v && set('quota_period', v)} />
              </Field>
              {form.quota_period === 'rolling' && (
                <Field label="Fensterlänge (Stunden)">
                  <NumberInput value={form.quota_period_hours} onChange={(v) => set('quota_period_hours', v ?? 5)} min={1} />
                </Field>
              )}
              {form.quota_period === 'monthly' && (
                <Field label="Reset am Tag">
                  <NumberInput value={form.quota_reset_day} onChange={(v) => set('quota_reset_day', v ?? 1)} min={1} />
                </Field>
              )}
              {form.quota_period === 'weekly' && (
                <Field label="Reset am Wochentag">
                  <Select value={form.quota_reset_day} options={WEEKDAYS.map((d, i) => ({ value: i + 1, label: d }))} onChange={(v) => set('quota_reset_day', v ?? 1)} />
                </Field>
              )}
              {['monthly', 'weekly', 'daily'].includes(form.quota_period ?? '') && (
                <Field label="Reset um (Stunde)">
                  <NumberInput value={form.quota_reset_hour} onChange={(v) => set('quota_reset_hour', v ?? 0)} min={0} />
                </Field>
              )}
              <Field label="Monatliches Kostenlimit (USD)" help="für Pay-as-you-go; leer = kein Limit">
                <NumberInput value={form.monthly_cost_limit_usd} onChange={(v) => set('monthly_cost_limit_usd', v)} step={1} />
              </Field>
            </div>
            <p className="small muted">
              Bei Abos ohne feste Zahl (z. B. Claude-Plan) bleibt die Einheit „kein festes Kontingent“: Davenet erkennt erreichte Limits an der Meldung des
              Providers und plant Jobs zum gemeldeten Reset neu ein.
            </p>
          </Card>

          <Card
            title="Modelle"
            actions={
              <button className="small" onClick={() => setEditModel({ provider_id: id, tier: 'MEDIUM', enabled: true, context_window: 200000, max_output_tokens: 32000, input_price_per_mtok: 0, output_price_per_mtok: 0 })}>
                + Modell
              </button>
            }
          >
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Klasse</th>
                    <th>Modell</th>
                    <th className="num">Kontext</th>
                    <th className="num">Max. Output</th>
                    <th className="num">$/Mio. In/Out</th>
                    <th>Effort</th>
                    <th>Aktiv</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {models.map((m) => (
                    <tr key={m.id}>
                      <td>
                        <Badge kind={m.tier === 'HIGH' ? 'accent' : 'info'}>{m.tier}</Badge>
                      </td>
                      <td>
                        {m.label}
                        <div className="mono muted">{m.model_name}</div>
                      </td>
                      <td className="num">{fmtTokens(m.context_window)}</td>
                      <td className="num">{fmtTokens(m.max_output_tokens)}</td>
                      <td className="num">
                        {m.input_price_per_mtok} / {m.output_price_per_mtok}
                      </td>
                      <td>{m.supports_effort ? 'ja' : '–'}</td>
                      <td>{m.enabled ? '✓' : '–'}</td>
                      <td className="nowrap">
                        <button className="small" onClick={() => setEditModel(m)}>
                          Bearbeiten
                        </button>{' '}
                        <ConfirmButton className="small danger" confirm={`Modell ${m.label} löschen?`} onConfirm={() => deleteModel(m)}>
                          ✕
                        </ConfirmButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!models.length && <div className="empty">Keine Modelle – ohne Modelle kann der Router diesen Provider nicht nutzen.</div>}
            </div>
          </Card>
        </div>

        <div className="grid" style={{ alignContent: 'start' }}>
          <Card title="Aktueller Stand">
            <dl className="kv">
              <dt>Periode</dt>
              <dd>{q.period_key}</dd>
              <dt>Genutzt</dt>
              <dd>
                {q.unit === 'none'
                  ? 'kein festes Kontingent konfiguriert'
                  : `${q.unit === 'cost_usd' ? fmtUsd(q.used) : fmtNum(q.used)} ${q.limit != null ? `von ${q.unit === 'cost_usd' ? fmtUsd(q.limit) : fmtNum(q.limit)}` : '(unbegrenzt)'}`}
              </dd>
              {q.next_reset && (
                <>
                  <dt>Nächster Reset</dt>
                  <dd>{fmtDateTime(q.next_reset)}</dd>
                </>
              )}
              <dt>Kosten Monat</dt>
              <dd>
                {fmtUsd(q.month_cost_usd)} <span className="muted">(Gegenwert {fmtUsd(q.month_equivalent_usd)})</span>
              </dd>
              <dt>Laufende Jobs</dt>
              <dd>{q.running_jobs}</dd>
            </dl>
            {q.limit != null && (
              <div style={{ marginTop: 8 }}>
                <Bar value={q.used} max={q.limit} />
              </div>
            )}
            {q.exhausted && (
              <div className="alert warn small" style={{ marginTop: 8 }}>
                {q.reason} – bis {fmtDateTime(q.exhausted_until)}
              </div>
            )}
            {p.plan_info && <PlanWindows info={p.plan_info} />}
            <div className="btn-row" style={{ marginTop: 10 }}>
              <ConfirmButton
                confirm="Kontingent jetzt als zurückgesetzt markieren? Wartende Jobs dieses Providers werden sofort wieder eingeplant."
                onConfirm={resetQuota}
              >
                Kontingent zurücksetzen
              </ConfirmButton>
            </div>
          </Card>
          {type?.needs_secret && (
            <Card title={type.secret_label ?? 'Zugangsdaten'}>
              <p className="small" style={{ marginTop: 0 }}>
                {p.secret.has_secret ? (
                  <>
                    Hinterlegt ({p.secret.source === 'env' ? 'aus Umgebungsvariable' : 'gespeichert'}) <span className="mono">{p.secret.hint}</span>
                  </>
                ) : (
                  <span style={{ color: 'var(--err)' }}>Kein Key hinterlegt</span>
                )}
              </p>
              <Field label="Neuer Wert" help="Wird lokal in data/secrets.json gespeichert und nie an die Oberfläche zurückgegeben.">
                <TextInput type="password" value={secret} onChange={setSecret} placeholder="sk-ant-…" />
              </Field>
              <div className="btn-row" style={{ marginTop: 8 }}>
                <button className="primary" disabled={!secret || busy} onClick={() => saveSecret(secret)}>
                  Speichern
                </button>
                {p.secret.source === 'stored' && (
                  <ConfirmButton className="danger" confirm="Gespeicherten Key entfernen?" onConfirm={() => saveSecret(null)}>
                    Entfernen
                  </ConfirmButton>
                )}
              </div>
            </Card>
          )}
          {p.type === 'claude_cli' && (
            <Card title="Hinweise Claude-Abo">
              <ul className="small" style={{ paddingLeft: 18, margin: 0 }}>
                <li>
                  Die Claude Code CLI muss installiert und einmal angemeldet sein (<span className="mono">claude</span> im Terminal starten, <span className="mono">/login</span>).
                </li>
                <li>Agents laufen mit strikt begrenzten Werkzeugen (keine Shell, keine MCP-Server, Dateien nur im Projekt-Workspace).</li>
                <li>Für ein zweites Abo-Konto einen weiteren Provider dieses Typs mit eigenem Konfigurationsverzeichnis anlegen.</li>
                <li>Ein gesetzter ANTHROPIC_API_KEY wird für diesen Provider ignoriert, damit nicht versehentlich API-Kosten entstehen.</li>
              </ul>
            </Card>
          )}
        </div>
      </div>
      {editModel && (
        <ModelDialog
          model={editModel}
          onClose={() => setEditModel(null)}
          onSaved={() => {
            setEditModel(null);
            detail.reload();
          }}
        />
      )}
    </>
  );
}

function ModelDialog({ model, onClose, onSaved }: { model: Partial<Model>; onClose: () => void; onSaved: () => void }) {
  const isNew = !model.id;
  const [m, setM] = useState<Partial<Model>>(model);
  const { run, busy } = useAction();
  const set = <K extends keyof Model>(k: K, v: Model[K]) => setM({ ...m, [k]: v });
  const save = () =>
    run(async () => {
      const body = {
        model_name: m.model_name,
        label: m.label || m.model_name,
        tier: m.tier,
        context_window: m.context_window,
        max_output_tokens: m.max_output_tokens,
        input_price_per_mtok: m.input_price_per_mtok,
        output_price_per_mtok: m.output_price_per_mtok,
        supports_effort: !!m.supports_effort,
        enabled: m.enabled !== false,
        sort_order: m.sort_order ?? 0,
      };
      if (isNew) await api.post('/api/models', { provider_id: m.provider_id, ...body });
      else await api.put(`/api/models/${encodeURIComponent(m.id!)}`, body);
      onSaved();
    }, 'Modell gespeichert');
  return (
    <Modal
      title={isNew ? 'Neues Modell' : `Modell ${m.label}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Abbrechen</button>
          <button className="primary" disabled={busy || !m.model_name} onClick={save}>
            Speichern
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Modellname beim Provider" help="z. B. claude-sonnet-5-5">
          <TextInput value={m.model_name} disabled={!isNew} onChange={(v) => set('model_name', v)} />
        </Field>
        <Field label="Anzeigename">
          <TextInput value={m.label} onChange={(v) => set('label', v)} />
        </Field>
        <Field label="Capability-Klasse">
          <Select value={m.tier} options={CAPABILITIES.map((c) => ({ value: c, label: c }))} onChange={(v) => v && set('tier', v)} />
        </Field>
        <Field label="Status">
          <Check checked={m.enabled !== false} onChange={(v) => set('enabled', v)} label="aktiv" />
        </Field>
        <Field label="Kontextfenster (Tokens)">
          <NumberInput value={m.context_window} onChange={(v) => set('context_window', v ?? 200000)} step={1000} />
        </Field>
        <Field label="Max. Output-Tokens">
          <NumberInput value={m.max_output_tokens} onChange={(v) => set('max_output_tokens', v ?? 32000)} step={1000} />
        </Field>
        <Field label="Preis Input ($ / Mio. Tokens)" help="für Kosten bzw. Gegenwert">
          <NumberInput value={m.input_price_per_mtok} onChange={(v) => set('input_price_per_mtok', v ?? 0)} step={0.1} />
        </Field>
        <Field label="Preis Output ($ / Mio. Tokens)">
          <NumberInput value={m.output_price_per_mtok} onChange={(v) => set('output_price_per_mtok', v ?? 0)} step={0.1} />
        </Field>
        <Field label="Effort" full>
          <Check checked={!!m.supports_effort} onChange={(v) => set('supports_effort', v)} label="Modell unterstützt den Effort-Parameter" />
        </Field>
      </div>
    </Modal>
  );
}

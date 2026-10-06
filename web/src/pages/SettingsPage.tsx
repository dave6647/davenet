import { useEffect, useState } from 'react';
import type { Settings } from '../../../shared/domain.ts';
import { api } from '../api.ts';
import { Card, Check, ErrorBox, Field, Loading, NumberInput, PageHead, TextInput, useAction } from '../components/ui.tsx';
import { useApi } from '../live.ts';
import { useMeta } from '../meta.tsx';

export function SettingsPage() {
  const { data, error, reload } = useApi<Settings>('/api/settings', ['settings']);
  const meta = useMeta();
  const [s, setS] = useState<Settings | null>(null);
  const { run, busy } = useAction();
  useEffect(() => {
    if (data) setS(data);
  }, [data]);
  if (error) return <ErrorBox error={error} />;
  if (!s || !data) return <Loading />;
  const dirty = JSON.stringify(s) !== JSON.stringify(data);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS({ ...s, [k]: v });
  const save = () =>
    run(async () => {
      await api.put('/api/settings', s);
      reload();
    }, 'Einstellungen gespeichert');

  return (
    <>
      <PageHead
        title="Einstellungen"
        actions={
          <>
            <button disabled={!dirty} onClick={() => setS(data)}>
              Verwerfen
            </button>
            <button className="primary" disabled={!dirty || busy} onClick={save}>
              Speichern
            </button>
          </>
        }
      />
      {dirty && <div className="alert warn">Ungespeicherte Änderungen</div>}
      <div className="grid grid-2">
        <Card title="Allgemein">
          <div className="form-grid">
            <Field label="Unternehmensname">
              <TextInput value={s.company_name} onChange={(v) => set('company_name', v)} />
            </Field>
            <Field label="Sprache der Ergebnisse">
              <TextInput value={s.output_language} onChange={(v) => set('output_language', v)} />
            </Field>
          </div>
        </Card>
        <Card title="Engine">
          <div className="form-grid">
            <Field label="Max. parallele Jobs (gesamt)">
              <NumberInput value={s.max_concurrent_jobs} onChange={(v) => set('max_concurrent_jobs', v ?? 1)} min={1} />
            </Field>
            <Field label="Max. Versuche pro Job" help="bei vorübergehenden Fehlern (Überlastung, Netzwerk)">
              <NumberInput value={s.job_max_attempts} onChange={(v) => set('job_max_attempts', v ?? 3)} min={1} />
            </Field>
            <Field label="Status" full>
              <Check checked={s.engine_paused} onChange={(v) => set('engine_paused', v)} label="Engine pausiert (keine neuen Jobs starten)" />
            </Field>
          </div>
        </Card>
        <Card title="Budget (gesamtes System)">
          <div className="form-grid">
            <Field label="Monatsbudget (USD)" help="echte Ausgaben über Pay-as-you-go-Provider; leer = kein Limit">
              <NumberInput value={s.system_monthly_budget_usd} onChange={(v) => set('system_monthly_budget_usd', v)} step={5} />
            </Field>
            <Field label="Warnschwelle (%)" help="ab hier laufen auf kostenpflichtigen Providern nur noch Jobs mit hoher Priorität">
              <NumberInput value={s.budget_warning_pct} onChange={(v) => set('budget_warning_pct', v ?? 80)} />
            </Field>
          </div>
        </Card>
        <Card title="Pipeline">
          <div className="form-grid">
            <Field label="Screening">
              <Check checked={s.auto_screening} onChange={(v) => set('auto_screening', v)} label="neue Kandidaten automatisch screenen" />
            </Field>
            <Field label="Umsetzung">
              <Check checked={s.auto_start_development} onChange={(v) => set('auto_start_development', v)} label="nach der Planung automatisch starten" />
            </Field>
            <Field label="Schwelle Deep Research (Score 0–100)">
              <NumberInput value={s.deep_research_threshold} onChange={(v) => set('deep_research_threshold', v ?? 60)} />
            </Field>
            <Field label="Schwelle Vorschlag an Owner (Score)">
              <NumberInput value={s.proposal_threshold} onChange={(v) => set('proposal_threshold', v ?? 65)} />
            </Field>
            <Field label="Kandidaten pro Scan (Standard)">
              <NumberInput value={s.scan_default_count} onChange={(v) => set('scan_default_count', v ?? 5)} min={1} />
            </Field>
            <Field label="Max. Tasks pro Projekt">
              <NumberInput value={s.max_tasks_per_project} onChange={(v) => set('max_tasks_per_project', v ?? 8)} min={1} />
            </Field>
            <Field label="Max. Nacharbeitsrunden pro Task">
              <NumberInput value={s.max_rework_rounds} onChange={(v) => set('max_rework_rounds', v ?? 2)} min={0} />
            </Field>
          </div>
        </Card>
        <Card title="Scoring-Gewichte">
          <p className="small muted" style={{ marginTop: 0 }}>
            Gesamt-Score = gewichteter Mittelwert aus Markt, Technik und (10 − Risiko), skaliert auf 0–100.
          </p>
          <div className="form-grid-3">
            <Field label="Markt">
              <NumberInput value={s.score_weight_market} onChange={(v) => set('score_weight_market', v ?? 0)} step={0.05} />
            </Field>
            <Field label="Technik">
              <NumberInput value={s.score_weight_technical} onChange={(v) => set('score_weight_technical', v ?? 0)} step={0.05} />
            </Field>
            <Field label="Risiko">
              <NumberInput value={s.score_weight_risk} onChange={(v) => set('score_weight_risk', v ?? 0)} step={0.05} />
            </Field>
          </div>
        </Card>
        <Card title="Kontext-Strategie (Konzept §11)">
          <Field label="Max. Zeichen pro eingebettetem Artefakt" help="Reports werden beim Einbetten in Folge-Prompts auf diese Größe gekürzt.">
            <NumberInput value={s.artifact_context_chars} onChange={(v) => set('artifact_context_chars', v ?? 6000)} step={500} />
          </Field>
        </Card>
        <Card title="System">
          <dl className="kv">
            <dt>Version</dt>
            <dd>{meta.version}</dd>
            <dt>Datenverzeichnis</dt>
            <dd className="mono">{meta.data_dir}</dd>
          </dl>
          <p className="small muted">Datenbank, Unternehmensgedächtnis, Workspaces und Secrets liegen in diesem Verzeichnis. Für ein Backup einfach den Ordner sichern.</p>
        </Card>
      </div>
    </>
  );
}

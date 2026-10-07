import { useEffect, useState } from 'react';
import { CRITERIA, KO_SCORE_CAP, type CriterionKey, type Settings } from '../../../shared/domain.ts';
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
            <Field label="Sprache der Berichte" help="Produktinhalte wie Listings und Webseiten schreiben die Agents in der Sprache des Zielmarkts">
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
        <Card title="Leitplanken (Strategie)">
          <div className="form-grid">
            <Field label="Testbudget je Test (€)" help="externe Kosten; KI-Nutzung im Davenet-Budget zählt nicht">
              <NumberInput value={s.guard_test_budget_eur} onChange={(v) => set('guard_test_budget_eur', v ?? 0)} step={1} min={0} />
            </Field>
            <Field label="Deine Zeit je Test (Std.)">
              <NumberInput value={s.guard_test_owner_hours} onChange={(v) => set('guard_test_owner_hours', v ?? 0)} step={0.5} min={0} />
            </Field>
            <Field label="Fixkosten je Produkt (€/Monat)" help="solange das Produkt sie nicht selbst einspielt">
              <NumberInput value={s.guard_fixed_costs_eur_month} onChange={(v) => set('guard_fixed_costs_eur_month', v ?? 0)} step={1} min={0} />
            </Field>
            <Field label="Tests/Projekte gleichzeitig (max.)" help="Freigaben darüber hinaus warten auf einen freien Platz">
              <NumberInput value={s.guard_max_parallel} onChange={(v) => set('guard_max_parallel', v ?? 1)} min={1} />
            </Field>
            <Field label="Deine Zeit insgesamt (Std./Woche)" help="aus den Buchungen „Owner-Zeit“">
              <NumberInput value={s.guard_owner_hours_week} onChange={(v) => set('guard_owner_hours_week', v ?? 0)} step={1} min={0} />
            </Field>
            <Field label="Vor dem Bau">
              <Check checked={s.require_demand_test} onChange={(v) => set('require_demand_test', v)} label="zuerst einen Nachfragetest vorschlagen" />
            </Field>
          </div>
        </Card>
        <Card title="Bewertung (13 Kriterien)">
          <p className="small muted" style={{ marginTop: 0 }}>
            Gesamt-Score 0–100 = gewichtetes geometrisches Mittel der Kriterien (multiplikativ: ein sehr schwacher Wert zieht stark nach unten). K.-o.
            (Nachfrage unter der Schwelle, Rechtsprüfung rot, Test außerhalb der Leitplanken) deckelt den Score auf {KO_SCORE_CAP}.
          </p>
          <div className="form-grid-3">
            {CRITERIA.map((c) => (
              <Field key={c.key} label={c.label}>
                <NumberInput
                  value={s.criteria_weights[c.key as CriterionKey]}
                  onChange={(v) => set('criteria_weights', { ...s.criteria_weights, [c.key]: v ?? 0 })}
                  step={0.5}
                  min={0}
                />
              </Field>
            ))}
            <Field label="K.-o., wenn Nachfrage unter">
              <NumberInput value={s.ko_min_demand} onChange={(v) => set('ko_min_demand', v ?? 0)} step={0.5} min={0} />
            </Field>
          </div>
        </Card>
        <Card title="Kontext-Strategie (Konzept §11)">
          <div className="form-grid">
            <Field
              label="Max. Zeichen der Unternehmensstrategie"
              help={
                <>
                  Agents erhalten die Kurzfassung (<span className="mono">strategy/kurzfassung.md</span>), sonst die Langfassung – gekürzt auf diese Länge. Rund 3,5 Zeichen
                  entsprechen einem Token.
                </>
              }
            >
              <NumberInput value={s.strategy_context_chars} onChange={(v) => set('strategy_context_chars', v ?? 8000)} step={500} min={1000} />
            </Field>
            <Field label="Max. Zeichen pro eingebettetem Artefakt" help="Reports werden beim Einbetten in Folge-Prompts auf diese Größe gekürzt.">
              <NumberInput value={s.artifact_context_chars} onChange={(v) => set('artifact_context_chars', v ?? 6000)} step={500} />
            </Field>
          </div>
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

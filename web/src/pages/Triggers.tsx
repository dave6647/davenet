import { useEffect, useState } from 'react';
import { PRIORITIES, SCHEDULE_KINDS, type Agent, type Schedule, type ScheduleKind, type Settings } from '../../../shared/domain.ts';
import { api } from '../api.ts';
import { Card, Check, ConfirmButton, ErrorBox, Field, Loading, Modal, NumberInput, PageHead, Select, TextArea, TextInput, useAction } from '../components/ui.tsx';
import { fmtDateTime, fmtRelative } from '../format.ts';
import { useApi } from '../live.ts';
import { useJobTypeLabel, useMeta } from '../meta.tsx';

type ScheduleRow = Schedule & { description: string };
const KIND_LABELS: Record<ScheduleKind, string> = { interval: 'Intervall', daily: 'täglich', weekly: 'wöchentlich', monthly: 'monatlich' };
const WEEKDAYS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];

export function Triggers() {
  const schedules = useApi<ScheduleRow[]>('/api/schedules', ['schedule']);
  const settings = useApi<Settings>('/api/settings', ['settings']);
  const label = useJobTypeLabel();
  const [edit, setEdit] = useState<Partial<Schedule> | null>(null);
  const { run } = useAction();
  if (schedules.error) return <ErrorBox error={schedules.error} />;
  if (!schedules.data || !settings.data) return <Loading />;

  const toggle = (s: Schedule, enabled: boolean) => run(() => api.put(`/api/schedules/${s.id}`, { enabled }), enabled ? 'Trigger aktiviert' : 'Trigger deaktiviert');
  const runNow = (s: Schedule) => run(() => api.post(`/api/schedules/${s.id}/run`), 'Job angelegt');
  const remove = (s: Schedule) => run(() => api.del(`/api/schedules/${s.id}`), 'Trigger gelöscht');

  return (
    <>
      <PageHead
        title="Trigger"
        subtitle="Jobs entstehen zeitgesteuert oder ereignisgesteuert (Konzept §15) – Agents müssen dafür nicht dauerhaft laufen."
        actions={
          <button className="primary" onClick={() => setEdit({ kind: 'weekly', time_of_day: '08:00', weekday: 1, priority: 1, enabled: true, input: {} })}>
            + Zeit-Trigger
          </button>
        }
      />
      <Card title="Zeit-Trigger">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Aktiv</th>
                <th>Name</th>
                <th>Job</th>
                <th>Zeitplan</th>
                <th>Letzter Lauf</th>
                <th>Nächster Lauf</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {schedules.data.map((s) => (
                <tr key={s.id}>
                  <td>
                    <Check checked={s.enabled} onChange={(v) => toggle(s, v)} label="" />
                  </td>
                  <td>{s.name}</td>
                  <td>
                    {label(s.job_type)}
                    {s.agent_id && <div className="small muted">Agent {s.agent_id}</div>}
                  </td>
                  <td>{s.description}</td>
                  <td className="small muted">{s.last_run_at ? fmtDateTime(s.last_run_at) : '–'}</td>
                  <td className="small">{s.enabled && s.next_run_at ? `${fmtDateTime(s.next_run_at)} (${fmtRelative(s.next_run_at)})` : '–'}</td>
                  <td className="nowrap">
                    <button className="small" onClick={() => runNow(s)}>
                      Jetzt ausführen
                    </button>{' '}
                    <button className="small" onClick={() => setEdit(s)}>
                      Bearbeiten
                    </button>{' '}
                    <ConfirmButton className="small danger" confirm={`Trigger "${s.name}" löschen?`} onConfirm={() => remove(s)}>
                      ✕
                    </ConfirmButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!schedules.data.length && <div className="empty">Keine Zeit-Trigger.</div>}
        </div>
        <p className="small muted">Zeit-Trigger sind standardmäßig aus, damit erst Kosten anfallen, wenn du sie bewusst aktivierst.</p>
      </Card>
      <EventTriggers settings={settings.data} reload={settings.reload} />
      {edit && (
        <ScheduleDialog
          schedule={edit}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            schedules.reload();
          }}
        />
      )}
    </>
  );
}

function EventTriggers({ settings, reload }: { settings: Settings; reload: () => void }) {
  const [s, setS] = useState(settings);
  const { run, busy } = useAction();
  useEffect(() => setS(settings), [settings]);
  const dirty = JSON.stringify(s) !== JSON.stringify(settings);
  const save = () =>
    run(async () => {
      await api.put('/api/settings', {
        auto_screening: s.auto_screening,
        deep_research_threshold: s.deep_research_threshold,
        proposal_threshold: s.proposal_threshold,
        auto_start_development: s.auto_start_development,
        budget_warning_pct: s.budget_warning_pct,
        max_rework_rounds: s.max_rework_rounds,
      });
      reload();
    }, 'Ereignis-Trigger gespeichert');
  return (
    <Card
      title="Ereignis-Trigger"
      actions={
        <button className="primary small" disabled={!dirty || busy} onClick={save}>
          Speichern
        </button>
      }
    >
      <table>
        <thead>
          <tr>
            <th>Ereignis</th>
            <th>Aktion</th>
            <th>Einstellung</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Neue Opportunities entdeckt</td>
            <td>Screening (Vorfilter)</td>
            <td>
              <Check checked={s.auto_screening} onChange={(v) => setS({ ...s, auto_screening: v })} label="automatisch" />
            </td>
          </tr>
          <tr>
            <td>Opportunity-Score ≥ Schwelle (Screening)</td>
            <td>Deep Research</td>
            <td style={{ width: 160 }}>
              <NumberInput value={s.deep_research_threshold} onChange={(v) => setS({ ...s, deep_research_threshold: v ?? 60 })} />
            </td>
          </tr>
          <tr>
            <td>Bewertung GO und Score ≥ Schwelle</td>
            <td>Owner-Freigabe Projektstart anfordern</td>
            <td>
              <NumberInput value={s.proposal_threshold} onChange={(v) => setS({ ...s, proposal_threshold: v ?? 65 })} />
            </td>
          </tr>
          <tr>
            <td>Owner hat Projekt freigegeben</td>
            <td>Technische Planung, danach Umsetzung der Tasks</td>
            <td>
              <Check checked={s.auto_start_development} onChange={(v) => setS({ ...s, auto_start_development: v })} label="Umsetzung automatisch starten" />
            </td>
          </tr>
          <tr>
            <td>Review verlangt REWORK</td>
            <td>Nacharbeit, danach Eskalation an den Owner</td>
            <td>
              <NumberInput value={s.max_rework_rounds} onChange={(v) => setS({ ...s, max_rework_rounds: v ?? 2 })} />
              <span className="small muted">max. Runden</span>
            </td>
          </tr>
          <tr>
            <td>Provider-Kontingent zurückgesetzt</td>
            <td>Wartende Jobs fortsetzen</td>
            <td className="muted small">immer aktiv</td>
          </tr>
          <tr>
            <td>Budget-Schwelle erreicht (% des Systembudgets)</td>
            <td>Nicht-kritische Jobs auf kostenpflichtigen Providern stoppen</td>
            <td>
              <NumberInput value={s.budget_warning_pct} onChange={(v) => setS({ ...s, budget_warning_pct: v ?? 80 })} />
            </td>
          </tr>
        </tbody>
      </table>
    </Card>
  );
}

function ScheduleDialog({ schedule, onClose, onSaved }: { schedule: Partial<Schedule>; onClose: () => void; onSaved: () => void }) {
  const meta = useMeta();
  const agents = useApi<Agent[]>('/api/agents', ['agent']);
  const [s, setS] = useState<Partial<Schedule>>(schedule);
  const { run, busy } = useAction();
  const types = meta.job_types.filter((t) => t.manual && !t.requires_opportunity && !t.requires_task);
  const def = types.find((t) => t.key === s.job_type);
  const isNew = !schedule.id;
  const save = () =>
    run(async () => {
      const body = {
        name: s.name,
        job_type: s.job_type,
        agent_id: s.agent_id ?? null,
        input: s.input ?? {},
        priority: s.priority ?? 1,
        kind: s.kind,
        interval_minutes: s.kind === 'interval' ? (s.interval_minutes ?? 60) : null,
        time_of_day: s.time_of_day ?? '08:00',
        weekday: s.weekday ?? 1,
        day_of_month: s.day_of_month ?? 1,
        enabled: s.enabled ?? false,
      };
      if (isNew) await api.post('/api/schedules', body);
      else await api.put(`/api/schedules/${schedule.id}`, body);
      onSaved();
    }, 'Trigger gespeichert');
  return (
    <Modal
      title={isNew ? 'Neuer Zeit-Trigger' : `Trigger ${schedule.name}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Abbrechen</button>
          <button className="primary" disabled={busy || !s.name || !s.job_type} onClick={save}>
            Speichern
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Name" full>
          <TextInput value={s.name} onChange={(v) => setS({ ...s, name: v })} />
        </Field>
        <Field label="Job-Typ">
          <Select value={s.job_type ?? null} allowEmpty="— wählen —" options={types.map((t) => ({ value: t.key, label: t.label }))} onChange={(v) => setS({ ...s, job_type: v ?? undefined, input: {} })} />
        </Field>
        <Field label="Agent">
          <Select value={s.agent_id ?? null} allowEmpty="laut Zuständigkeit" options={(agents.data ?? []).map((a) => ({ value: a.id, label: a.name }))} onChange={(v) => setS({ ...s, agent_id: v })} />
        </Field>
        <Field label="Rhythmus">
          <Select value={s.kind ?? 'weekly'} options={SCHEDULE_KINDS.map((k) => ({ value: k, label: KIND_LABELS[k] }))} onChange={(v) => v && setS({ ...s, kind: v })} />
        </Field>
        {s.kind === 'interval' ? (
          <Field label="Alle … Minuten">
            <NumberInput value={s.interval_minutes ?? 60} onChange={(v) => setS({ ...s, interval_minutes: v })} min={5} />
          </Field>
        ) : (
          <Field label="Uhrzeit (HH:MM)">
            <TextInput value={s.time_of_day ?? '08:00'} onChange={(v) => setS({ ...s, time_of_day: v })} />
          </Field>
        )}
        {s.kind === 'weekly' && (
          <Field label="Wochentag">
            <Select value={s.weekday ?? 1} options={WEEKDAYS.map((d, i) => ({ value: i + 1, label: d }))} onChange={(v) => setS({ ...s, weekday: v })} />
          </Field>
        )}
        {s.kind === 'monthly' && (
          <Field label="Tag im Monat (1–28)">
            <NumberInput value={s.day_of_month ?? 1} onChange={(v) => setS({ ...s, day_of_month: v })} min={1} />
          </Field>
        )}
        <Field label="Priorität">
          <Select value={s.priority ?? 1} options={PRIORITIES.map((p) => ({ value: p.value, label: p.label }))} onChange={(v) => setS({ ...s, priority: v ?? 1 })} />
        </Field>
        <Field label="Status">
          <Check checked={!!s.enabled} onChange={(v) => setS({ ...s, enabled: v })} label="aktiv" />
        </Field>
        {def?.input_fields.map((f) => (
          <Field key={f.key} label={f.label} full>
            {f.type === 'number' ? (
              <NumberInput value={s.input?.[f.key] == null ? null : Number(s.input[f.key])} onChange={(v) => setS({ ...s, input: { ...(s.input ?? {}), [f.key]: v } })} />
            ) : (
              <TextArea value={String(s.input?.[f.key] ?? '')} onChange={(v) => setS({ ...s, input: { ...(s.input ?? {}), [f.key]: v } })} rows={3} />
            )}
          </Field>
        ))}
      </div>
    </Modal>
  );
}

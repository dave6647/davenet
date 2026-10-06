import type { Db } from '../db/database.ts';
import { nowIso } from '../db/database.ts';
import type { Schedule, Settings } from '../../shared/domain.ts';
import { buildUpdate, NotFoundError, numOrNull, parseJson, toBool } from './util.ts';

// ---------------------------------------------------------------- Zeit-Trigger (Konzept §15)

const SCHEDULE_COLUMNS = [
  'name',
  'job_type',
  'agent_id',
  'input',
  'priority',
  'kind',
  'interval_minutes',
  'time_of_day',
  'weekday',
  'day_of_month',
  'enabled',
  'last_run_at',
  'next_run_at',
] as const;

function mapSchedule(r: Record<string, unknown>): Schedule {
  return {
    ...(r as unknown as Schedule),
    agent_id: (r.agent_id as string) ?? null,
    input: parseJson(r.input, {}),
    interval_minutes: numOrNull(r.interval_minutes),
    time_of_day: (r.time_of_day as string) ?? null,
    weekday: numOrNull(r.weekday),
    day_of_month: numOrNull(r.day_of_month),
    enabled: toBool(r.enabled),
    last_run_at: (r.last_run_at as string) ?? null,
    next_run_at: (r.next_run_at as string) ?? null,
  };
}

export class ScheduleRepo {
  constructor(private readonly db: Db) {}

  list(): Schedule[] {
    return this.db.all('SELECT * FROM schedules ORDER BY id').map(mapSchedule);
  }

  get(id: number): Schedule | undefined {
    const r = this.db.get('SELECT * FROM schedules WHERE id = ?', id);
    return r ? mapSchedule(r) : undefined;
  }

  require(id: number): Schedule {
    const s = this.get(id);
    if (!s) throw new NotFoundError(`Zeitplan #${id}`);
    return s;
  }

  create(s: Omit<Schedule, 'id' | 'created_at' | 'updated_at' | 'last_run_at'>): Schedule {
    const ts = nowIso();
    const r = this.db.run(
      `INSERT INTO schedules (name, job_type, agent_id, input, priority, kind, interval_minutes, time_of_day, weekday, day_of_month,
        enabled, next_run_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      s.name,
      s.job_type,
      s.agent_id,
      JSON.stringify(s.input ?? {}),
      s.priority,
      s.kind,
      s.interval_minutes,
      s.time_of_day,
      s.weekday,
      s.day_of_month,
      s.enabled,
      s.next_run_at,
      ts,
      ts,
    );
    return this.require(r.lastInsertRowid);
  }

  update(id: number, patch: Partial<Schedule>): Schedule {
    this.require(id);
    const u = buildUpdate('schedules', 'id', id, patch as Record<string, unknown>, SCHEDULE_COLUMNS, ['input']);
    if (u) this.db.run(u.sql, ...u.params);
    return this.require(id);
  }

  delete(id: number): void {
    this.require(id);
    this.db.run('DELETE FROM schedules WHERE id = ?', id);
  }

  due(now: string): Schedule[] {
    return this.db
      .all('SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at', now)
      .map(mapSchedule);
  }
}

// ---------------------------------------------------------------- Einstellungen

export const DEFAULT_SETTINGS: Settings = {
  company_name: 'Davenet',
  output_language: 'Deutsch',
  engine_paused: false,
  max_concurrent_jobs: 2,
  system_monthly_budget_usd: 50,
  budget_warning_pct: 80,
  auto_screening: true,
  deep_research_threshold: 60,
  proposal_threshold: 65,
  auto_start_development: true,
  max_tasks_per_project: 8,
  max_rework_rounds: 2,
  scan_default_count: 5,
  score_weight_market: 0.45,
  score_weight_technical: 0.35,
  score_weight_risk: 0.2,
  artifact_context_chars: 6000,
  job_max_attempts: 3,
};

export class SettingsRepo {
  private cache: Settings | null = null;

  constructor(private readonly db: Db) {}

  get(): Settings {
    if (this.cache) return this.cache;
    const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const r of this.db.all<{ key: string; value: string }>('SELECT key, value FROM settings')) {
      if (r.key in DEFAULT_SETTINGS) out[r.key] = parseJson(r.value, (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[r.key]);
    }
    this.cache = out as unknown as Settings;
    return this.cache;
  }

  update(patch: Partial<Settings>): Settings {
    this.db.tx(() => {
      for (const [key, value] of Object.entries(patch)) {
        if (!(key in DEFAULT_SETTINGS) || value === undefined) continue;
        this.db.run(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
          key,
          JSON.stringify(value),
        );
      }
    });
    this.cache = null;
    return this.get();
  }
}

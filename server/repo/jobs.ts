import type { Db } from '../db/database.ts';
import { nowIso } from '../db/database.ts';
import type { Job, JobLogEntry, JobStatus, ProviderPolicy } from '../../shared/domain.ts';
import { buildUpdate, NotFoundError, numOrNull, parseJson } from './util.ts';

const JOB_COLUMNS = [
  'title',
  'agent_id',
  'status',
  'priority',
  'input',
  'output',
  'provider_id',
  'model_id',
  'forced_provider_id',
  'forced_model_id',
  'policy_override',
  'attempts',
  'max_attempts',
  'not_before',
  'wait_reason',
  'waiting_provider_id',
  'error',
  'cost_usd',
  'equivalent_cost_usd',
  'input_tokens',
  'output_tokens',
  'started_at',
  'finished_at',
] as const;

const MAX_LOG_ENTRIES = 200;

function mapJob(r: Record<string, unknown>): Job {
  return {
    ...(r as unknown as Job),
    input: parseJson(r.input, {}),
    output: r.output == null ? null : parseJson(r.output, null),
    log: parseJson(r.log, []),
    parent_job_id: numOrNull(r.parent_job_id),
    policy_override: (r.policy_override as ProviderPolicy) ?? null,
  };
}

export interface NewJob {
  type: string;
  title: string;
  agent_id: string | null;
  priority?: number;
  input?: Record<string, unknown>;
  opportunity_id?: string | null;
  task_id?: string | null;
  parent_job_id?: number | null;
  policy_override?: ProviderPolicy | null;
  max_attempts?: number;
  not_before?: string | null;
  created_by?: string;
  status?: JobStatus;
}

export interface JobFilter {
  status?: JobStatus[];
  type?: string;
  agent_id?: string;
  opportunity_id?: string;
  task_id?: string;
  limit?: number;
  offset?: number;
}

export class JobRepo {
  constructor(private readonly db: Db) {}

  create(j: NewJob): Job {
    const ts = nowIso();
    const r = this.db.run(
      `INSERT INTO jobs (type, title, agent_id, status, priority, input, opportunity_id, task_id, parent_job_id, policy_override,
        max_attempts, not_before, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      j.type,
      j.title,
      j.agent_id,
      j.status ?? 'QUEUED',
      j.priority ?? 1,
      JSON.stringify(j.input ?? {}),
      j.opportunity_id ?? null,
      j.task_id ?? null,
      j.parent_job_id ?? null,
      j.policy_override ?? null,
      j.max_attempts ?? 3,
      j.not_before ?? null,
      j.created_by ?? 'system',
      ts,
      ts,
    );
    return this.require(r.lastInsertRowid);
  }

  get(id: number): Job | undefined {
    const r = this.db.get('SELECT * FROM jobs WHERE id = ?', id);
    return r ? mapJob(r) : undefined;
  }

  require(id: number): Job {
    const j = this.get(id);
    if (!j) throw new NotFoundError(`Job #${id}`);
    return j;
  }

  list(f: JobFilter = {}): { items: Job[]; total: number } {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (f.status?.length) {
      where.push(`status IN (${f.status.map(() => '?').join(',')})`);
      params.push(...f.status);
    }
    if (f.type) {
      where.push('type = ?');
      params.push(f.type);
    }
    if (f.agent_id) {
      where.push('agent_id = ?');
      params.push(f.agent_id);
    }
    if (f.opportunity_id) {
      where.push('opportunity_id = ?');
      params.push(f.opportunity_id);
    }
    if (f.task_id) {
      where.push('task_id = ?');
      params.push(f.task_id);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM jobs ${w}`, ...params)!.n;
    const items = this.db
      .all(`SELECT * FROM jobs ${w} ORDER BY id DESC LIMIT ? OFFSET ?`, ...params, f.limit ?? 100, f.offset ?? 0)
      .map(mapJob);
    return { items, total };
  }

  update(id: number, patch: Partial<Job>): Job {
    const p: Record<string, unknown> = { ...patch };
    if ('input' in p) p.input = JSON.stringify(p.input ?? {});
    if ('output' in p) p.output = p.output == null ? null : JSON.stringify(p.output);
    const u = buildUpdate('jobs', 'id', id, p, JOB_COLUMNS);
    if (u) this.db.run(u.sql, ...u.params);
    return this.require(id);
  }

  appendLog(id: number, level: JobLogEntry['level'], msg: string): void {
    const row = this.db.get<{ log: string }>('SELECT log FROM jobs WHERE id = ?', id);
    if (!row) return;
    const log = parseJson<JobLogEntry[]>(row.log, []);
    log.push({ ts: nowIso(), level, msg: msg.slice(0, 2000) });
    while (log.length > MAX_LOG_ENTRIES) log.shift();
    this.db.run('UPDATE jobs SET log = ?, updated_at = ? WHERE id = ?', JSON.stringify(log), nowIso(), id);
  }

  addUsage(id: number, u: { input: number; output: number; cost: number; equivalent: number }): void {
    this.db.run(
      `UPDATE jobs SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, cost_usd = cost_usd + ?,
       equivalent_cost_usd = equivalent_cost_usd + ?, updated_at = ? WHERE id = ?`,
      u.input,
      u.output,
      u.cost,
      u.equivalent,
      nowIso(),
      id,
    );
  }

  /** Startbereite Jobs in Abarbeitungsreihenfolge (Priorität, dann Alter). */
  runnable(now: string, limit = 50): Job[] {
    return this.db
      .all(
        `SELECT * FROM jobs WHERE status = 'QUEUED' AND (not_before IS NULL OR not_before <= ?)
         ORDER BY priority DESC, id ASC LIMIT ?`,
        now,
        limit,
      )
      .map(mapJob);
  }

  countByStatus(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db.all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM jobs GROUP BY status')) {
      out[r.status] = r.n;
    }
    return out;
  }

  runningCountByProvider(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db.all<{ provider_id: string; n: number }>(
      "SELECT provider_id, COUNT(*) AS n FROM jobs WHERE status = 'RUNNING' AND provider_id IS NOT NULL GROUP BY provider_id",
    )) {
      out[r.provider_id] = r.n;
    }
    return out;
  }

  /** Nach Absturz/Neustart: laufende Jobs wieder einreihen (Konzept §19: wiederaufnehmbar). */
  requeueInterrupted(): number {
    return this.db.run(
      `UPDATE jobs SET status = 'QUEUED', wait_reason = 'nach Neustart wieder eingereiht', updated_at = ? WHERE status = 'RUNNING'`,
      nowIso(),
    ).changes;
  }

  /** Wartende Jobs, deren Wiederaufnahmezeitpunkt erreicht ist oder deren Provider zurückgesetzt wurde. */
  wakeWaiting(now: string, providerId?: string): Job[] {
    const rows = providerId
      ? this.db.all(
          "SELECT * FROM jobs WHERE status = 'WAITING_FOR_PROVIDER_QUOTA' AND (waiting_provider_id = ? OR waiting_provider_id IS NULL)",
          providerId,
        )
      : this.db.all(
          "SELECT * FROM jobs WHERE status = 'WAITING_FOR_PROVIDER_QUOTA' AND (not_before IS NULL OR not_before <= ?)",
          now,
        );
    const jobs = rows.map(mapJob);
    for (const j of jobs) {
      this.db.run(
        "UPDATE jobs SET status = 'QUEUED', not_before = NULL, wait_reason = NULL, waiting_provider_id = NULL, updated_at = ? WHERE id = ?",
        now,
        j.id,
      );
    }
    return jobs;
  }

  /** Blockierte Jobs erneut prüfen lassen (z. B. nach geänderter Provider-Konfiguration oder Budget). */
  unblock(filter?: { provider_id?: string }): Job[] {
    const rows = filter?.provider_id
      ? this.db.all("SELECT * FROM jobs WHERE status = 'BLOCKED' AND (waiting_provider_id = ? OR waiting_provider_id IS NULL)", filter.provider_id)
      : this.db.all("SELECT * FROM jobs WHERE status = 'BLOCKED'");
    const jobs = rows.map(mapJob);
    const ts = nowIso();
    for (const j of jobs) {
      this.db.run(
        "UPDATE jobs SET status = 'QUEUED', wait_reason = NULL, waiting_provider_id = NULL, updated_at = ? WHERE id = ?",
        ts,
        j.id,
      );
    }
    return jobs;
  }

  openForTask(taskId: string): Job[] {
    return this.db
      .all(
        "SELECT * FROM jobs WHERE task_id = ? AND status IN ('QUEUED','RUNNING','WAITING_FOR_PROVIDER_QUOTA','WAITING_FOR_APPROVAL','BLOCKED')",
        taskId,
      )
      .map(mapJob);
  }

  openForOpportunity(oppId: string, type?: string): Job[] {
    const sql = `SELECT * FROM jobs WHERE opportunity_id = ? ${type ? 'AND type = ?' : ''}
      AND status IN ('QUEUED','RUNNING','WAITING_FOR_PROVIDER_QUOTA','WAITING_FOR_APPROVAL','BLOCKED')`;
    return (type ? this.db.all(sql, oppId, type) : this.db.all(sql, oppId)).map(mapJob);
  }
}

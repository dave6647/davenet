import type { Db } from '../db/database.ts';
import { nowIso } from '../db/database.ts';
import type { Opportunity, OpportunityStatus, Task, TaskStatus } from '../../shared/domain.ts';
import { buildUpdate, NotFoundError, numOrNull, parseJson } from './util.ts';

const OPP_COLUMNS = [
  'title',
  'problem',
  'target_customer',
  'proposed_solution',
  'competition_summary',
  'revenue_model',
  'market_score',
  'technical_score',
  'risk_score',
  'confidence',
  'score',
  'sources',
  'status',
  'status_reason',
  'notes',
] as const;

function mapOpp(r: Record<string, unknown>): Opportunity {
  return {
    ...(r as unknown as Opportunity),
    market_score: numOrNull(r.market_score),
    technical_score: numOrNull(r.technical_score),
    risk_score: numOrNull(r.risk_score),
    confidence: numOrNull(r.confidence),
    score: numOrNull(r.score),
    sources: parseJson(r.sources, []),
    status_reason: (r.status_reason as string) ?? null,
    created_by_job_id: numOrNull(r.created_by_job_id),
  };
}

export type NewOpportunity = Pick<Opportunity, 'title'> &
  Partial<Omit<Opportunity, 'id' | 'seq' | 'created_at' | 'updated_at'>>;

export class OpportunityRepo {
  constructor(private readonly db: Db) {}

  list(filter: { status?: OpportunityStatus[] } = {}): Opportunity[] {
    if (filter.status?.length) {
      return this.db
        .all(`SELECT * FROM opportunities WHERE status IN (${filter.status.map(() => '?').join(',')}) ORDER BY seq DESC`, ...filter.status)
        .map(mapOpp);
    }
    return this.db.all('SELECT * FROM opportunities ORDER BY seq DESC').map(mapOpp);
  }

  get(id: string): Opportunity | undefined {
    const r = this.db.get('SELECT * FROM opportunities WHERE id = ?', id);
    return r ? mapOpp(r) : undefined;
  }

  require(id: string): Opportunity {
    const o = this.get(id);
    if (!o) throw new NotFoundError(`Opportunity ${id}`);
    return o;
  }

  create(o: NewOpportunity): Opportunity {
    return this.db.tx(() => {
      const seq = (this.db.get<{ m: number | null }>('SELECT MAX(seq) AS m FROM opportunities')!.m ?? 0) + 1;
      const id = `OPP-${String(seq).padStart(4, '0')}`;
      const ts = nowIso();
      this.db.run(
        `INSERT INTO opportunities (id, seq, title, problem, target_customer, proposed_solution, competition_summary, revenue_model,
          market_score, technical_score, risk_score, confidence, score, sources, status, status_reason, origin, notes,
          created_by_job_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        seq,
        o.title,
        o.problem ?? '',
        o.target_customer ?? '',
        o.proposed_solution ?? '',
        o.competition_summary ?? '',
        o.revenue_model ?? '',
        o.market_score ?? null,
        o.technical_score ?? null,
        o.risk_score ?? null,
        o.confidence ?? null,
        o.score ?? null,
        JSON.stringify(o.sources ?? []),
        o.status ?? 'DISCOVERED',
        o.status_reason ?? null,
        o.origin ?? 'scout',
        o.notes ?? '',
        o.created_by_job_id ?? null,
        ts,
        ts,
      );
      return this.require(id);
    });
  }

  update(id: string, patch: Partial<Opportunity>): Opportunity {
    this.require(id);
    const u = buildUpdate('opportunities', 'id', id, patch as Record<string, unknown>, OPP_COLUMNS, ['sources']);
    if (u) this.db.run(u.sql, ...u.params);
    return this.require(id);
  }

  delete(id: string): void {
    this.require(id);
    this.db.run('DELETE FROM opportunities WHERE id = ?', id);
  }

  countByStatus(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db.all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM opportunities GROUP BY status')) {
      out[r.status] = r.n;
    }
    return out;
  }

  titles(limit = 150): { id: string; title: string; status: string; status_reason: string | null }[] {
    return this.db.all('SELECT id, title, status, status_reason FROM opportunities ORDER BY seq DESC LIMIT ?', limit);
  }
}

// ---------------------------------------------------------------- Tasks

const TASK_COLUMNS = [
  'title',
  'description',
  'acceptance_criteria',
  'depends_on',
  'status',
  'rework_count',
  'last_review',
  'sort_order',
] as const;

function mapTask(r: Record<string, unknown>): Task {
  return {
    ...(r as unknown as Task),
    acceptance_criteria: parseJson(r.acceptance_criteria, []),
    depends_on: parseJson(r.depends_on, []),
    last_review: parseJson(r.last_review, null),
  };
}

export class TaskRepo {
  constructor(private readonly db: Db) {}

  listForOpportunity(oppId: string): Task[] {
    return this.db.all('SELECT * FROM tasks WHERE opportunity_id = ? ORDER BY sort_order, key', oppId).map(mapTask);
  }

  get(id: string): Task | undefined {
    const r = this.db.get('SELECT * FROM tasks WHERE id = ?', id);
    return r ? mapTask(r) : undefined;
  }

  require(id: string): Task {
    const t = this.get(id);
    if (!t) throw new NotFoundError(`Task ${id}`);
    return t;
  }

  create(oppId: string, t: { key?: string; title: string; description?: string; acceptance_criteria?: string[]; depends_on?: string[] }): Task {
    return this.db.tx(() => {
      const existing = this.listForOpportunity(oppId);
      let key = t.key && /^[A-Za-z0-9_-]{1,20}$/.test(t.key) ? t.key : '';
      if (!key || existing.some((e) => e.key === key)) {
        let n = existing.length + 1;
        while (existing.some((e) => e.key === `T${n}`)) n++;
        key = `T${n}`;
      }
      const id = `${oppId}-${key}`;
      const ts = nowIso();
      this.db.run(
        `INSERT INTO tasks (id, opportunity_id, key, title, description, acceptance_criteria, depends_on, status, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'TODO', ?, ?, ?)`,
        id,
        oppId,
        key,
        t.title,
        t.description ?? '',
        JSON.stringify(t.acceptance_criteria ?? []),
        JSON.stringify(t.depends_on ?? []),
        existing.length,
        ts,
        ts,
      );
      return this.require(id);
    });
  }

  update(id: string, patch: Partial<Task>): Task {
    this.require(id);
    const u = buildUpdate('tasks', 'id', id, patch as Record<string, unknown>, TASK_COLUMNS, [
      'acceptance_criteria',
      'depends_on',
      'last_review',
    ]);
    if (u) this.db.run(u.sql, ...u.params);
    return this.require(id);
  }

  setStatus(id: string, status: TaskStatus): Task {
    return this.update(id, { status });
  }

  delete(id: string): void {
    this.require(id);
    this.db.run('DELETE FROM tasks WHERE id = ?', id);
  }
}

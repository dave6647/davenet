import type { Db } from '../db/database.ts';
import { nowIso } from '../db/database.ts';
import type { Approval, ApprovalStatus, ApprovalType } from '../../shared/domain.ts';
import { NotFoundError, numOrNull, parseJson } from './util.ts';

function mapApproval(r: Record<string, unknown>): Approval {
  return {
    ...(r as unknown as Approval),
    payload: parseJson(r.payload, {}),
    job_id: numOrNull(r.job_id),
    opportunity_id: (r.opportunity_id as string) ?? null,
    decision_note: (r.decision_note as string) ?? null,
    decided_at: (r.decided_at as string) ?? null,
  };
}

export class ApprovalRepo {
  constructor(private readonly db: Db) {}

  create(a: {
    type: ApprovalType;
    level?: number;
    title: string;
    summary?: string;
    payload?: Record<string, unknown>;
    opportunity_id?: string | null;
    job_id?: number | null;
  }): Approval {
    const r = this.db.run(
      `INSERT INTO approvals (type, level, status, title, summary, payload, opportunity_id, job_id, created_at)
       VALUES (?, ?, 'PENDING', ?, ?, ?, ?, ?, ?)`,
      a.type,
      a.level ?? 2,
      a.title,
      a.summary ?? '',
      JSON.stringify(a.payload ?? {}),
      a.opportunity_id ?? null,
      a.job_id ?? null,
      nowIso(),
    );
    return this.require(r.lastInsertRowid);
  }

  get(id: number): Approval | undefined {
    const r = this.db.get('SELECT * FROM approvals WHERE id = ?', id);
    return r ? mapApproval(r) : undefined;
  }

  require(id: number): Approval {
    const a = this.get(id);
    if (!a) throw new NotFoundError(`Freigabe #${id}`);
    return a;
  }

  list(filter: { status?: ApprovalStatus; opportunity_id?: string; limit?: number } = {}): Approval[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    if (filter.opportunity_id) {
      where.push('opportunity_id = ?');
      params.push(filter.opportunity_id);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.db
      .all(`SELECT * FROM approvals ${w} ORDER BY (status = 'PENDING') DESC, id DESC LIMIT ?`, ...params, filter.limit ?? 200)
      .map(mapApproval);
  }

  pending(type?: ApprovalType, opportunityId?: string, jobId?: number): Approval[] {
    return this.list({ status: 'PENDING' }).filter(
      (a) =>
        (!type || a.type === type) &&
        (!opportunityId || a.opportunity_id === opportunityId) &&
        (jobId === undefined || a.job_id === jobId),
    );
  }

  decide(id: number, status: Exclude<ApprovalStatus, 'PENDING'>, note?: string | null): Approval {
    this.db.run(
      "UPDATE approvals SET status = ?, decision_note = ?, decided_at = ? WHERE id = ? AND status = 'PENDING'",
      status,
      note ?? null,
      nowIso(),
      id,
    );
    return this.require(id);
  }

  pendingCount(): number {
    return this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM approvals WHERE status = 'PENDING'")!.n;
  }
}

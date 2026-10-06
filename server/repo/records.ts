import type { Db } from '../db/database.ts';
import { nowIso } from '../db/database.ts';
import type { Artifact, AuditEntry } from '../../shared/domain.ts';
import { NotFoundError, numOrNull, parseJson } from './util.ts';

// ---------------------------------------------------------------- Artefakte (Metadaten; Inhalt liegt im Dateisystem)

function mapArtifact(r: Record<string, unknown>): Artifact {
  return {
    ...(r as unknown as Artifact),
    job_id: numOrNull(r.job_id),
    agent_id: (r.agent_id as string) ?? null,
    opportunity_id: (r.opportunity_id as string) ?? null,
    task_id: (r.task_id as string) ?? null,
  };
}

export class ArtifactRepo {
  constructor(private readonly db: Db) {}

  create(a: Omit<Artifact, 'id' | 'created_at'>): Artifact {
    const r = this.db.run(
      `INSERT INTO artifacts (kind, title, path, format, size, summary, job_id, agent_id, opportunity_id, task_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      a.kind,
      a.title,
      a.path,
      a.format,
      a.size,
      a.summary,
      a.job_id,
      a.agent_id,
      a.opportunity_id,
      a.task_id,
      nowIso(),
    );
    return this.require(r.lastInsertRowid);
  }

  get(id: number): Artifact | undefined {
    const r = this.db.get('SELECT * FROM artifacts WHERE id = ?', id);
    return r ? mapArtifact(r) : undefined;
  }

  require(id: number): Artifact {
    const a = this.get(id);
    if (!a) throw new NotFoundError(`Artefakt #${id}`);
    return a;
  }

  list(filter: { opportunity_id?: string; job_id?: number; task_id?: string; kind?: string; limit?: number } = {}): Artifact[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.opportunity_id) {
      where.push('opportunity_id = ?');
      params.push(filter.opportunity_id);
    }
    if (filter.job_id !== undefined) {
      where.push('job_id = ?');
      params.push(filter.job_id);
    }
    if (filter.task_id) {
      where.push('task_id = ?');
      params.push(filter.task_id);
    }
    if (filter.kind) {
      where.push('kind = ?');
      params.push(filter.kind);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return this.db.all(`SELECT * FROM artifacts ${w} ORDER BY id DESC LIMIT ?`, ...params, filter.limit ?? 200).map(mapArtifact);
  }

  latest(opportunityId: string, kind: string): Artifact | undefined {
    const r = this.db.get('SELECT * FROM artifacts WHERE opportunity_id = ? AND kind = ? ORDER BY id DESC LIMIT 1', opportunityId, kind);
    return r ? mapArtifact(r) : undefined;
  }
}

// ---------------------------------------------------------------- Audit-Log (Konzept §14/§16)

function mapAudit(r: Record<string, unknown>): AuditEntry {
  return {
    ...(r as unknown as AuditEntry),
    entity_type: (r.entity_type as string) ?? null,
    entity_id: (r.entity_id as string) ?? null,
    details: parseJson(r.details, {}),
  };
}

export class AuditRepo {
  constructor(private readonly db: Db) {}

  add(e: { actor: string; action: string; entity_type?: string | null; entity_id?: string | number | null; level?: number; details?: Record<string, unknown> }): AuditEntry {
    const r = this.db.run(
      'INSERT INTO audit_log (ts, actor, action, entity_type, entity_id, level, details) VALUES (?, ?, ?, ?, ?, ?, ?)',
      nowIso(),
      e.actor,
      e.action,
      e.entity_type ?? null,
      e.entity_id == null ? null : String(e.entity_id),
      e.level ?? 0,
      JSON.stringify(e.details ?? {}),
    );
    return mapAudit(this.db.get('SELECT * FROM audit_log WHERE id = ?', r.lastInsertRowid)!);
  }

  list(filter: { entity_type?: string; entity_id?: string; actor?: string; since?: string; limit?: number; offset?: number } = {}): {
    items: AuditEntry[];
    total: number;
  } {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.entity_type) {
      where.push('entity_type = ?');
      params.push(filter.entity_type);
    }
    if (filter.entity_id) {
      where.push('entity_id = ?');
      params.push(filter.entity_id);
    }
    if (filter.actor) {
      where.push('actor LIKE ?');
      params.push(`${filter.actor}%`);
    }
    if (filter.since) {
      where.push('ts >= ?');
      params.push(filter.since);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_log ${w}`, ...params)!.n;
    const items = this.db
      .all(`SELECT * FROM audit_log ${w} ORDER BY id DESC LIMIT ? OFFSET ?`, ...params, filter.limit ?? 100, filter.offset ?? 0)
      .map(mapAudit);
    return { items, total };
  }

  get(id: number): AuditEntry {
    const r = this.db.get('SELECT * FROM audit_log WHERE id = ?', id);
    if (!r) throw new NotFoundError(`Audit-Eintrag #${id}`);
    return mapAudit(r);
  }
}

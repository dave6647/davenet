import type { Db } from '../db/database.ts';
import { nowIso } from '../db/database.ts';
import type { Agent, Department, JobRoute, Capability } from '../../shared/domain.ts';
import { buildUpdate, ConflictError, NotFoundError, numOrNull, parseJson, toBool } from './util.ts';

// ---------------------------------------------------------------- Departments

export class DepartmentRepo {
  constructor(private readonly db: Db) {}

  list(): Department[] {
    return this.db.all<Department>('SELECT * FROM departments ORDER BY sort_order, name');
  }

  get(id: string): Department | undefined {
    return this.db.get<Department>('SELECT * FROM departments WHERE id = ?', id);
  }

  require(id: string): Department {
    const d = this.get(id);
    if (!d) throw new NotFoundError(`Abteilung ${id}`);
    return d;
  }

  create(d: Pick<Department, 'id' | 'name'> & Partial<Department>): Department {
    if (this.get(d.id)) throw new ConflictError(`Abteilung ${d.id} existiert bereits`);
    const ts = nowIso();
    this.db.run(
      'INSERT INTO departments (id, name, description, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      d.id,
      d.name,
      d.description ?? '',
      d.sort_order ?? 0,
      ts,
      ts,
    );
    return this.require(d.id);
  }

  update(id: string, patch: Partial<Department>): Department {
    this.require(id);
    const u = buildUpdate('departments', 'id', id, patch, ['name', 'description', 'sort_order']);
    if (u) this.db.run(u.sql, ...u.params);
    return this.require(id);
  }

  delete(id: string): void {
    this.require(id);
    // Agents behalten ihre Konfiguration und werden "ohne Abteilung" geführt (FK: ON DELETE SET NULL).
    this.db.run('DELETE FROM departments WHERE id = ?', id);
  }
}

// ---------------------------------------------------------------- Agents

const AGENT_COLUMNS = [
  'name',
  'department_id',
  'description',
  'instructions',
  'capability',
  'min_context_tokens',
  'tools',
  'allowed_providers',
  'provider_policy',
  'priority',
  'effort',
  'max_job_cost_usd',
  'max_input_tokens',
  'max_output_tokens',
  'max_tool_calls',
  'max_runtime_sec',
  'monthly_budget_usd',
  'enabled',
  'sort_order',
] as const;

function mapAgent(r: Record<string, unknown>): Agent {
  return {
    ...(r as unknown as Agent),
    tools: parseJson(r.tools, []),
    allowed_providers: parseJson(r.allowed_providers, []),
    effort: (r.effort as Agent['effort']) ?? null,
    max_job_cost_usd: numOrNull(r.max_job_cost_usd),
    monthly_budget_usd: numOrNull(r.monthly_budget_usd),
    enabled: toBool(r.enabled),
  };
}

export class AgentRepo {
  constructor(private readonly db: Db) {}

  list(): Agent[] {
    return this.db.all('SELECT * FROM agents ORDER BY sort_order, name').map(mapAgent);
  }

  get(id: string): Agent | undefined {
    const r = this.db.get('SELECT * FROM agents WHERE id = ?', id);
    return r ? mapAgent(r) : undefined;
  }

  require(id: string): Agent {
    const a = this.get(id);
    if (!a) throw new NotFoundError(`Agent ${id}`);
    return a;
  }

  create(a: Pick<Agent, 'id' | 'name'> & Partial<Agent>): Agent {
    if (this.get(a.id)) throw new ConflictError(`Agent ${a.id} existiert bereits`);
    const ts = nowIso();
    this.db.run(
      `INSERT INTO agents (id, name, department_id, description, instructions, capability, min_context_tokens, tools,
        allowed_providers, provider_policy, priority, effort, max_job_cost_usd, max_input_tokens, max_output_tokens,
        max_tool_calls, max_runtime_sec, monthly_budget_usd, enabled, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      a.id,
      a.name,
      a.department_id ?? null,
      a.description ?? '',
      a.instructions ?? '',
      a.capability ?? 'MEDIUM',
      a.min_context_tokens ?? 0,
      JSON.stringify(a.tools ?? []),
      JSON.stringify(a.allowed_providers ?? []),
      a.provider_policy ?? 'WAIT',
      a.priority ?? 1,
      a.effort ?? null,
      a.max_job_cost_usd ?? null,
      a.max_input_tokens ?? 40000,
      a.max_output_tokens ?? 8000,
      a.max_tool_calls ?? 10,
      a.max_runtime_sec ?? 900,
      a.monthly_budget_usd ?? null,
      a.enabled ?? true,
      a.sort_order ?? 0,
      ts,
      ts,
    );
    return this.require(a.id);
  }

  update(id: string, patch: Partial<Agent>): Agent {
    this.require(id);
    const u = buildUpdate('agents', 'id', id, patch as Record<string, unknown>, AGENT_COLUMNS, ['tools', 'allowed_providers']);
    if (u) this.db.run(u.sql, ...u.params);
    return this.require(id);
  }

  delete(id: string): void {
    this.require(id);
    this.db.run('DELETE FROM agents WHERE id = ?', id);
  }
}

// ---------------------------------------------------------------- Job-Routing (Job-Typ -> Agent)

function mapRoute(r: Record<string, unknown>): JobRoute {
  return {
    job_type: String(r.job_type),
    agent_id: (r.agent_id as string) ?? null,
    capability_override: (r.capability_override as Capability) ?? null,
    enabled: toBool(r.enabled),
    updated_at: String(r.updated_at),
  };
}

export class RouteRepo {
  constructor(private readonly db: Db) {}

  list(): JobRoute[] {
    return this.db.all('SELECT * FROM job_routes ORDER BY job_type').map(mapRoute);
  }

  get(jobType: string): JobRoute | undefined {
    const r = this.db.get('SELECT * FROM job_routes WHERE job_type = ?', jobType);
    return r ? mapRoute(r) : undefined;
  }

  upsert(route: Pick<JobRoute, 'job_type'> & Partial<JobRoute>): JobRoute {
    const existing = this.get(route.job_type);
    const merged = {
      agent_id: route.agent_id !== undefined ? route.agent_id : (existing?.agent_id ?? null),
      capability_override:
        route.capability_override !== undefined ? route.capability_override : (existing?.capability_override ?? null),
      enabled: route.enabled !== undefined ? route.enabled : (existing?.enabled ?? true),
    };
    this.db.run(
      `INSERT INTO job_routes (job_type, agent_id, capability_override, enabled, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(job_type) DO UPDATE SET agent_id = excluded.agent_id, capability_override = excluded.capability_override,
       enabled = excluded.enabled, updated_at = excluded.updated_at`,
      route.job_type,
      merged.agent_id,
      merged.capability_override,
      merged.enabled,
      nowIso(),
    );
    return this.get(route.job_type)!;
  }
}

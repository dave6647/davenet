import type { Db } from '../db/database.ts';
import { nowIso } from '../db/database.ts';
import type { Model, Provider } from '../../shared/domain.ts';
import { buildUpdate, ConflictError, NotFoundError, numOrNull, parseJson, toBool } from './util.ts';

const PROVIDER_COLUMNS = [
  'name',
  'enabled',
  'priority',
  'billing_mode',
  'config',
  'quota_unit',
  'quota_limit',
  'quota_period',
  'quota_period_hours',
  'quota_reset_day',
  'quota_reset_hour',
  'policy_on_exhaustion',
  'monthly_cost_limit_usd',
  'max_concurrent',
  'notes',
] as const;

const PROVIDER_STATE_COLUMNS = [
  'exhausted_until',
  'exhausted_reason',
  'quota_counter_reset_at',
  'plan_info',
  'health_status',
  'health_message',
  'health_checked_at',
] as const;

function mapProvider(r: Record<string, unknown>): Provider {
  return {
    ...(r as unknown as Provider),
    enabled: toBool(r.enabled),
    config: parseJson(r.config, {}),
    quota_limit: numOrNull(r.quota_limit),
    monthly_cost_limit_usd: numOrNull(r.monthly_cost_limit_usd),
    exhausted_until: (r.exhausted_until as string) ?? null,
    exhausted_reason: (r.exhausted_reason as string) ?? null,
    quota_counter_reset_at: (r.quota_counter_reset_at as string) ?? null,
    plan_info: parseJson(r.plan_info, null),
    health_message: (r.health_message as string) ?? null,
    health_checked_at: (r.health_checked_at as string) ?? null,
  };
}

export class ProviderRepo {
  constructor(private readonly db: Db) {}

  list(): Provider[] {
    return this.db.all('SELECT * FROM providers ORDER BY priority, name').map(mapProvider);
  }

  get(id: string): Provider | undefined {
    const r = this.db.get('SELECT * FROM providers WHERE id = ?', id);
    return r ? mapProvider(r) : undefined;
  }

  require(id: string): Provider {
    const p = this.get(id);
    if (!p) throw new NotFoundError(`Provider ${id}`);
    return p;
  }

  create(p: Pick<Provider, 'id' | 'name' | 'type'> & Partial<Provider>): Provider {
    if (this.get(p.id)) throw new ConflictError(`Provider ${p.id} existiert bereits`);
    const ts = nowIso();
    this.db.run(
      `INSERT INTO providers (id, name, type, enabled, priority, billing_mode, config, quota_unit, quota_limit, quota_period,
        quota_period_hours, quota_reset_day, quota_reset_hour, policy_on_exhaustion, monthly_cost_limit_usd, max_concurrent,
        notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      p.id,
      p.name,
      p.type,
      p.enabled ?? true,
      p.priority ?? 100,
      p.billing_mode ?? 'subscription',
      JSON.stringify(p.config ?? {}),
      p.quota_unit ?? 'none',
      p.quota_limit ?? null,
      p.quota_period ?? 'monthly',
      p.quota_period_hours ?? 5,
      p.quota_reset_day ?? 1,
      p.quota_reset_hour ?? 0,
      p.policy_on_exhaustion ?? 'WAIT',
      p.monthly_cost_limit_usd ?? null,
      p.max_concurrent ?? 2,
      p.notes ?? '',
      ts,
      ts,
    );
    return this.require(p.id);
  }

  update(id: string, patch: Partial<Provider>): Provider {
    this.require(id);
    const u = buildUpdate('providers', 'id', id, patch as Record<string, unknown>, PROVIDER_COLUMNS, ['config']);
    if (u) this.db.run(u.sql, ...u.params);
    return this.require(id);
  }

  /** Laufzeitzustand (Erschöpfung, Health) – getrennt von der Owner-Konfiguration. */
  setState(id: string, patch: Partial<Pick<Provider, (typeof PROVIDER_STATE_COLUMNS)[number]>>): Provider {
    const u = buildUpdate('providers', 'id', id, patch as Record<string, unknown>, PROVIDER_STATE_COLUMNS, ['plan_info']);
    if (u) this.db.run(u.sql, ...u.params);
    return this.require(id);
  }

  delete(id: string): void {
    this.require(id);
    this.db.run('DELETE FROM providers WHERE id = ?', id);
  }
}

const MODEL_COLUMNS = [
  'model_name',
  'label',
  'tier',
  'context_window',
  'max_output_tokens',
  'input_price_per_mtok',
  'output_price_per_mtok',
  'supports_effort',
  'enabled',
  'sort_order',
] as const;

function mapModel(r: Record<string, unknown>): Model {
  return {
    ...(r as unknown as Model),
    supports_effort: toBool(r.supports_effort),
    enabled: toBool(r.enabled),
  };
}

export class ModelRepo {
  constructor(private readonly db: Db) {}

  list(providerId?: string): Model[] {
    const rows = providerId
      ? this.db.all('SELECT * FROM models WHERE provider_id = ? ORDER BY sort_order, label', providerId)
      : this.db.all('SELECT * FROM models ORDER BY provider_id, sort_order, label');
    return rows.map(mapModel);
  }

  get(id: string): Model | undefined {
    const r = this.db.get('SELECT * FROM models WHERE id = ?', id);
    return r ? mapModel(r) : undefined;
  }

  require(id: string): Model {
    const m = this.get(id);
    if (!m) throw new NotFoundError(`Modell ${id}`);
    return m;
  }

  create(m: Pick<Model, 'provider_id' | 'model_name' | 'tier'> & Partial<Model>): Model {
    const id = m.id ?? `${m.provider_id}:${m.model_name}`;
    if (this.get(id)) throw new ConflictError(`Modell ${id} existiert bereits`);
    const ts = nowIso();
    this.db.run(
      `INSERT INTO models (id, provider_id, model_name, label, tier, context_window, max_output_tokens, input_price_per_mtok,
        output_price_per_mtok, supports_effort, enabled, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      m.provider_id,
      m.model_name,
      m.label ?? m.model_name,
      m.tier,
      m.context_window ?? 200000,
      m.max_output_tokens ?? 32000,
      m.input_price_per_mtok ?? 0,
      m.output_price_per_mtok ?? 0,
      m.supports_effort ?? false,
      m.enabled ?? true,
      m.sort_order ?? 0,
      ts,
      ts,
    );
    return this.require(id);
  }

  update(id: string, patch: Partial<Model>): Model {
    this.require(id);
    const u = buildUpdate('models', 'id', id, patch as Record<string, unknown>, MODEL_COLUMNS);
    if (u) this.db.run(u.sql, ...u.params);
    return this.require(id);
  }

  delete(id: string): void {
    this.require(id);
    this.db.run('DELETE FROM models WHERE id = ?', id);
  }
}

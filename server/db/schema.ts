/**
 * Datenbank-Migrationen. Nur anhängen, nie bestehende Einträge ändern –
 * jede bestehende Installation hat die früheren Schritte bereits ausgeführt.
 */
export const MIGRATIONS: string[] = [
  /* 1 – Grundschema Davenet v0.1 */ `
CREATE TABLE departments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  department_id TEXT REFERENCES departments(id) ON DELETE SET NULL,
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  capability TEXT NOT NULL DEFAULT 'MEDIUM',
  min_context_tokens INTEGER NOT NULL DEFAULT 0,
  tools TEXT NOT NULL DEFAULT '[]',
  allowed_providers TEXT NOT NULL DEFAULT '[]',
  provider_policy TEXT NOT NULL DEFAULT 'WAIT',
  priority INTEGER NOT NULL DEFAULT 1,
  effort TEXT,
  max_job_cost_usd REAL,
  max_input_tokens INTEGER NOT NULL DEFAULT 40000,
  max_output_tokens INTEGER NOT NULL DEFAULT 8000,
  max_tool_calls INTEGER NOT NULL DEFAULT 10,
  max_runtime_sec INTEGER NOT NULL DEFAULT 900,
  monthly_budget_usd REAL,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100,
  billing_mode TEXT NOT NULL DEFAULT 'subscription',
  config TEXT NOT NULL DEFAULT '{}',
  quota_unit TEXT NOT NULL DEFAULT 'none',
  quota_limit REAL,
  quota_period TEXT NOT NULL DEFAULT 'monthly',
  quota_period_hours INTEGER NOT NULL DEFAULT 5,
  quota_reset_day INTEGER NOT NULL DEFAULT 1,
  quota_reset_hour INTEGER NOT NULL DEFAULT 0,
  policy_on_exhaustion TEXT NOT NULL DEFAULT 'WAIT',
  monthly_cost_limit_usd REAL,
  max_concurrent INTEGER NOT NULL DEFAULT 2,
  notes TEXT NOT NULL DEFAULT '',
  exhausted_until TEXT,
  exhausted_reason TEXT,
  quota_counter_reset_at TEXT,
  plan_info TEXT,
  health_status TEXT NOT NULL DEFAULT 'unknown',
  health_message TEXT,
  health_checked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE models (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_name TEXT NOT NULL,
  label TEXT NOT NULL,
  tier TEXT NOT NULL,
  context_window INTEGER NOT NULL DEFAULT 200000,
  max_output_tokens INTEGER NOT NULL DEFAULT 32000,
  input_price_per_mtok REAL NOT NULL DEFAULT 0,
  output_price_per_mtok REAL NOT NULL DEFAULT 0,
  supports_effort INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider_id, model_name)
);

CREATE TABLE job_routes (
  job_type TEXT PRIMARY KEY,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  capability_override TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE opportunities (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL,
  problem TEXT NOT NULL DEFAULT '',
  target_customer TEXT NOT NULL DEFAULT '',
  proposed_solution TEXT NOT NULL DEFAULT '',
  competition_summary TEXT NOT NULL DEFAULT '',
  revenue_model TEXT NOT NULL DEFAULT '',
  market_score REAL,
  technical_score REAL,
  risk_score REAL,
  confidence REAL,
  score REAL,
  sources TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'DISCOVERED',
  status_reason TEXT,
  origin TEXT NOT NULL DEFAULT 'scout',
  notes TEXT NOT NULL DEFAULT '',
  created_by_job_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX opportunities_status ON opportunities(status);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  acceptance_criteria TEXT NOT NULL DEFAULT '[]',
  depends_on TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'TODO',
  rework_count INTEGER NOT NULL DEFAULT 0,
  last_review TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (opportunity_id, key)
);

CREATE TABLE jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  agent_id TEXT,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 1,
  input TEXT NOT NULL DEFAULT '{}',
  output TEXT,
  opportunity_id TEXT,
  task_id TEXT,
  parent_job_id INTEGER,
  provider_id TEXT,
  model_id TEXT,
  forced_provider_id TEXT,
  forced_model_id TEXT,
  policy_override TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  not_before TEXT,
  wait_reason TEXT,
  waiting_provider_id TEXT,
  error TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  equivalent_cost_usd REAL NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  log TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL DEFAULT 'system',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX jobs_queue ON jobs(status, priority DESC, id);
CREATE INDEX jobs_opportunity ON jobs(opportunity_id);

CREATE TABLE approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 2,
  status TEXT NOT NULL DEFAULT 'PENDING',
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}',
  opportunity_id TEXT,
  job_id INTEGER,
  decision_note TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX approvals_status ON approvals(status);

CREATE TABLE artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  path TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'md',
  size INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL DEFAULT '',
  job_id INTEGER,
  agent_id TEXT,
  opportunity_id TEXT,
  task_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX artifacts_opportunity ON artifacts(opportunity_id);
CREATE INDEX artifacts_job ON artifacts(job_id);

CREATE TABLE usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  job_id INTEGER,
  job_type TEXT,
  agent_id TEXT,
  provider_id TEXT NOT NULL,
  model_id TEXT,
  model_name TEXT,
  opportunity_id TEXT,
  purpose TEXT NOT NULL DEFAULT 'job',
  billing_mode TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 1,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  provider_units REAL,
  monetary_cost_usd REAL NOT NULL DEFAULT 0,
  equivalent_cost_usd REAL NOT NULL DEFAULT 0,
  quota_period TEXT,
  quota_remaining REAL,
  duration_ms INTEGER,
  success INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX usage_ts ON usage_events(ts);
CREATE INDEX usage_provider_ts ON usage_events(provider_id, ts);
CREATE INDEX usage_agent_ts ON usage_events(agent_id, ts);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  level INTEGER NOT NULL DEFAULT 0,
  details TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_ts ON audit_log(ts);

CREATE TABLE schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  job_type TEXT NOT NULL,
  agent_id TEXT,
  input TEXT NOT NULL DEFAULT '{}',
  priority INTEGER NOT NULL DEFAULT 1,
  kind TEXT NOT NULL,
  interval_minutes INTEGER,
  time_of_day TEXT,
  weekday INTEGER,
  day_of_month INTEGER,
  enabled INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  next_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`,
];

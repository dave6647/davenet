/**
 * Gemeinsame Domänen-Konstanten und DTO-Typen für Server und Oberfläche.
 * Begriffe folgen dem Konzept (docs/KONZEPT.md).
 */

// ---------------------------------------------------------------- Capability-Klassen (Konzept §4)
export const CAPABILITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type Capability = (typeof CAPABILITIES)[number];
export const CAPABILITY_LABELS: Record<Capability, string> = {
  LOW: 'LOW – Formatierung, Extraktion, Klassifikation',
  MEDIUM: 'MEDIUM – Research, Analyse, Standard-Code',
  HIGH: 'HIGH – Architektur, schwierige Reviews, Strategie',
};
export const capabilityRank = (c: Capability): number => CAPABILITIES.indexOf(c);

// ---------------------------------------------------------------- Policies (Konzept §5, §7)
export const PROVIDER_POLICIES = ['WAIT', 'FALLBACK_SAME_TIER', 'FALLBACK_ANY_ALLOWED', 'OWNER_APPROVAL'] as const;
export type ProviderPolicy = (typeof PROVIDER_POLICIES)[number];
export const PROVIDER_POLICY_LABELS: Record<ProviderPolicy, string> = {
  WAIT: 'WAIT – bis zum Provider-Reset pausieren',
  FALLBACK_SAME_TIER: 'FALLBACK_SAME_TIER – Alternative gleicher Capability nutzen',
  FALLBACK_ANY_ALLOWED: 'FALLBACK_ANY_ALLOWED – jede freigegebene Alternative nutzen',
  OWNER_APPROVAL: 'OWNER_APPROVAL – Alternative erst nach Freigabe',
};

export const EXHAUSTION_POLICIES = ['WAIT', 'BLOCK'] as const;
export type ExhaustionPolicy = (typeof EXHAUSTION_POLICIES)[number];
export const EXHAUSTION_POLICY_LABELS: Record<ExhaustionPolicy, string> = {
  WAIT: 'WAIT – Jobs warten bis zum Reset',
  BLOCK: 'BLOCK – Jobs blockieren, bis der Owner eingreift',
};

export const BILLING_MODES = ['subscription', 'pay_as_you_go'] as const;
export type BillingMode = (typeof BILLING_MODES)[number];
export const BILLING_MODE_LABELS: Record<BillingMode, string> = {
  subscription: 'Abo / Plan (Kontingent)',
  pay_as_you_go: 'Pay-as-you-go (Kosten pro Nutzung)',
};

export const QUOTA_UNITS = ['none', 'tokens', 'requests', 'cost_usd'] as const;
export type QuotaUnit = (typeof QUOTA_UNITS)[number];
export const QUOTA_UNIT_LABELS: Record<QuotaUnit, string> = {
  none: 'kein festes Kontingent (nur Limit-Meldungen des Providers)',
  tokens: 'Tokens (Input + Output)',
  requests: 'Requests / Modellaufrufe',
  cost_usd: 'USD-Gegenwert (Listenpreis)',
};

export const QUOTA_PERIODS = ['monthly', 'weekly', 'daily', 'rolling', 'none'] as const;
export type QuotaPeriod = (typeof QUOTA_PERIODS)[number];
export const QUOTA_PERIOD_LABELS: Record<QuotaPeriod, string> = {
  monthly: 'monatlich',
  weekly: 'wöchentlich',
  daily: 'täglich',
  rolling: 'rollierendes Fenster (Stunden)',
  none: 'ohne Periode (bis manueller Reset)',
};

// ---------------------------------------------------------------- Jobs (Konzept §6)
export const JOB_STATUSES = [
  'QUEUED',
  'RUNNING',
  'WAITING_FOR_PROVIDER_QUOTA',
  'WAITING_FOR_APPROVAL',
  'BLOCKED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  QUEUED: 'in Warteschlange',
  RUNNING: 'läuft',
  WAITING_FOR_PROVIDER_QUOTA: 'wartet auf Kontingent',
  WAITING_FOR_APPROVAL: 'wartet auf Freigabe',
  BLOCKED: 'blockiert',
  COMPLETED: 'abgeschlossen',
  FAILED: 'fehlgeschlagen',
  CANCELLED: 'abgebrochen',
};
export const OPEN_JOB_STATUSES: JobStatus[] = ['QUEUED', 'RUNNING', 'WAITING_FOR_PROVIDER_QUOTA', 'WAITING_FOR_APPROVAL', 'BLOCKED'];

export const PRIORITIES = [
  { value: 0, label: 'niedrig' },
  { value: 1, label: 'normal' },
  { value: 2, label: 'hoch' },
  { value: 3, label: 'kritisch' },
] as const;
export const priorityLabel = (p: number): string => PRIORITIES.find((x) => x.value === p)?.label ?? String(p);

// ---------------------------------------------------------------- Opportunity-Pipeline (Konzept §8)
export const OPPORTUNITY_STATUSES = [
  'DISCOVERED',
  'SCREENING',
  'RESEARCH',
  'EVALUATION',
  'PROPOSED',
  'APPROVED',
  'DEVELOPMENT',
  'REVIEW',
  'READY',
  'DEPLOYED',
  'REJECTED',
  'ON_HOLD',
] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];
export const OPPORTUNITY_STATUS_LABELS: Record<OpportunityStatus, string> = {
  DISCOVERED: 'entdeckt',
  SCREENING: 'Screening',
  RESEARCH: 'Research',
  EVALUATION: 'Bewertung',
  PROPOSED: 'vorgeschlagen (Freigabe offen)',
  APPROVED: 'freigegeben',
  DEVELOPMENT: 'Entwicklung',
  REVIEW: 'Review / Test',
  READY: 'bereit (Release-Freigabe offen)',
  DEPLOYED: 'veröffentlicht',
  REJECTED: 'verworfen',
  ON_HOLD: 'zurückgestellt',
};

export const TASK_STATUSES = ['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'REWORK', 'DONE', 'BLOCKED'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  TODO: 'offen',
  IN_PROGRESS: 'in Umsetzung',
  IN_REVIEW: 'im Review',
  REWORK: 'Nacharbeit',
  DONE: 'erledigt',
  BLOCKED: 'blockiert (Owner)',
};

// ---------------------------------------------------------------- Freigaben (Konzept §14)
export const APPROVAL_TYPES = ['PROJECT_START', 'RELEASE', 'PROVIDER_SWITCH'] as const;
export type ApprovalType = (typeof APPROVAL_TYPES)[number];
export const APPROVAL_TYPE_LABELS: Record<ApprovalType, string> = {
  PROJECT_START: 'Projektstart',
  RELEASE: 'Release / Veröffentlichung',
  PROVIDER_SWITCH: 'Provider-Wechsel',
};
export const APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export const APPROVAL_STATUS_LABELS: Record<ApprovalStatus, string> = {
  PENDING: 'offen',
  APPROVED: 'freigegeben',
  REJECTED: 'abgelehnt',
  CANCELLED: 'gegenstandslos',
};

export const APPROVAL_LEVELS = [
  { level: 0, label: 'Autonom', examples: 'Recherche, Analyse, interne Reports, Tests' },
  { level: 1, label: 'Autonom + Audit Log', examples: 'Code im Projekt-Workspace, interne Datenänderungen' },
  { level: 2, label: 'Owner Approval', examples: 'Projektstart, Release/Deployment, Veröffentlichung, Provider-Wechsel' },
  { level: 3, label: 'Immer Owner', examples: 'Geldtransaktionen, Verträge, Accounts, Zugangsdaten – Agents haben dafür keine Werkzeuge' },
] as const;

// ---------------------------------------------------------------- Tools (Tool Gateway)
export const TOOLS = {
  web_search: { label: 'Websuche', description: 'Suche im Web (Recherche).', level: 0 },
  web_fetch: { label: 'Webseiten abrufen', description: 'Inhalte einzelner URLs lesen.', level: 0 },
  workspace_read: { label: 'Workspace lesen', description: 'Dateien im Projekt-Workspace lesen.', level: 0 },
  workspace_write: { label: 'Workspace schreiben', description: 'Dateien im Projekt-Workspace anlegen/ändern (Audit-Log).', level: 1 },
} as const;
export type ToolKey = keyof typeof TOOLS;
export const TOOL_KEYS = ['web_search', 'web_fetch', 'workspace_read', 'workspace_write'] as const satisfies readonly ToolKey[];

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

// ---------------------------------------------------------------- DTOs
export interface Department {
  id: string;
  name: string;
  description: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface Agent {
  id: string;
  name: string;
  department_id: string | null;
  description: string;
  instructions: string;
  capability: Capability;
  min_context_tokens: number;
  tools: ToolKey[];
  allowed_providers: string[];
  provider_policy: ProviderPolicy;
  priority: number;
  effort: Effort | null;
  max_job_cost_usd: number | null;
  max_input_tokens: number;
  max_output_tokens: number;
  max_tool_calls: number;
  max_runtime_sec: number;
  monthly_budget_usd: number | null;
  enabled: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface Provider {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  priority: number;
  billing_mode: BillingMode;
  config: Record<string, unknown>;
  quota_unit: QuotaUnit;
  quota_limit: number | null;
  quota_period: QuotaPeriod;
  quota_period_hours: number;
  quota_reset_day: number;
  quota_reset_hour: number;
  policy_on_exhaustion: ExhaustionPolicy;
  monthly_cost_limit_usd: number | null;
  max_concurrent: number;
  notes: string;
  exhausted_until: string | null;
  exhausted_reason: string | null;
  quota_counter_reset_at: string | null;
  /** Letzte vom Provider gemeldete Plan-Auslastung (z. B. Claude-Abo: 5-Stunden-/7-Tage-Fenster). */
  plan_info: PlanInfo | null;
  health_status: 'unknown' | 'ok' | 'error';
  health_message: string | null;
  health_checked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlanInfo {
  status: string;
  rate_limit_type: string | null;
  resets_at: string | null;
  windows: Record<string, { utilization: number | null; resets_at: string | null }>;
  updated_at: string;
}

export interface QuotaStatus {
  unit: QuotaUnit;
  period: QuotaPeriod;
  period_key: string;
  period_start: string | null;
  next_reset: string | null;
  used: number;
  limit: number | null;
  remaining: number | null;
  exhausted: boolean;
  exhausted_until: string | null;
  reason: string | null;
  month_cost_usd: number;
  month_equivalent_usd: number;
  cost_limit_reached: boolean;
  running_jobs: number;
}

export interface ProviderView extends Provider {
  quota: QuotaStatus;
  secret: { has_secret: boolean; hint: string | null; source: 'stored' | 'env' | null };
}

export interface Model {
  id: string;
  provider_id: string;
  model_name: string;
  label: string;
  tier: Capability;
  context_window: number;
  max_output_tokens: number;
  input_price_per_mtok: number;
  output_price_per_mtok: number;
  supports_effort: boolean;
  enabled: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface JobRoute {
  job_type: string;
  agent_id: string | null;
  capability_override: Capability | null;
  enabled: boolean;
  updated_at: string;
}

export interface JobLogEntry {
  ts: string;
  level: 'info' | 'warn' | 'error';
  msg: string;
}

export interface Job {
  id: number;
  type: string;
  title: string;
  agent_id: string | null;
  status: JobStatus;
  priority: number;
  input: Record<string, unknown>;
  output: unknown;
  opportunity_id: string | null;
  task_id: string | null;
  parent_job_id: number | null;
  provider_id: string | null;
  model_id: string | null;
  forced_provider_id: string | null;
  forced_model_id: string | null;
  policy_override: ProviderPolicy | null;
  attempts: number;
  max_attempts: number;
  not_before: string | null;
  wait_reason: string | null;
  waiting_provider_id: string | null;
  error: string | null;
  cost_usd: number;
  equivalent_cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  log: JobLogEntry[];
  created_by: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface Source {
  title: string;
  url: string;
  note?: string;
}

export interface Opportunity {
  id: string;
  seq: number;
  title: string;
  problem: string;
  target_customer: string;
  proposed_solution: string;
  competition_summary: string;
  revenue_model: string;
  market_score: number | null;
  technical_score: number | null;
  risk_score: number | null;
  confidence: number | null;
  score: number | null;
  sources: Source[];
  status: OpportunityStatus;
  status_reason: string | null;
  origin: string;
  notes: string;
  created_by_job_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface ReviewFinding {
  severity: 'critical' | 'major' | 'minor';
  file?: string;
  description: string;
}

export interface Task {
  id: string;
  opportunity_id: string;
  key: string;
  title: string;
  description: string;
  acceptance_criteria: string[];
  depends_on: string[];
  status: TaskStatus;
  rework_count: number;
  last_review: { verdict: string; summary: string; findings: ReviewFinding[] } | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface Approval {
  id: number;
  type: ApprovalType;
  level: number;
  status: ApprovalStatus;
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  opportunity_id: string | null;
  job_id: number | null;
  decision_note: string | null;
  created_at: string;
  decided_at: string | null;
}

export interface Artifact {
  id: number;
  kind: string;
  title: string;
  path: string;
  format: 'md' | 'json';
  size: number;
  summary: string;
  job_id: number | null;
  agent_id: string | null;
  opportunity_id: string | null;
  task_id: string | null;
  created_at: string;
}

export interface UsageEvent {
  id: number;
  ts: string;
  job_id: number | null;
  job_type: string | null;
  agent_id: string | null;
  provider_id: string;
  model_id: string | null;
  model_name: string | null;
  opportunity_id: string | null;
  purpose: string;
  billing_mode: BillingMode;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  requests: number;
  tool_calls: number;
  provider_units: number | null;
  monetary_cost_usd: number;
  equivalent_cost_usd: number;
  quota_period: string | null;
  quota_remaining: number | null;
  duration_ms: number | null;
  success: boolean;
}

export interface AuditEntry {
  id: number;
  ts: string;
  actor: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  level: number;
  details: Record<string, unknown>;
}

export const SCHEDULE_KINDS = ['interval', 'daily', 'weekly', 'monthly'] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

export interface Schedule {
  id: number;
  name: string;
  job_type: string;
  agent_id: string | null;
  input: Record<string, unknown>;
  priority: number;
  kind: ScheduleKind;
  interval_minutes: number | null;
  time_of_day: string | null;
  weekday: number | null;
  day_of_month: number | null;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Settings {
  company_name: string;
  output_language: string;
  engine_paused: boolean;
  max_concurrent_jobs: number;
  system_monthly_budget_usd: number | null;
  budget_warning_pct: number;
  auto_screening: boolean;
  deep_research_threshold: number;
  proposal_threshold: number;
  auto_start_development: boolean;
  max_tasks_per_project: number;
  max_rework_rounds: number;
  scan_default_count: number;
  score_weight_market: number;
  score_weight_technical: number;
  score_weight_risk: number;
  artifact_context_chars: number;
  strategy_context_chars: number;
  job_max_attempts: number;
}

/** Welche Fassung der Unternehmensstrategie die Agents als Kontext erhalten. */
export interface StrategyStatus {
  /** Mitgegebene Fassung: Kurzfassung, Langfassung oder keine. */
  source: 'summary' | 'full' | 'none';
  /** Zeichenlimit für den Strategie-Kontext (Einstellung strategy_context_chars). */
  limit: number;
  full: { path: string; exists: boolean; chars: number; modified: string | null; template: boolean };
  summary: { path: string; exists: boolean; chars: number; modified: string | null; ignored: boolean };
  /** Die Langfassung wurde nach der Kurzfassung geändert. */
  summary_outdated: boolean;
  /** Die mitgegebene Fassung ist länger als das Limit und wird gekürzt. */
  truncated: boolean;
}

export interface JobTypeInfo {
  key: string;
  label: string;
  description: string;
  department_hint: string;
  default_agent: string;
  tools: ToolKey[];
  requires_opportunity: boolean;
  requires_task: boolean;
  manual: boolean;
  input_fields: { key: string; label: string; type: 'text' | 'textarea' | 'number'; required?: boolean }[];
}

export interface ProviderTypeInfo {
  type: string;
  label: string;
  description: string;
  billing_mode_default: BillingMode;
  supports_tools: ToolKey[];
  needs_secret: boolean;
  secret_label: string | null;
  config_fields: { key: string; label: string; type: 'text' | 'password' | 'number' | 'textarea'; help?: string }[];
}

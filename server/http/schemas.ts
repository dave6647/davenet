import { z } from 'zod';
import {
  BILLING_MODES,
  CAPABILITIES,
  EFFORTS,
  EXHAUSTION_POLICIES,
  PROVIDER_POLICIES,
  QUOTA_PERIODS,
  QUOTA_UNITS,
  SCHEDULE_KINDS,
  TOOL_KEYS,
} from '../../shared/domain.ts';

const slug = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{2,40}$/, 'Nur Buchstaben, Ziffern, _ und - (2–40 Zeichen)');
const nullableNumber = z.number().nonnegative().nullable();

export const DepartmentCreate = z.object({
  id: slug,
  name: z.string().trim().min(1).max(80),
  description: z.string().max(2000).optional(),
  sort_order: z.number().int().optional(),
});
export const DepartmentUpdate = DepartmentCreate.omit({ id: true }).partial();

const agentFields = {
  name: z.string().trim().min(1).max(80),
  department_id: z.string().nullable(),
  description: z.string().max(2000),
  instructions: z.string().max(20000),
  capability: z.enum(CAPABILITIES),
  min_context_tokens: z.number().int().min(0).max(10_000_000),
  tools: z.array(z.enum(TOOL_KEYS)),
  allowed_providers: z.array(z.string()),
  provider_policy: z.enum(PROVIDER_POLICIES),
  priority: z.number().int().min(0).max(3),
  effort: z.enum(EFFORTS).nullable(),
  max_job_cost_usd: nullableNumber,
  max_input_tokens: z.number().int().min(1000).max(2_000_000),
  max_output_tokens: z.number().int().min(256).max(128_000),
  max_tool_calls: z.number().int().min(0).max(500),
  max_runtime_sec: z.number().int().min(30).max(24 * 3600),
  monthly_budget_usd: nullableNumber,
  enabled: z.boolean(),
  sort_order: z.number().int(),
};
export const AgentCreate = z.object({ id: slug.transform((s) => s.toUpperCase()), ...agentFields }).partial().required({ id: true, name: true });
export const AgentUpdate = z.object(agentFields).partial();

export const RouteUpdate = z.object({
  agent_id: z.string().nullable().optional(),
  capability_override: z.enum(CAPABILITIES).nullable().optional(),
  enabled: z.boolean().optional(),
});

const providerFields = {
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean(),
  priority: z.number().int().min(0).max(1000),
  billing_mode: z.enum(BILLING_MODES),
  config: z.record(z.string(), z.unknown()),
  quota_unit: z.enum(QUOTA_UNITS),
  quota_limit: nullableNumber,
  quota_period: z.enum(QUOTA_PERIODS),
  quota_period_hours: z.number().int().min(1).max(24 * 31),
  quota_reset_day: z.number().int().min(1).max(28),
  quota_reset_hour: z.number().int().min(0).max(23),
  policy_on_exhaustion: z.enum(EXHAUSTION_POLICIES),
  monthly_cost_limit_usd: nullableNumber,
  max_concurrent: z.number().int().min(1).max(50),
  notes: z.string().max(4000),
};
export const ProviderCreate = z
  .object({ id: slug.transform((s) => s.toLowerCase()), type: z.string().min(1), ...providerFields })
  .partial()
  .required({ id: true, name: true, type: true });
export const ProviderUpdate = z.object(providerFields).partial();
export const SecretUpdate = z.object({ value: z.string().max(4000).nullable() });

const modelFields = {
  model_name: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(120),
  tier: z.enum(CAPABILITIES),
  context_window: z.number().int().min(1000).max(10_000_000),
  max_output_tokens: z.number().int().min(256).max(1_000_000),
  input_price_per_mtok: z.number().min(0),
  output_price_per_mtok: z.number().min(0),
  supports_effort: z.boolean(),
  enabled: z.boolean(),
  sort_order: z.number().int(),
};
export const ModelCreate = z.object({ provider_id: z.string(), ...modelFields }).partial().required({ provider_id: true, model_name: true, tier: true });
export const ModelUpdate = z.object(modelFields).partial();

export const JobCreate = z.object({
  type: z.string(),
  agent_id: z.string().nullable().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  priority: z.number().int().min(0).max(3).optional(),
  opportunity_id: z.string().nullable().optional(),
  task_id: z.string().nullable().optional(),
  policy_override: z.enum(PROVIDER_POLICIES).nullable().optional(),
});
export const JobUpdate = z.object({
  priority: z.number().int().min(0).max(3).optional(),
  agent_id: z.string().optional(),
  policy_override: z.enum(PROVIDER_POLICIES).nullable().optional(),
});

const sourceSchema = z.object({ title: z.string(), url: z.string(), note: z.string().optional() });
export const OpportunityCreate = z.object({
  title: z.string().trim().min(1).max(200),
  problem: z.string().max(5000).optional(),
  target_customer: z.string().max(2000).optional(),
  proposed_solution: z.string().max(5000).optional(),
  revenue_model: z.string().max(2000).optional(),
  notes: z.string().max(10000).optional(),
  sources: z.array(sourceSchema).optional(),
  screen: z.boolean().optional(),
});
export const OpportunityUpdate = z
  .object({
    title: z.string().trim().min(1).max(200),
    problem: z.string().max(5000),
    target_customer: z.string().max(2000),
    proposed_solution: z.string().max(5000),
    competition_summary: z.string().max(5000),
    revenue_model: z.string().max(2000),
    notes: z.string().max(10000),
    sources: z.array(sourceSchema),
  })
  .partial();
export const ActionBody = z.object({ action: z.string(), note: z.string().max(5000).nullable().optional() });

export const TaskCreate = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5000).optional(),
  acceptance_criteria: z.array(z.string()).optional(),
  depends_on: z.array(z.string()).optional(),
});
export const TaskUpdate = TaskCreate.partial();

export const ApprovalDecision = z.object({ decision: z.enum(['APPROVED', 'REJECTED']), note: z.string().max(5000).nullable().optional() });

const scheduleFields = {
  name: z.string().trim().min(1).max(120),
  job_type: z.string(),
  agent_id: z.string().nullable(),
  input: z.record(z.string(), z.unknown()),
  priority: z.number().int().min(0).max(3),
  kind: z.enum(SCHEDULE_KINDS),
  interval_minutes: z.number().int().min(5).nullable(),
  time_of_day: z
    .string()
    .regex(/^\d{1,2}:\d{2}$/)
    .nullable(),
  weekday: z.number().int().min(1).max(7).nullable(),
  day_of_month: z.number().int().min(1).max(28).nullable(),
  enabled: z.boolean(),
};
export const ScheduleCreate = z.object(scheduleFields).partial().required({ name: true, job_type: true, kind: true });
export const ScheduleUpdate = z.object(scheduleFields).partial();

export const SettingsUpdate = z
  .object({
    company_name: z.string().trim().min(1).max(80),
    output_language: z.string().trim().min(2).max(40),
    engine_paused: z.boolean(),
    max_concurrent_jobs: z.number().int().min(1).max(20),
    system_monthly_budget_usd: nullableNumber,
    budget_warning_pct: z.number().min(1).max(100),
    auto_screening: z.boolean(),
    deep_research_threshold: z.number().min(0).max(100),
    proposal_threshold: z.number().min(0).max(100),
    auto_start_development: z.boolean(),
    max_tasks_per_project: z.number().int().min(1).max(30),
    max_rework_rounds: z.number().int().min(0).max(10),
    scan_default_count: z.number().int().min(1).max(10),
    score_weight_market: z.number().min(0).max(10),
    score_weight_technical: z.number().min(0).max(10),
    score_weight_risk: z.number().min(0).max(10),
    artifact_context_chars: z.number().int().min(500).max(100_000),
    job_max_attempts: z.number().int().min(1).max(10),
  })
  .partial();

export const MemoryWrite = z.object({ path: z.string().min(3).max(300), content: z.string().max(500_000) });

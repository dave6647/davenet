import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { JOB_STATUSES, OPPORTUNITY_STATUSES, type JobStatus, type OpportunityStatus, type StrategyStatus } from '../../shared/domain.ts';
import type { App } from '../app.ts';
import { jobType, jobTypeInfos } from '../engine/jobtypes/index.ts';
import { MEMORY_AREAS, OWNER_EDITABLE_AREAS } from '../engine/memory.ts';
import { monthStart } from '../engine/quota.ts';
import { computeNextRun, describeSchedule } from '../engine/triggers.ts';
import { Workspace } from '../engine/workspace.ts';
import { providerTypeInfo, providerTypes } from '../providers/registry.ts';
import { LEDGER_GROUPS, type LedgerGroup } from '../repo/ledger.ts';
import { ConflictError, NotFoundError, ValidationError } from '../repo/util.ts';
import * as S from './schemas.ts';

type Params = { id: string };
type Query = Record<string, string | undefined>;

const csv = <T extends string>(v: string | undefined, allowed: readonly T[]): T[] | undefined => {
  if (!v) return undefined;
  const list = v.split(',').filter((x): x is T => (allowed as readonly string[]).includes(x));
  return list.length ? list : undefined;
};
const int = (v: string | undefined, def: number, max = 1000): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(max, Math.floor(n)) : def;
};

type OverviewAlert = { level: 'info' | 'warn' | 'error'; text: string; link?: string };

/** Hinweise zur Unternehmensstrategie: Vorlage, Kürzung durch das Kontextlimit, veraltete Kurzfassung. */
function strategyAlerts(s: StrategyStatus): OverviewAlert[] {
  const link = (file: string) => `#/memory?file=${file}`;
  const n = (v: number) => v.toLocaleString('de-DE');
  if (s.source !== 'summary' && s.full.template) {
    return [{ level: 'info', text: 'Die Unternehmensstrategie ist noch die Vorlage – bitte ausfüllen, damit Scout & Analyst passende Ergebnisse liefern', link: link(s.full.path) }];
  }
  const out: OverviewAlert[] = [];
  if (s.summary.ignored) {
    out.push({ level: 'warn', text: 'Die Strategie-Kurzfassung ist fast leer und wird ignoriert – die Agents erhalten die Langfassung', link: link(s.summary.path) });
  }
  if (s.truncated && s.source === 'summary') {
    out.push({ level: 'warn', text: `Die Strategie-Kurzfassung ist länger als das Kontextlimit (${n(s.summary.chars)} von ${n(s.limit)} Zeichen) – die Agents sehen nur den Anfang`, link: link(s.summary.path) });
  } else if (s.truncated) {
    out.push({
      level: 'warn',
      text: `Die Strategie ist länger als das Kontextlimit (${n(s.full.chars)} von ${n(s.limit)} Zeichen) – die Agents sehen nur den Anfang. Lege eine Kurzfassung an oder erhöhe das Limit in den Einstellungen`,
      link: link(s.full.path),
    });
  }
  if (s.summary_outdated) {
    out.push({ level: 'info', text: 'Die Strategie wurde nach der Kurzfassung geändert – die Agents arbeiten noch mit der alten Kurzfassung. Bitte prüfen und speichern', link: link(s.summary.path) });
  }
  return out;
}

export function registerRoutes(http: FastifyInstance, app: App, version: string): void {
  const { store, orch } = app;

  // ---------------------------------------------------------------- Meta & Übersicht

  http.get('/api/meta', async () => ({
    version,
    job_types: jobTypeInfos(),
    provider_types: providerTypes(),
    memory_areas: MEMORY_AREAS,
    owner_editable_areas: OWNER_EDITABLE_AREAS,
    data_dir: app.dataDir,
  }));

  http.get('/api/overview', async () => {
    const now = new Date();
    const providers = orch.providerViews(now);
    const jobs = store.jobs.countByStatus();
    const budget = orch.systemBudget(now);
    const alerts: OverviewAlert[] = [];
    const pending = store.approvals.pendingCount();
    if (pending) alerts.push({ level: 'warn', text: `${pending} Freigabe(n) warten auf deine Entscheidung`, link: '#/approvals' });
    for (const p of providers.filter((x) => x.enabled)) {
      if (p.quota.exhausted) alerts.push({ level: 'warn', text: `${p.name}: Kontingent erschöpft bis ${p.quota.exhausted_until ?? 'unbekannt'}`, link: '#/providers' });
      if (p.quota.cost_limit_reached) alerts.push({ level: 'error', text: `${p.name}: monatliches Kostenlimit erreicht`, link: '#/providers' });
      if (p.health_status === 'error') alerts.push({ level: 'error', text: `${p.name}: ${p.health_message ?? 'Fehler'}`, link: '#/providers' });
    }
    if (!providers.some((p) => p.enabled)) alerts.push({ level: 'error', text: 'Kein Provider aktiv – Agents können nicht arbeiten', link: '#/providers' });
    if (jobs.BLOCKED) alerts.push({ level: 'error', text: `${jobs.BLOCKED} Job(s) blockiert – Eingreifen nötig`, link: '#/jobs?status=BLOCKED' });
    if (budget.exceeded) alerts.push({ level: 'error', text: `Systembudget ausgeschöpft ($${budget.spent.toFixed(2)} / $${budget.limit})`, link: '#/finance' });
    else if (budget.warning) alerts.push({ level: 'warn', text: `Budget-Schwelle erreicht (${budget.pct?.toFixed(0)} %) – nur noch Jobs mit hoher Priorität auf kostenpflichtigen Providern`, link: '#/finance' });
    alerts.push(...strategyAlerts(app.memory.strategyStatus(orch.settings.strategy_context_chars)));
    if (orch.settings.engine_paused) alerts.push({ level: 'warn', text: 'Die Engine ist pausiert – es starten keine neuen Jobs' });
    return {
      company_name: orch.settings.company_name,
      engine: { paused: orch.settings.engine_paused, running: app.scheduler.runner.runningCount, max_concurrent: orch.settings.max_concurrent_jobs },
      jobs,
      opportunities: store.opportunities.countByStatus(),
      approvals_pending: pending,
      budget,
      month: store.ledger.totals({ since: monthStart(now).toISOString() }),
      providers,
      recent_jobs: store.jobs.list({ limit: 12 }).items,
      recent_audit: store.audit.list({ limit: 15 }).items,
      alerts,
    };
  });

  http.get('/api/engine', async () => ({
    paused: orch.settings.engine_paused,
    running: app.scheduler.runner.runningCount,
    max_concurrent: orch.settings.max_concurrent_jobs,
    pending_approvals: store.approvals.pendingCount(),
  }));
  http.post('/api/engine/pause', async () => {
    store.settings.update({ engine_paused: true });
    orch.audit('owner', 'engine.paused', null, null, 0, {});
    orch.changed('settings');
    return { paused: true };
  });
  http.post('/api/engine/resume', async () => {
    store.settings.update({ engine_paused: false });
    orch.audit('owner', 'engine.resumed', null, null, 0, {});
    orch.changed('settings');
    app.bus.emit('scheduler.wake');
    return { paused: false };
  });

  // ---------------------------------------------------------------- Organisation

  http.get('/api/departments', async () => store.departments.list());
  http.post('/api/departments', async (req) => {
    const d = store.departments.create(S.DepartmentCreate.parse(req.body));
    orch.audit('owner', 'department.created', 'department', d.id, 0, { name: d.name });
    orch.changed('department', d.id);
    return d;
  });
  http.put('/api/departments/:id', async (req) => {
    const { id } = req.params as Params;
    const d = store.departments.update(id, S.DepartmentUpdate.parse(req.body));
    orch.audit('owner', 'department.updated', 'department', id, 0, {});
    orch.changed('department', id);
    return d;
  });
  http.delete('/api/departments/:id', async (req) => {
    const { id } = req.params as Params;
    store.departments.delete(id);
    orch.audit('owner', 'department.deleted', 'department', id, 1, {});
    orch.changed('department', id);
    return { ok: true };
  });

  http.get('/api/agents', async () => {
    const since = monthStart(new Date()).toISOString();
    const spend = new Map(store.ledger.grouped('agent_id', { since }).map((r) => [r.key, r]));
    return store.agents.list().map((a) => ({ ...a, month: spend.get(a.id) ?? null }));
  });
  http.get('/api/agents/:id', async (req) => {
    const { id } = req.params as Params;
    const agent = store.agents.require(id);
    const since = monthStart(new Date()).toISOString();
    return {
      agent,
      month: store.ledger.totals({ since, agent_id: id }),
      total: store.ledger.totals({ agent_id: id }),
      jobs: store.jobs.list({ agent_id: id, limit: 20 }).items,
      routes: store.routes.list().filter((r) => r.agent_id === id),
      candidates: app.scheduler.runner.router.candidates(agent).map((c) => ({
        provider: { id: c.provider.id, name: c.provider.name },
        models: c.models.map((m) => ({ id: m.id, label: m.label, tier: m.tier })),
      })),
    };
  });
  http.post('/api/agents', async (req) => {
    const body = S.AgentCreate.parse(req.body);
    if (body.department_id) store.departments.require(body.department_id);
    const a = store.agents.create(body);
    orch.audit('owner', 'agent.created', 'agent', a.id, 0, { name: a.name });
    orch.changed('agent', a.id);
    return a;
  });
  http.put('/api/agents/:id', async (req) => {
    const { id } = req.params as Params;
    const body = S.AgentUpdate.parse(req.body);
    if (body.department_id) store.departments.require(body.department_id);
    const a = store.agents.update(id, body);
    orch.audit('owner', 'agent.updated', 'agent', id, 0, { fields: Object.keys(body) });
    orch.changed('agent', id);
    // Blockierte Jobs dieses Agents (z. B. wegen fehlendem Modell oder Deaktivierung) neu prüfen
    store.jobs.unblock();
    app.bus.emit('scheduler.wake');
    return a;
  });
  http.delete('/api/agents/:id', async (req) => {
    const { id } = req.params as Params;
    const open = store.jobs.list({ agent_id: id, status: ['RUNNING'] }).total;
    if (open) throw new ConflictError('Agent bearbeitet gerade einen Job – erst abbrechen oder abwarten');
    store.agents.delete(id);
    orch.audit('owner', 'agent.deleted', 'agent', id, 1, {});
    orch.changed('agent', id);
    return { ok: true };
  });

  http.get('/api/routes', async () => {
    const routes = new Map(store.routes.list().map((r) => [r.job_type, r]));
    return jobTypeInfos()
      .filter((t) => t.key !== 'custom')
      .map((t) => ({ ...t, route: routes.get(t.key) ?? { job_type: t.key, agent_id: t.default_agent, capability_override: null, enabled: true, updated_at: '' } }));
  });
  http.put('/api/routes/:id', async (req) => {
    const { id } = req.params as Params;
    if (!jobType(id) || id === 'custom') throw new NotFoundError(`Job-Typ ${id}`);
    const body = S.RouteUpdate.parse(req.body);
    if (body.agent_id) store.agents.require(body.agent_id);
    const r = store.routes.upsert({ job_type: id, ...body });
    orch.audit('owner', 'route.updated', 'job_type', id, 0, { ...body });
    orch.changed('route', id);
    return r;
  });

  // ---------------------------------------------------------------- Provider & Modelle

  http.get('/api/providers', async () => orch.providerViews());
  http.get('/api/providers/:id', async (req) => {
    const { id } = req.params as Params;
    return { provider: orch.providerView(id), models: store.models.list(id), type: providerTypeInfo(store.providers.require(id).type) ?? null };
  });
  http.post('/api/providers', async (req) => {
    const body = S.ProviderCreate.parse(req.body);
    const type = providerTypeInfo(body.type);
    if (!type) throw new ValidationError(`Unbekannter Provider-Typ ${body.type}`);
    const p = store.providers.create({ billing_mode: type.billing_mode_default, ...body });
    orch.audit('owner', 'provider.created', 'provider', p.id, 1, { type: p.type });
    orch.changed('provider', p.id);
    return p;
  });
  http.put('/api/providers/:id', async (req) => {
    const { id } = req.params as Params;
    const body = S.ProviderUpdate.parse(req.body);
    const before = store.providers.require(id);
    if (body.config) body.config = { ...before.config, ...body.config };
    const p = store.providers.update(id, body);
    // Kostenrelevante Änderungen (neuer Pay-as-you-go-Dienst, Limits) haben Level 1 im Audit-Log
    orch.audit('owner', 'provider.updated', 'provider', id, body.billing_mode === 'pay_as_you_go' || body.enabled ? 1 : 0, { fields: Object.keys(body) });
    orch.providerChanged(id);
    orch.changed('provider', id);
    return p;
  });
  http.delete('/api/providers/:id', async (req) => {
    const { id } = req.params as Params;
    if (store.jobs.runningCountByProvider()[id]) throw new ConflictError('Provider bearbeitet gerade Jobs');
    store.providers.delete(id);
    app.secrets.deleteScope(id);
    orch.audit('owner', 'provider.deleted', 'provider', id, 1, {});
    orch.changed('provider', id);
    return { ok: true };
  });
  http.post('/api/providers/:id/test', async (req) => orch.testProvider((req.params as Params).id));
  http.post('/api/providers/:id/reset-quota', async (req) => {
    orch.resetProviderQuota((req.params as Params).id);
    return { ok: true };
  });
  http.put('/api/providers/:id/secret', async (req) => {
    const { id } = req.params as Params;
    store.providers.require(id);
    const { value } = S.SecretUpdate.parse(req.body);
    app.secrets.set(id, 'api_key', value?.trim() || null);
    // Zugangsdaten = Level 3: nur der Owner, immer protokolliert (ohne Wert)
    orch.audit('owner', value ? 'secret.set' : 'secret.removed', 'provider', id, 3, {});
    orch.providerChanged(id);
    orch.changed('provider', id);
    return { ok: true };
  });

  http.get('/api/models', async () => store.models.list());
  http.post('/api/models', async (req) => {
    const body = S.ModelCreate.parse(req.body);
    store.providers.require(body.provider_id);
    const m = store.models.create(body);
    orch.audit('owner', 'model.created', 'model', m.id, 0, { tier: m.tier });
    orch.changed('provider', m.provider_id);
    store.jobs.unblock({ provider_id: m.provider_id });
    return m;
  });
  http.put('/api/models/:id', async (req) => {
    const { id } = req.params as Params;
    const m = store.models.update(id, S.ModelUpdate.parse(req.body));
    orch.audit('owner', 'model.updated', 'model', id, 0, {});
    orch.changed('provider', m.provider_id);
    store.jobs.unblock();
    app.bus.emit('scheduler.wake');
    return m;
  });
  http.delete('/api/models/:id', async (req) => {
    const { id } = req.params as Params;
    const m = store.models.require(id);
    store.models.delete(id);
    orch.audit('owner', 'model.deleted', 'model', id, 0, {});
    orch.changed('provider', m.provider_id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- Jobs

  http.get('/api/jobs', async (req) => {
    const q = req.query as Query;
    return store.jobs.list({
      status: csv<JobStatus>(q.status, JOB_STATUSES),
      type: q.type || undefined,
      agent_id: q.agent_id || undefined,
      opportunity_id: q.opportunity_id || undefined,
      limit: int(q.limit, 50, 500),
      offset: int(q.offset, 0, 1_000_000),
    });
  });
  http.get('/api/jobs/:id', async (req) => {
    const id = Number((req.params as Params).id);
    const job = store.jobs.require(id);
    return {
      job,
      usage: store.ledger.list({ job_id: id, limit: 200 }).items,
      artifacts: store.artifacts.list({ job_id: id }),
      children: store.jobs.list({ limit: 50 }).items.filter((j) => j.parent_job_id === id),
      approvals: store.approvals.list({ limit: 50 }).filter((a) => a.job_id === id),
    };
  });
  http.post('/api/jobs', async (req) => {
    const body = S.JobCreate.parse(req.body);
    const def = jobType(body.type);
    if (!def || !def.manual) throw new ValidationError('Dieser Job-Typ kann nicht manuell angelegt werden');
    for (const f of def.inputFields) {
      if (f.required && !String(body.input?.[f.key] ?? '').trim()) throw new ValidationError(`Feld "${f.label}" fehlt`);
    }
    if (body.agent_id) store.agents.require(body.agent_id);
    if (body.type === 'deep_research' && body.opportunity_id) {
      const o = store.opportunities.require(body.opportunity_id);
      if (!['REJECTED', 'DEPLOYED'].includes(o.status)) orch.setOpportunityStatus(o.id, 'RESEARCH', 'manueller Auftrag');
    }
    return orch.createJob({ ...body, created_by: 'owner' });
  });
  http.put('/api/jobs/:id', async (req) => {
    const id = Number((req.params as Params).id);
    const job = store.jobs.require(id);
    if (job.status === 'RUNNING') throw new ConflictError('Laufende Jobs können nicht geändert werden');
    const body = S.JobUpdate.parse(req.body);
    if (body.agent_id) store.agents.require(body.agent_id);
    const updated = store.jobs.update(id, body);
    store.jobs.appendLog(id, 'info', `Vom Owner geändert: ${Object.keys(body).join(', ')}`);
    orch.audit('owner', 'job.updated', 'job', id, 0, { ...body });
    orch.changed('job', id);
    return updated;
  });
  http.post('/api/jobs/:id/cancel', async (req) => orch.cancelJob(Number((req.params as Params).id)));
  http.post('/api/jobs/:id/retry', async (req) => orch.retryJob(Number((req.params as Params).id)));

  // ---------------------------------------------------------------- Opportunities & Tasks

  http.get('/api/opportunities', async (req) => {
    const q = req.query as Query;
    return store.opportunities.list({ status: csv<OpportunityStatus>(q.status, OPPORTUNITY_STATUSES) });
  });
  http.get('/api/opportunities/:id', async (req) => {
    const { id } = req.params as Params;
    const opportunity = store.opportunities.require(id);
    return {
      opportunity,
      tasks: store.tasks.listForOpportunity(id),
      jobs: store.jobs.list({ opportunity_id: id, limit: 200 }).items,
      artifacts: store.artifacts.list({ opportunity_id: id }),
      approvals: store.approvals.list({ opportunity_id: id }),
      usage: store.ledger.list({ opportunity_id: id, limit: 1 }).total ? store.ledger.grouped('opportunity_id').find((r) => r.key === id) ?? null : null,
      workspace: { dir: app.memory.workspaceDir(id), files: orch.workspaceFiles(id) },
    };
  });
  http.get('/api/opportunities/:id/workspace', async (req) => {
    const { id } = req.params as Params;
    store.opportunities.require(id);
    const q = req.query as Query;
    const ws = new Workspace(app.memory.workspaceDir(id), false);
    try {
      return { path: q.path, content: ws.read(String(q.path ?? '')) };
    } catch (e) {
      throw new NotFoundError(`Datei ${q.path ?? ''} (${e instanceof Error ? e.message : String(e)})`);
    }
  });
  http.post('/api/opportunities', async (req) => {
    const { screen, ...body } = S.OpportunityCreate.parse(req.body);
    const opp = orch.createOpportunity(body, 'owner');
    if (screen) orch.opportunityAction(opp.id, 'screen');
    return store.opportunities.require(opp.id);
  });
  http.put('/api/opportunities/:id', async (req) => orch.updateOpportunity((req.params as Params).id, S.OpportunityUpdate.parse(req.body)));
  http.delete('/api/opportunities/:id', async (req) => {
    orch.deleteOpportunity((req.params as Params).id);
    return { ok: true };
  });
  http.post('/api/opportunities/:id/action', async (req) => {
    const { action, note } = S.ActionBody.parse(req.body);
    const id = (req.params as Params).id;
    const res = orch.opportunityAction(id, action, note);
    orch.audit('owner', `opportunity.${action}`, 'opportunity', id, 0, { note });
    return res;
  });
  http.post('/api/opportunities/:id/tasks', async (req) => orch.addTask((req.params as Params).id, S.TaskCreate.parse(req.body)));
  http.put('/api/tasks/:id', async (req) => {
    const { id } = req.params as Params;
    const t = store.tasks.update(id, S.TaskUpdate.parse(req.body));
    orch.audit('owner', 'task.updated', 'task', id, 0, {});
    orch.changed('task', id);
    return t;
  });
  http.post('/api/tasks/:id/action', async (req) => {
    const { action } = S.ActionBody.parse(req.body);
    return orch.taskAction((req.params as Params).id, action);
  });

  // ---------------------------------------------------------------- Freigaben

  http.get('/api/approvals', async (req) => {
    const q = req.query as Query;
    const status = q.status && ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'].includes(q.status) ? (q.status as 'PENDING') : undefined;
    return store.approvals.list({ status, limit: int(q.limit, 200, 1000) });
  });
  http.post('/api/approvals/:id/decide', async (req) => {
    const { decision, note } = S.ApprovalDecision.parse(req.body);
    return orch.decideApproval(Number((req.params as Params).id), decision, note);
  });

  // ---------------------------------------------------------------- Artefakte, Ledger, Audit

  http.get('/api/artifacts', async (req) => {
    const q = req.query as Query;
    return store.artifacts.list({
      opportunity_id: q.opportunity_id || undefined,
      job_id: q.job_id ? Number(q.job_id) : undefined,
      task_id: q.task_id || undefined,
      kind: q.kind || undefined,
      limit: int(q.limit, 100, 1000),
    });
  });
  http.get('/api/artifacts/:id', async (req) => {
    const artifact = store.artifacts.require(Number((req.params as Params).id));
    return { artifact, content: app.memory.readArtifact(artifact) };
  });

  http.get('/api/ledger/summary', async (req) => {
    const q = req.query as Query;
    const since = q.from || monthStart(new Date()).toISOString();
    const until = q.to || null;
    const groups = Object.fromEntries(
      LEDGER_GROUPS.map((g: LedgerGroup) => [g, store.ledger.grouped(g, { since, until })]),
    );
    return { since, until, totals: store.ledger.totals({ since, until }), groups, budget: orch.systemBudget() };
  });
  http.get('/api/ledger/events', async (req) => {
    const q = req.query as Query;
    return store.ledger.list({
      job_id: q.job_id ? Number(q.job_id) : undefined,
      provider_id: q.provider_id || undefined,
      agent_id: q.agent_id || undefined,
      opportunity_id: q.opportunity_id || undefined,
      limit: int(q.limit, 100, 1000),
      offset: int(q.offset, 0, 1_000_000),
    });
  });

  http.get('/api/audit', async (req) => {
    const q = req.query as Query;
    return store.audit.list({
      entity_type: q.entity_type || undefined,
      entity_id: q.entity_id || undefined,
      actor: q.actor || undefined,
      limit: int(q.limit, 100, 1000),
      offset: int(q.offset, 0, 1_000_000),
    });
  });

  // ---------------------------------------------------------------- Zeit-Trigger

  const scheduleView = (s: ReturnType<typeof store.schedules.require>) => ({ ...s, description: describeSchedule(s) });
  http.get('/api/schedules', async () => store.schedules.list().map(scheduleView));
  http.post('/api/schedules', async (req) => {
    const body = S.ScheduleCreate.parse(req.body);
    const def = jobType(body.job_type);
    if (!def || def.requiresOpportunity || def.requiresTask) throw new ValidationError('Für Zeit-Trigger nur Job-Typen ohne Opportunity-Bezug');
    if (body.agent_id) store.agents.require(body.agent_id);
    const base = {
      name: body.name,
      job_type: body.job_type,
      agent_id: body.agent_id ?? null,
      input: body.input ?? {},
      priority: body.priority ?? 1,
      kind: body.kind,
      interval_minutes: body.interval_minutes ?? null,
      time_of_day: body.time_of_day ?? '08:00',
      weekday: body.weekday ?? 1,
      day_of_month: body.day_of_month ?? 1,
      enabled: body.enabled ?? false,
    };
    const s = store.schedules.create({ ...base, next_run_at: base.enabled ? computeNextRun(base, new Date())?.toISOString() ?? null : null });
    orch.audit('owner', 'schedule.created', 'schedule', s.id, 0, { name: s.name });
    orch.changed('schedule', s.id);
    return scheduleView(s);
  });
  http.put('/api/schedules/:id', async (req) => {
    const id = Number((req.params as Params).id);
    const body = S.ScheduleUpdate.parse(req.body);
    if (body.job_type) {
      const def = jobType(body.job_type);
      if (!def || def.requiresOpportunity || def.requiresTask) throw new ValidationError('Für Zeit-Trigger nur Job-Typen ohne Opportunity-Bezug');
    }
    const merged = { ...store.schedules.require(id), ...body };
    const s = store.schedules.update(id, { ...body, next_run_at: merged.enabled ? computeNextRun(merged, new Date())?.toISOString() ?? null : null });
    orch.audit('owner', 'schedule.updated', 'schedule', id, 0, { fields: Object.keys(body) });
    orch.changed('schedule', id);
    return scheduleView(s);
  });
  http.delete('/api/schedules/:id', async (req) => {
    const id = Number((req.params as Params).id);
    store.schedules.delete(id);
    orch.audit('owner', 'schedule.deleted', 'schedule', id, 0, {});
    orch.changed('schedule', id);
    return { ok: true };
  });
  http.post('/api/schedules/:id/run', async (req) => {
    const s = store.schedules.require(Number((req.params as Params).id));
    const job = orch.createJob({ type: s.job_type, agent_id: s.agent_id, input: s.input, priority: s.priority, created_by: 'owner' });
    store.schedules.update(s.id, { last_run_at: new Date().toISOString() });
    orch.changed('schedule', s.id);
    return job;
  });

  // ---------------------------------------------------------------- Einstellungen

  http.get('/api/settings', async () => orch.settings);
  http.put('/api/settings', async (req) => {
    const body = S.SettingsUpdate.parse(req.body);
    const s = store.settings.update(body);
    orch.audit('owner', 'settings.updated', 'settings', null, 0, { ...body });
    orch.changed('settings');
    store.jobs.unblock();
    app.bus.emit('scheduler.wake');
    return s;
  });

  // ---------------------------------------------------------------- Unternehmensgedächtnis

  http.get('/api/memory/tree', async () => ({
    areas: MEMORY_AREAS,
    editable: OWNER_EDITABLE_AREAS,
    files: app.memory.tree(),
    strategy: app.memory.strategyStatus(orch.settings.strategy_context_chars),
  }));
  http.get('/api/memory/file', async (req) => {
    const p = String((req.query as Query).path ?? '');
    const file = app.memory.resolve(p);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new NotFoundError(`Datei ${p}`);
    return { path: p, content: fs.readFileSync(file, 'utf8').slice(0, 1_000_000) };
  });
  http.put('/api/memory/file', async (req) => {
    const { path: p, content } = S.MemoryWrite.parse(req.body);
    app.memory.ownerWrite(p, content);
    orch.audit('owner', 'memory.updated', 'memory', p, 0, { size: content.length });
    orch.changed('memory');
    return { ok: true };
  });
  http.delete('/api/memory/file', async (req) => {
    const p = String((req.query as Query).path ?? '');
    app.memory.ownerDelete(p);
    orch.audit('owner', 'memory.deleted', 'memory', p, 0, {});
    orch.changed('memory');
    return { ok: true };
  });
}

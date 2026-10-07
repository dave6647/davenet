import fs from 'node:fs';
import path from 'node:path';
import {
  APPROVAL_TYPE_LABELS,
  CRITERIA,
  CRITERION_KEYS,
  FINANCE_KIND_LABELS,
  LEGAL_STATUS_LABELS,
  OPPORTUNITY_STATUS_LABELS,
  PRE_DECISION_STATUSES,
  PORTFOLIO_RECOMMENDATIONS,
  PORTFOLIO_RECOMMENDATION_LABELS,
  PORTFOLIO_STATUSES,
  SLOT_STATUSES,
  TEST_STATUS_LABELS,
  TEST_VERDICT_LABELS,
  type Approval,
  type CriteriaScores,
  type FinanceEntry,
  type FinanceKind,
  type GuardrailStatus,
  type Job,
  type LegalCheck,
  type Opportunity,
  type OpportunityStatus,
  type PortfolioItem,
  type PortfolioRecommendation,
  type ProviderPolicy,
  type ProviderView,
  type Task,
  type TestPlan,
  type TestState,
  type TestVerdict,
} from '../../shared/domain.ts';
import type { EventBus } from '../events.ts';
import { createAdapter, providerKind } from '../providers/registry.ts';
import type { ImageCallResult } from '../providers/types.ts';
import { emptyTotals } from '../repo/finance.ts';
import type { Store } from '../repo/store.ts';
import { ConflictError, NotFoundError, ValidationError } from '../repo/util.ts';
import type { SecretStore } from '../secrets.ts';
import { commitWorkspace } from './git.ts';
import { jobType } from './jobtypes/index.ts';
import { clamp, normalizeTitle } from './jobtypes/common.ts';
import type { CompletionInfo, JobContext } from './jobtypes/types.ts';
import { CompanyMemory, type MemoryArea } from './memory.ts';
import { computeQuota, monthStart, systemBudget } from './quota.ts';
import { cappedScore, criteriaScore, criterionValue, guardrailIssues, knockouts } from './scoring.ts';
import type { ImageRequest } from './jobtypes/schemas.ts';

const localDay = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const eur = (v: number | null | undefined): string => `${(v ?? 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const num = (v: unknown, fallback = 0): number => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/** Testplan aus einer Modellantwort übernehmen (Zahlen bereinigen, Listen begrenzen). */
function cleanPlan(p: TestPlan): TestPlan {
  return {
    hypothesis: String(p.hypothesis ?? '').trim(),
    channel: String(p.channel ?? '').trim(),
    budget_eur: Math.max(0, num(p.budget_eur)),
    owner_hours: Math.max(0, num(p.owner_hours)),
    duration_days: Math.min(180, Math.max(1, Math.round(num(p.duration_days, 30)))),
    metric: String(p.metric ?? '').trim(),
    success_criterion: String(p.success_criterion ?? '').trim(),
    owner_steps: (p.owner_steps ?? []).map(String).filter(Boolean).slice(0, 15),
    materials: (p.materials ?? []).map(String).filter(Boolean).slice(0, 15),
  };
}

function planMarkdown(p: TestPlan): string[] {
  return [
    '| Testplan | |',
    '|---|---|',
    `| Hypothese | ${p.hypothesis.replace(/\|/g, '/')} |`,
    `| Kanal | ${p.channel.replace(/\|/g, '/')} |`,
    `| Budget | ${eur(p.budget_eur)} extern · ${p.owner_hours} Std. Owner-Zeit |`,
    `| Laufzeit | ${p.duration_days} Tage |`,
    `| Messgröße | ${p.metric.replace(/\|/g, '/')} |`,
    `| Erfolgskriterium | ${p.success_criterion.replace(/\|/g, '/')} |`,
    '',
    '**Deine Schritte:**',
    ...(p.owner_steps.length ? p.owner_steps.map((x) => `- ${x}`) : ['- keine']),
    '',
    '**Bereitet Davenet vor:**',
    ...(p.materials.length ? p.materials.map((x) => `- ${x}`) : ['- nichts']),
  ];
}

export interface CreateJobInput {
  type: string;
  agent_id?: string | null;
  input?: Record<string, unknown>;
  priority?: number;
  opportunity_id?: string | null;
  task_id?: string | null;
  parent_job_id?: number | null;
  policy_override?: ProviderPolicy | null;
  created_by?: string;
  /** Bei automatischen Pipeline-Schritten: deaktivierte Job-Typen still überspringen statt Fehler werfen. */
  automatic?: boolean;
}

const OPEN_STATUSES = new Set(['QUEUED', 'RUNNING', 'WAITING_FOR_PROVIDER_QUOTA', 'WAITING_FOR_APPROVAL', 'BLOCKED']);

/**
 * Orchestrator (Konzept §16): verbindet Job-Queue, Pipeline-Logik, Freigaben, Unternehmensgedächtnis und Audit-Trail.
 * Die geschäftskritische Logik liegt hier – unabhängig davon, welche Agent-Runtime/Provider die Jobs ausführt (Konzept §17).
 */
export class Orchestrator {
  constructor(
    readonly store: Store,
    readonly bus: EventBus,
    readonly memory: CompanyMemory,
    readonly secrets: SecretStore,
    readonly dataDir: string,
  ) {}

  get settings() {
    return this.store.settings.get();
  }

  changed(entity: string, id?: string | number, data?: Record<string, unknown>): void {
    this.bus.emit(`${entity}.changed`, entity, id, data);
  }

  audit(actor: string, action: string, entityType: string | null, entityId: string | number | null, level = 0, details: Record<string, unknown> = {}): void {
    this.store.audit.add({ actor, action, entity_type: entityType, entity_id: entityId, level, details });
    this.changed('audit');
  }

  // ================================================================== Jobs

  createJob(c: CreateJobInput): Job | null {
    const def = jobType(c.type);
    if (!def) throw new ValidationError(`Unbekannter Job-Typ: ${c.type}`);
    const route = this.store.routes.get(c.type);
    if (route && !route.enabled) {
      if (c.automatic) {
        this.audit('system', 'job.skipped', 'job_type', c.type, 0, { reason: 'Job-Typ deaktiviert', opportunity_id: c.opportunity_id });
        return null;
      }
      throw new ValidationError(`Job-Typ "${def.label}" ist deaktiviert (Organisation → Zuständigkeiten)`);
    }

    let opportunity: Opportunity | undefined;
    let task: Task | undefined;
    if (c.task_id) {
      task = this.store.tasks.require(c.task_id);
      c.opportunity_id = task.opportunity_id;
    }
    if (c.opportunity_id) opportunity = this.store.opportunities.require(c.opportunity_id);
    if (def.requiresOpportunity && !opportunity) throw new ValidationError(`${def.label} benötigt eine Opportunity`);
    if (def.requiresTask && !task) throw new ValidationError(`${def.label} benötigt eine Task`);

    const agentId = c.agent_id || route?.agent_id || def.defaultAgent;
    const agent = this.store.agents.get(agentId);
    if (!agent) throw new ValidationError(`Kein Agent für "${def.label}" zugeordnet (Organisation → Zuständigkeiten)`);

    // Doppelte offene Jobs desselben Schritts vermeiden (z. B. Doppelklick oder wiederholtes Event)
    if (opportunity && (def.requiresOpportunity || def.requiresTask)) {
      const open = this.store.jobs.openForOpportunity(opportunity.id, c.type).find((j) => (task ? j.task_id === task.id : true));
      if (open) return open;
    }

    const input = { ...(c.input ?? {}) };
    const title = def.title(input, {
      orch: this,
      settings: this.settings,
      opportunityTitle: opportunity ? `${opportunity.id} ${opportunity.title}` : undefined,
      taskTitle: task ? `${task.id} ${task.title}` : undefined,
      opportunity,
      task,
    });
    const job = this.store.jobs.create({
      type: c.type,
      title,
      agent_id: agent.id,
      priority: c.priority ?? agent.priority,
      input,
      opportunity_id: opportunity?.id ?? null,
      task_id: task?.id ?? null,
      parent_job_id: c.parent_job_id ?? null,
      policy_override: c.policy_override ?? null,
      max_attempts: this.settings.job_max_attempts,
      created_by: c.created_by ?? 'system',
      status: agent.enabled ? 'QUEUED' : 'BLOCKED',
    });
    if (!agent.enabled) this.store.jobs.update(job.id, { wait_reason: `Agent ${agent.name} ist deaktiviert` });
    if (task && c.type === 'implementation') this.store.tasks.setStatus(task.id, 'IN_PROGRESS');
    this.audit(c.created_by?.startsWith('owner') ? 'owner' : 'system', 'job.created', 'job', job.id, 0, {
      type: c.type,
      agent: agent.id,
      opportunity_id: opportunity?.id,
      task_id: task?.id,
    });
    this.changed('job', job.id);
    this.bus.emit('scheduler.wake');
    return this.store.jobs.require(job.id);
  }

  cancelJob(id: number, actor = 'owner'): Job {
    const job = this.store.jobs.require(id);
    if (!OPEN_STATUSES.has(job.status)) throw new ConflictError('Job ist bereits beendet');
    // Laufende Jobs bricht der Scheduler über das Abort-Signal ab; der Status wird hier sofort gesetzt.
    this.bus.emit('job.cancel', 'job', id);
    const updated = this.store.jobs.update(id, { status: 'CANCELLED', finished_at: new Date().toISOString(), wait_reason: null });
    this.store.jobs.appendLog(id, 'warn', `Abgebrochen durch ${actor}`);
    for (const a of this.store.approvals.pending(undefined, undefined, id)) this.store.approvals.decide(a.id, 'CANCELLED', 'Job abgebrochen');
    this.onJobEnded(updated, 'abgebrochen');
    this.audit(actor, 'job.cancelled', 'job', id, 0, {});
    this.changed('job', id);
    return updated;
  }

  retryJob(id: number, actor = 'owner'): Job {
    const job = this.store.jobs.require(id);
    if (job.status === 'RUNNING' || job.status === 'QUEUED') throw new ConflictError('Job läuft bereits oder ist eingereiht');
    if (job.status === 'COMPLETED') throw new ConflictError('Abgeschlossene Jobs können nicht wiederholt werden – bitte neuen Job anlegen');
    const updated = this.store.jobs.update(id, {
      status: 'QUEUED',
      attempts: 0,
      error: null,
      wait_reason: null,
      waiting_provider_id: null,
      not_before: null,
      finished_at: null,
    });
    if (job.task_id && job.type === 'implementation') this.store.tasks.setStatus(job.task_id, 'IN_PROGRESS');
    if (job.task_id && job.type === 'review') this.store.tasks.setStatus(job.task_id, 'IN_REVIEW');
    if (job.type === 'screening') {
      for (const oid of (Array.isArray(job.input.opportunity_ids) ? job.input.opportunity_ids : []) as string[]) {
        const o = this.store.opportunities.get(oid);
        if (o && o.status === 'DISCOVERED') this.setOpportunityStatus(o.id, 'SCREENING', null);
      }
    }
    this.store.jobs.appendLog(id, 'info', `Erneut eingereiht durch ${actor}`);
    this.audit(actor, 'job.retried', 'job', id, 0, {});
    this.changed('job', id);
    this.bus.emit('scheduler.wake');
    return updated;
  }

  /** Aufräumen von Pipeline-Zuständen, wenn ein Job endgültig scheitert oder abgebrochen wird. */
  onJobEnded(job: Job, reason: string): void {
    const def = jobType(job.type);
    if (!def?.failed) return;
    const agent = job.agent_id ? this.store.agents.get(job.agent_id) : undefined;
    if (!agent) return;
    try {
      def.failed(this.jobContext(job, agent), reason);
    } catch {
      /* Aufräumen darf den Abbruch nicht verhindern */
    }
  }

  jobContext(job: Job, agent = this.store.agents.require(job.agent_id ?? '')): JobContext {
    return {
      orch: this,
      job,
      agent,
      settings: this.settings,
      opportunity: job.opportunity_id ? this.store.opportunities.get(job.opportunity_id) : undefined,
      task: job.task_id ? this.store.tasks.get(job.task_id) : undefined,
    };
  }

  // ================================================================== Opportunities (Konzept §8)

  setOpportunityStatus(id: string, status: OpportunityStatus, reason: string | null): Opportunity {
    const before = this.store.opportunities.require(id);
    const opp = this.store.opportunities.update(id, { status, status_reason: reason });
    if (before.status !== status) {
      this.audit('system', 'opportunity.status', 'opportunity', id, 0, { from: before.status, to: status, reason });
    }
    this.syncOpportunityFile(opp);
    this.changed('opportunity', id);
    return opp;
  }

  /** Standardisiertes Opportunity-Artefakt (Konzept §9) als Datei im Unternehmensgedächtnis. */
  syncOpportunityFile(o: Opportunity): void {
    const artifact = {
      id: o.id,
      title: o.title,
      problem: o.problem,
      target_customer: o.target_customer,
      proposed_solution: o.proposed_solution,
      competition_summary: o.competition_summary,
      revenue_model: o.revenue_model,
      market_score: o.market_score ?? 0,
      technical_score: o.technical_score ?? 0,
      risk_score: o.risk_score ?? 0,
      criteria: o.criteria,
      knockouts: o.knockouts,
      legal: o.legal,
      test: o.test,
      fixed_costs_eur_month: o.fixed_costs_eur_month,
      confidence: o.confidence ?? 0,
      score: o.score,
      sources: o.sources,
      status: o.status,
      status_reason: o.status_reason,
      updated_at: o.updated_at,
    };
    try {
      this.memory.writeFile(`opportunities/${o.id}/opportunity.json`, JSON.stringify(artifact, null, 2));
    } catch {
      /* Dateisystemfehler dürfen die Pipeline nicht stoppen */
    }
  }

  createOpportunity(data: Partial<Opportunity> & { title: string }, actor = 'owner'): Opportunity {
    const opp = this.store.opportunities.create({ ...data, status: 'DISCOVERED', origin: actor === 'owner' ? 'owner' : data.origin ?? 'scout' });
    this.syncOpportunityFile(opp);
    this.audit(actor, 'opportunity.created', 'opportunity', opp.id, 0, { title: opp.title });
    this.changed('opportunity', opp.id);
    return opp;
  }

  updateOpportunity(id: string, patch: Partial<Opportunity>, actor = 'owner'): Opportunity {
    const allowed: (keyof Opportunity)[] = [
      'title',
      'problem',
      'target_customer',
      'proposed_solution',
      'competition_summary',
      'revenue_model',
      'notes',
      'sources',
      'fixed_costs_eur_month',
    ];
    const clean: Partial<Opportunity> = {};
    for (const k of allowed) if (k in patch) (clean as Record<string, unknown>)[k] = patch[k];
    const opp = this.store.opportunities.update(id, clean);
    this.syncOpportunityFile(opp);
    this.audit(actor, 'opportunity.updated', 'opportunity', id, 0, { fields: Object.keys(clean) });
    this.changed('opportunity', id);
    return opp;
  }

  /** Owner-Aktionen auf einer Opportunity (manuelles Eingreifen in die Pipeline). */
  opportunityAction(id: string, action: string, note?: string | null): { opportunity: Opportunity; job?: Job | null } {
    const opp = this.store.opportunities.require(id);
    const reason = note?.trim() || null;
    switch (action) {
      case 'screen': {
        this.setOpportunityStatus(id, 'SCREENING', null);
        const job = this.createJob({ type: 'screening', input: { opportunity_ids: [id] }, opportunity_id: id, created_by: 'owner' });
        return { opportunity: this.store.opportunities.require(id), job };
      }
      case 'research': {
        this.setOpportunityStatus(id, 'RESEARCH', null);
        const job = this.createJob({ type: 'deep_research', opportunity_id: id, input: reason ? { focus: reason } : {}, created_by: 'owner' });
        return { opportunity: this.store.opportunities.require(id), job };
      }
      case 'evaluate': {
        this.setOpportunityStatus(id, 'EVALUATION', null);
        const job = this.createJob({ type: 'evaluation', opportunity_id: id, created_by: 'owner' });
        return { opportunity: this.store.opportunities.require(id), job };
      }
      case 'propose':
        // Bau direkt vorschlagen (ohne Nachfragetest oder nach bestandenem Test)
        return { opportunity: this.propose(id, 'owner') };
      case 'propose_test':
        return { opportunity: this.proposeTest(id, 'owner') };
      case 'test_live':
        return { opportunity: this.markTestLive(id) };
      case 'test_result': {
        if (!reason) throw new ValidationError('Bitte das Ergebnis des Tests beschreiben (Zahlen, Beobachtungen)');
        return this.recordTestResult(id, reason);
      }
      case 'stop':
        return { opportunity: this.stopOpportunity(id, reason ?? 'vom Owner beendet', 'owner') };
      case 'plan': {
        if (!['APPROVED', 'DEVELOPMENT', 'REVIEW', 'READY'].includes(opp.status)) {
          throw new ConflictError('Planung erst nach Owner-Freigabe des Projektstarts');
        }
        const job = this.createJob({ type: 'technical_planning', opportunity_id: id, input: reason ? { notes: reason } : {}, created_by: 'owner' });
        return { opportunity: opp, job };
      }
      case 'start_development': {
        if (!['DEVELOPMENT', 'REVIEW', 'APPROVED'].includes(opp.status)) throw new ConflictError('Opportunity ist nicht in der Entwicklung');
        this.startDevelopment(id, 'owner');
        return { opportunity: this.store.opportunities.require(id) };
      }
      case 'request_release': {
        this.requestRelease(id);
        return { opportunity: this.store.opportunities.require(id) };
      }
      case 'reject':
        this.cancelOpenWork(id);
        return { opportunity: this.setOpportunityStatus(id, 'REJECTED', reason ?? 'vom Owner verworfen') };
      case 'evaluate_test': {
        // erneute Auswertung, z. B. nach Ergänzung von Einnahmen
        if (!opp.test?.result) throw new ConflictError('Zuerst das Testergebnis erfassen');
        const job = this.createJob({ type: 'test_evaluation', opportunity_id: id, created_by: 'owner' });
        return { opportunity: opp, job };
      }
      case 'hold':
        return { opportunity: this.setOpportunityStatus(id, 'ON_HOLD', reason ?? 'vom Owner zurückgestellt') };
      case 'reopen':
        return { opportunity: this.setOpportunityStatus(id, 'DISCOVERED', reason) };
      default:
        throw new ValidationError(`Unbekannte Aktion: ${action}`);
    }
  }

  private cancelOpenWork(oppId: string, exceptApprovalId?: number): void {
    for (const j of this.store.jobs.openForOpportunity(oppId)) {
      if (j.status !== 'RUNNING') this.cancelJob(j.id, 'system');
    }
    for (const a of this.store.approvals.pending(undefined, oppId)) {
      if (a.id !== exceptApprovalId) this.store.approvals.decide(a.id, 'CANCELLED', 'Opportunity beendet oder verworfen');
    }
  }

  deleteOpportunity(id: string): void {
    this.cancelOpenWork(id);
    this.store.opportunities.delete(id);
    this.audit('owner', 'opportunity.deleted', 'opportunity', id, 1, {});
    this.changed('opportunity', id);
  }

  // ---------------------------------------------------------------- Pipeline: Scan & Screening

  applyScan(ctx: JobContext, out: { summary: string; opportunities: { title: string; problem: string; target_customer: string; proposed_solution: string; revenue_model: string; rationale: string; sources: { title: string; url: string; note?: string }[] }[] }): void {
    const known = new Set(this.store.opportunities.titles(5000).map((o) => normalizeTitle(o.title)));
    const created: Opportunity[] = [];
    const skipped: string[] = [];
    for (const o of out.opportunities.slice(0, 10)) {
      const title = (o.title ?? '').trim();
      if (!title) continue;
      const norm = normalizeTitle(title);
      if (known.has(norm)) {
        skipped.push(title);
        continue;
      }
      known.add(norm);
      const opp = this.store.opportunities.create({
        title,
        problem: o.problem,
        target_customer: o.target_customer,
        proposed_solution: o.proposed_solution,
        revenue_model: o.revenue_model,
        sources: (o.sources ?? []).filter((s) => s && s.url).slice(0, 10),
        notes: o.rationale ? `Begründung des Scouts: ${o.rationale}` : '',
        origin: ctx.job.created_by.startsWith('job:') ? 'directive' : 'scout',
        created_by_job_id: ctx.job.id,
      });
      this.syncOpportunityFile(opp);
      created.push(opp);
    }
    const md = [
      `# ${ctx.job.title}`,
      '',
      out.summary,
      '',
      '## Neue Kandidaten',
      ...(created.length ? created.map((o) => `- **${o.id} ${o.title}** – ${o.problem.slice(0, 200)}`) : ['(keine neuen)']),
      ...(skipped.length ? ['', '## Übersprungen (bereits bekannt)', ...skipped.map((t) => `- ${t}`)] : []),
    ].join('\n');
    this.memory.saveArtifact(this.store, {
      area: 'research',
      kind: 'scan_report',
      title: ctx.job.title,
      content: md,
      summary: `${created.length} neue Kandidaten. ${out.summary}`,
      job_id: ctx.job.id,
      agent_id: ctx.agent.id,
    });
    this.audit(`agent:${ctx.agent.id}`, 'opportunity.discovered', 'job', ctx.job.id, 0, { created: created.map((o) => o.id), skipped: skipped.length });
    this.changed('opportunity');
    this.onOpportunitiesDiscovered(created.map((o) => o.id), ctx.job);
  }

  onOpportunitiesDiscovered(ids: string[], parent?: Job): void {
    if (!ids.length || !this.settings.auto_screening) return;
    for (const id of ids) this.setOpportunityStatus(id, 'SCREENING', null);
    const job = this.createJob({
      type: 'screening',
      input: { opportunity_ids: ids },
      opportunity_id: ids.length === 1 ? ids[0] : null,
      parent_job_id: parent?.id ?? null,
      automatic: true,
    });
    if (!job) for (const id of ids) this.setOpportunityStatus(id, 'DISCOVERED', 'Screening ist deaktiviert');
  }

  /** Übernimmt Kriterien-Werte (0–10) aus einer Modellantwort. */
  private cleanCriteria(raw: Record<string, unknown> | undefined, withNotes: boolean): CriteriaScores {
    const out: CriteriaScores = {};
    for (const key of CRITERION_KEYS) {
      const v = raw?.[key] as number | { score?: number; note?: string } | undefined;
      const score = clamp(typeof v === 'number' ? v : v?.score, 0, 10);
      if (score == null) continue;
      out[key] = { score: Math.round(score * 10) / 10, note: withNotes && typeof v === 'object' ? String(v?.note ?? '').slice(0, 300) : '' };
    }
    return out;
  }

  private criteriaTable(c: CriteriaScores): string[] {
    return [
      '| Kriterium | Wert | Begründung |',
      '|---|---|---|',
      ...CRITERIA.map((k) => `| ${k.label} | ${c[k.key]?.score ?? '–'} | ${(c[k.key]?.note ?? '').replace(/\|/g, '/')} |`),
    ];
  }

  applyScreening(
    ctx: JobContext,
    out: { results: { id: string; decision: 'PASS' | 'REJECT'; criteria: Record<string, number>; legal_flag: 'ok' | 'check' | 'red'; legal_note: string; reason: string }[] },
  ): void {
    const ids = (Array.isArray(ctx.job.input.opportunity_ids) ? ctx.job.input.opportunity_ids : []) as string[];
    const threshold = this.settings.deep_research_threshold;
    const seen = new Set<string>();
    for (const r of out.results) {
      const id = String(r.id ?? '').trim().toUpperCase();
      if (!ids.includes(id) || seen.has(id)) continue;
      seen.add(id);
      const opp = this.store.opportunities.get(id);
      if (!opp || !['SCREENING', 'DISCOVERED'].includes(opp.status)) continue;
      const criteria = this.cleanCriteria(r.criteria, false);
      const legal: LegalCheck | null =
        opp.legal?.source === 'research'
          ? opp.legal
          : {
              status: r.legal_flag === 'red' ? 'red' : r.legal_flag === 'check' ? 'yellow' : 'green',
              how_possible: String(r.legal_note ?? '').trim() || (r.legal_flag === 'ok' ? 'Im Screening keine rechtlichen Hürden erkennbar (vorläufig).' : ''),
              effort_one_time_hours: null,
              effort_one_time_eur: null,
              effort_ongoing_hours_month: null,
              effort_ongoing_eur_month: null,
              steps: [],
              open_questions: [],
              source: 'screening',
              checked_at: new Date().toISOString(),
            };
      const ko = knockouts(criteria, legal, null, this.settings);
      const score = cappedScore(criteriaScore(criteria, this.settings.criteria_weights), ko);
      this.store.opportunities.update(id, { criteria, knockouts: ko, legal, score });
      this.memory.saveArtifact(this.store, {
        area: 'opportunities',
        kind: 'screening_note',
        title: `Screening ${id}`,
        content: [
          `# Screening ${id}`,
          '',
          `Entscheidung: **${r.decision}** – Score ${score ?? '–'} (Schwelle ${threshold})`,
          ko.length ? `\n**K.-o.:** ${ko.join('; ')}` : '',
          '',
          r.reason,
          '',
          `Rechtlich (vorläufig): ${legal ? LEGAL_STATUS_LABELS[legal.status] : '–'}${legal?.how_possible ? ` – ${legal.how_possible}` : ''}`,
          '',
          ...this.criteriaTable(criteria),
        ].join('\n'),
        summary: `${r.decision}, Score ${score}${ko.length ? ` (K.-o.: ${ko.join('; ')})` : ''}: ${r.reason}`,
        job_id: ctx.job.id,
        agent_id: ctx.agent.id,
        opportunity_id: id,
      });
      if (r.decision === 'PASS' && !ko.length && score != null && score >= threshold) {
        // Konzept §15: "Opportunity score > threshold -> Deep Research"
        this.setOpportunityStatus(id, 'RESEARCH', `Screening bestanden (Score ${score})`);
        this.createJob({ type: 'deep_research', opportunity_id: id, parent_job_id: ctx.job.id, automatic: true });
      } else {
        const why = ko.length ? `K.-o.: ${ko.join('; ')}` : r.decision === 'PASS' ? `Score ${score} unter Schwelle ${threshold}` : 'Screening: abgelehnt';
        this.setOpportunityStatus(id, 'REJECTED', `${why} – ${r.reason}`.slice(0, 500));
      }
    }
    for (const id of ids) {
      if (seen.has(id)) continue;
      const opp = this.store.opportunities.get(id);
      if (opp?.status === 'SCREENING') this.setOpportunityStatus(id, 'DISCOVERED', 'Kein Screening-Ergebnis erhalten');
    }
  }

  onScreeningFailed(ctx: JobContext, reason: string): void {
    for (const id of (Array.isArray(ctx.job.input.opportunity_ids) ? ctx.job.input.opportunity_ids : []) as string[]) {
      const opp = this.store.opportunities.get(id);
      if (opp?.status === 'SCREENING') this.setOpportunityStatus(id, 'DISCOVERED', `Screening fehlgeschlagen: ${reason}`.slice(0, 300));
    }
  }

  // ---------------------------------------------------------------- Pipeline: Research & Bewertung

  applyResearch(
    ctx: JobContext,
    out: {
      report_markdown: string;
      problem: string;
      target_customer: string;
      proposed_solution: string;
      competition_summary: string;
      revenue_model: string;
      market_notes: string;
      key_risks: string[];
      legal: Omit<LegalCheck, 'source' | 'checked_at'>;
      sources: { title: string; url: string; note?: string }[];
    },
  ): void {
    const opp = ctx.opportunity!;
    const sources = [...opp.sources];
    for (const s of out.sources ?? []) if (s?.url && !sources.some((x) => x.url === s.url)) sources.push(s);
    const l = out.legal;
    const legal: LegalCheck | null = l
      ? {
          status: (['green', 'yellow', 'red'] as const).find((x) => x === l.status) ?? 'yellow',
          how_possible: String(l.how_possible ?? '').trim(),
          effort_one_time_hours: clamp(l.effort_one_time_hours, 0, 10000),
          effort_one_time_eur: clamp(l.effort_one_time_eur, 0, 1e7),
          effort_ongoing_hours_month: clamp(l.effort_ongoing_hours_month, 0, 1000),
          effort_ongoing_eur_month: clamp(l.effort_ongoing_eur_month, 0, 1e6),
          steps: (l.steps ?? []).filter((x) => x?.step).map((x) => ({ step: String(x.step), details: String(x.details ?? '') })).slice(0, 20),
          open_questions: (l.open_questions ?? []).map(String).filter(Boolean).slice(0, 15),
          source: 'research',
          checked_at: new Date().toISOString(),
        }
      : opp.legal;
    this.store.opportunities.update(opp.id, {
      problem: out.problem || opp.problem,
      target_customer: out.target_customer || opp.target_customer,
      proposed_solution: out.proposed_solution || opp.proposed_solution,
      competition_summary: out.competition_summary || opp.competition_summary,
      revenue_model: out.revenue_model || opp.revenue_model,
      sources: sources.slice(0, 25),
      legal,
    });
    const md = [
      `# Recherchebericht ${opp.id}: ${opp.title}`,
      '',
      out.report_markdown,
      '',
      '## Markt',
      out.market_notes,
      '',
      '## Wichtigste Risiken',
      ...(out.key_risks?.length ? out.key_risks.map((r) => `- ${r}`) : ['- (keine genannt)']),
      '',
      ...this.legalMarkdown(legal),
      '',
      '## Quellen',
      ...(out.sources ?? []).map((s) => `- [${s.title}](${s.url})${s.note ? ` – ${s.note}` : ''}`),
    ].join('\n');
    this.memory.saveArtifact(this.store, {
      area: 'research',
      kind: 'research_report',
      title: `Recherchebericht ${opp.id}`,
      content: md,
      summary: out.competition_summary,
      job_id: ctx.job.id,
      agent_id: ctx.agent.id,
      opportunity_id: opp.id,
    });
    const current = this.store.opportunities.require(opp.id);
    if (!PRE_DECISION_STATUSES.includes(current.status)) return; // laufender Test/Projekt: nur Wissen ergänzen
    this.setOpportunityStatus(opp.id, 'EVALUATION', null);
    this.createJob({ type: 'evaluation', opportunity_id: opp.id, parent_job_id: ctx.job.id, automatic: true });
  }

  private legalMarkdown(legal: LegalCheck | null): string[] {
    if (!legal) return ['## Rechtliche und Plattform-Prüfung', '- nicht durchgeführt'];
    const h = (v: number | null) => (v == null ? '–' : String(v));
    return [
      '## Rechtliche und Plattform-Prüfung',
      `**Einstufung: ${LEGAL_STATUS_LABELS[legal.status]}**`,
      '',
      legal.how_possible,
      '',
      `Aufwand einmalig: ${h(legal.effort_one_time_hours)} Std., ${h(legal.effort_one_time_eur)} € · laufend: ${h(legal.effort_ongoing_hours_month)} Std./Monat, ${h(legal.effort_ongoing_eur_month)} €/Monat`,
      '',
      '**Nötige Schritte:**',
      ...(legal.steps.length ? legal.steps.map((s, i) => `${i + 1}. ${s.step}${s.details ? ` – ${s.details}` : ''}`) : ['- keine']),
      ...(legal.open_questions.length ? ['', '**Offene Fragen:**', ...legal.open_questions.map((q) => `- ${q}`)] : []),
      '',
      '_Keine Rechtsberatung – im Zweifel fachlich prüfen lassen._',
    ];
  }

  applyEvaluation(
    ctx: JobContext,
    out: {
      criteria: Record<string, { score: number; note: string }>;
      confidence: number;
      recommendation: 'GO' | 'NO_GO';
      rationale: string;
      test_plan: TestPlan;
      mvp_outline: string;
      estimated_effort: string;
    },
  ): void {
    const opp = ctx.opportunity!;
    const s = this.settings;
    const criteria = this.cleanCriteria(out.criteria, true);
    const plan = out.test_plan ? cleanPlan(out.test_plan) : null;
    const ko = knockouts(criteria, opp.legal, plan, s);
    const base = criteriaScore(criteria, s.criteria_weights);
    const score = cappedScore(base, ko);
    const confidence = clamp(out.confidence, 0, 1);
    // Ein laufender Test oder ein Projekt wird durch eine Neubewertung nicht zurückgesetzt
    const decided = !PRE_DECISION_STATUSES.includes(opp.status);
    const test: TestState | null = plan && !decided
      ? {
          attempt: 1,
          status: 'PROPOSED',
          plan,
          guardrail_issues: guardrailIssues(plan, s),
          started_at: null,
          ends_at: null,
          result: null,
          evaluation: null,
          history: [],
        }
      : opp.test;
    this.store.opportunities.update(opp.id, { criteria, knockouts: ko, score, confidence, test });
    const md = [
      `# Bewertung ${opp.id}: ${opp.title}`,
      '',
      `**Empfehlung: ${out.recommendation}** · Gesamt-Score ${score ?? '–'}${ko.length && base != null ? ` (ohne K.-o. ${base})` : ''} · Konfidenz ${confidence ?? '–'}`,
      ...(ko.length ? ['', `**K.-o.-Kriterien:** ${ko.join('; ')}`] : []),
      '',
      ...this.criteriaTable(criteria),
      '',
      '## Begründung',
      out.rationale,
      '',
      '## Nachfragetest',
      ...(plan ? planMarkdown(plan) : ['- kein Testplan']),
      '',
      '## MVP-Skizze (nach erfolgreichem Test)',
      out.mvp_outline,
      '',
      `**Aufwand:** ${out.estimated_effort}`,
    ].join('\n');
    this.memory.saveArtifact(this.store, {
      area: 'research',
      kind: 'evaluation',
      title: `Bewertung ${opp.id}`,
      content: md,
      summary: `${out.recommendation}, Score ${score}${ko.length ? ` (K.-o.: ${ko.join('; ')})` : ''}: ${out.rationale.slice(0, 300)}`,
      job_id: ctx.job.id,
      agent_id: ctx.agent.id,
      opportunity_id: opp.id,
    });
    const threshold = s.proposal_threshold;
    if (decided) return;
    if (out.recommendation === 'GO' && !ko.length && score != null && score >= threshold) {
      if (s.require_demand_test && plan) this.proposeTest(opp.id, `agent:${ctx.agent.id}`);
      else this.propose(opp.id, `agent:${ctx.agent.id}`);
    } else {
      const why = ko.length
        ? `K.-o.: ${ko.join('; ')}`
        : out.recommendation === 'GO'
          ? `Score ${score} unter Vorschlags-Schwelle ${threshold}`
          : 'Bewertung: NO_GO';
      this.setOpportunityStatus(opp.id, 'REJECTED', `${why} – ${out.rationale}`.slice(0, 500));
    }
  }

  /** Belegte Plätze für Tests und Projekte (Leitplanke "höchstens N gleichzeitig"). */
  private slotsUsed(exceptId?: string): string[] {
    return this.store.opportunities
      .list({ status: SLOT_STATUSES })
      .map((o) => o.id)
      .filter((id) => id !== exceptId);
  }

  private slotCheck(oppId: string): void {
    const used = this.slotsUsed(oppId);
    const max = this.settings.guard_max_parallel;
    if (used.length >= max) {
      throw new ConflictError(
        `Leitplanke: Es laufen bereits ${used.length} von höchstens ${max} Tests/Projekten (${used.join(', ')}). ` +
          'Beende oder pausiere zuerst eins – oder erhöhe die Grenze unter Einstellungen → Leitplanken.',
      );
    }
  }

  private slotLine(oppId: string): string {
    const used = this.slotsUsed(oppId);
    const max = this.settings.guard_max_parallel;
    return used.length >= max
      ? `⚠ Alle Plätze belegt (${used.length}/${max}: ${used.join(', ')}) – eine Freigabe ist erst möglich, wenn ein Test oder Projekt endet.`
      : `Plätze für Tests/Projekte: ${used.length}/${max} belegt.`;
  }

  /** Legt dem Owner den Nachfragetest zur Freigabe vor (Approval-Level 2, Strategie §8). */
  proposeTest(oppId: string, actor: string): Opportunity {
    const opp = this.store.opportunities.require(oppId);
    if (!opp.test?.plan) throw new ValidationError('Noch kein Testplan – zuerst bewerten lassen');
    if (['APPROVED', 'DEVELOPMENT', 'REVIEW', 'READY', 'DEPLOYED'].includes(opp.status)) throw new ConflictError('Projekt läuft bereits');
    if (opp.test.status !== 'PROPOSED' && opp.status === 'TESTING' && !['PASSED', 'FAILED'].includes(opp.test.status)) {
      throw new ConflictError('Der Nachfragetest läuft bereits');
    }
    const test: TestState = { ...opp.test, status: 'PROPOSED', guardrail_issues: guardrailIssues(opp.test.plan, this.settings) };
    this.store.opportunities.update(oppId, { test });
    const updated = opp.status === 'TESTING' ? this.setOpportunityStatus(oppId, 'TESTING', 'Wiederholungstest vorgeschlagen') : this.setOpportunityStatus(oppId, 'PROPOSED', 'Nachfragetest vorgeschlagen');
    for (const a of this.store.approvals.pending('PROJECT_START', oppId)) this.store.approvals.decide(a.id, 'CANCELLED', 'ersetzt durch Nachfragetest');
    if (!this.store.approvals.pending('TEST_START', oppId).length) {
      const fresh = this.store.opportunities.require(oppId);
      const approval = this.store.approvals.create({
        type: 'TEST_START',
        level: 2,
        title: `Nachfragetest${test.attempt > 1 ? ` (Versuch ${test.attempt})` : ''}: ${opp.id} ${opp.title}`,
        summary: [
          `**Score ${fresh.score ?? '–'}** · Rechtlich: ${fresh.legal ? LEGAL_STATUS_LABELS[fresh.legal.status] : 'nicht geprüft'}`,
          '',
          ...planMarkdown(test.plan),
          '',
          ...(test.guardrail_issues.length ? [`⚠ Leitplanken überschritten: ${test.guardrail_issues.join('; ')}`, ''] : []),
          this.slotLine(oppId),
          '',
          'Mit der Freigabe bereitet Davenet die Testmaterialien vor. Accounts, Veröffentlichung und Zahlungen bleiben deine Schritte.',
        ].join('\n'),
        payload: { attempt: test.attempt, plan: test.plan, score: fresh.score, guardrail_issues: test.guardrail_issues },
        opportunity_id: oppId,
      });
      this.audit(actor, 'approval.requested', 'approval', approval.id, 2, { type: 'TEST_START', opportunity_id: oppId });
      this.changed('approval', approval.id);
    }
    return updated;
  }

  /** Legt die Opportunity dem Owner zur Freigabe des Projektstarts (Bau) vor (Approval-Level 2). */
  propose(oppId: string, actor: string): Opportunity {
    const opp = this.store.opportunities.require(oppId);
    if (['DEVELOPMENT', 'REVIEW', 'READY', 'DEPLOYED', 'APPROVED'].includes(opp.status)) throw new ConflictError('Projekt läuft bereits');
    // Während/nach einem Test behält die Opportunity ihren Platz, bis über den Bau entschieden ist
    const updated =
      opp.status === 'TESTING' ? this.setOpportunityStatus(oppId, 'TESTING', 'Bau zur Freigabe vorgeschlagen') : this.setOpportunityStatus(oppId, 'PROPOSED', null);
    for (const a of this.store.approvals.pending('TEST_START', oppId)) this.store.approvals.decide(a.id, 'CANCELLED', 'ersetzt durch Projektstart');
    if (!this.store.approvals.pending('PROJECT_START', oppId).length) {
      const evaluation = this.store.artifacts.latest(oppId, 'evaluation');
      const t = opp.test;
      const testLines =
        t?.evaluation || t?.result
          ? [
              '## Ergebnis des Nachfragetests',
              `Versuch ${t.attempt}: ${t.evaluation ? `${TEST_VERDICT_LABELS[t.evaluation.verdict]} – ${t.evaluation.summary.replace(/^#+\s*/gm, '')}` : ''}`,
              t.result ? `Ergebnis laut Owner: ${t.result.notes}` : '',
              '',
            ]
          : [];
      const approval = this.store.approvals.create({
        type: 'PROJECT_START',
        level: 2,
        title: `Projektstart: ${opp.id} ${opp.title}`,
        summary: [
          ...testLines,
          evaluation ? this.memory.readArtifact(evaluation).slice(0, 4000) : `${opp.problem}\n\nLösung: ${opp.proposed_solution}`,
          '',
          this.slotLine(oppId),
        ].join('\n'),
        payload: { score: opp.score, test_verdict: t?.evaluation?.verdict ?? null },
        opportunity_id: oppId,
      });
      this.audit(actor, 'approval.requested', 'approval', approval.id, 2, { type: 'PROJECT_START', opportunity_id: oppId });
      this.changed('approval', approval.id);
    }
    return updated;
  }

  /** Abbruch vorschlagen (Abbruchregel, Strategie §8) – der Owner entscheidet. */
  requestStop(oppId: string, reason: string, actor: string): void {
    const opp = this.store.opportunities.require(oppId);
    if (this.store.approvals.pending('PROJECT_STOP', oppId).length) return;
    const total = this.store.finance.totals({ opportunity_id: oppId });
    const approval = this.store.approvals.create({
      type: 'PROJECT_STOP',
      level: 2,
      title: `Beenden: ${opp.id} ${opp.title}`,
      summary: [
        `**Empfehlung: beenden.** ${reason}`,
        '',
        `Bisher erfasst: Einnahmen ${eur(total.revenue_eur)}, Ausgaben ${eur(total.expense_eur)}, Owner-Zeit ${total.hours} Std.` +
          (opp.fixed_costs_eur_month ? `, Fixkosten ${eur(opp.fixed_costs_eur_month)}/Monat` : ''),
        '',
        'Mit der Freigabe wird die Opportunity beendet und offene Arbeit gestoppt. Laufende Verträge, Abos oder Listings beendest du selbst.',
      ].join('\n'),
      payload: { reason },
      opportunity_id: oppId,
    });
    this.audit(actor, 'approval.requested', 'approval', approval.id, 2, { type: 'PROJECT_STOP', opportunity_id: oppId });
    this.changed('approval', approval.id);
  }

  stopOpportunity(oppId: string, reason: string, actor: string, exceptApprovalId?: number): Opportunity {
    this.store.opportunities.require(oppId);
    this.cancelOpenWork(oppId, exceptApprovalId);
    this.audit(actor, 'opportunity.stopped', 'opportunity', oppId, 2, { reason });
    return this.setOpportunityStatus(oppId, 'STOPPED', reason.slice(0, 500));
  }

  // ---------------------------------------------------------------- Pipeline: Nachfragetest (Strategie §8)

  private updateTest(oppId: string, patch: Partial<TestState>): TestState {
    const opp = this.store.opportunities.require(oppId);
    if (!opp.test) throw new ConflictError('Kein Nachfragetest vorhanden');
    const test = { ...opp.test, ...patch };
    this.store.opportunities.update(oppId, { test });
    this.syncOpportunityFile(this.store.opportunities.require(oppId));
    this.changed('opportunity', oppId);
    return test;
  }

  markTestLive(oppId: string): Opportunity {
    const opp = this.store.opportunities.require(oppId);
    if (opp.status !== 'TESTING' || !opp.test || !['PREPARING', 'READY'].includes(opp.test.status)) {
      throw new ConflictError('Der Test ist nicht startbereit (erst nach Freigabe und Vorbereitung)');
    }
    const now = new Date();
    const ends = new Date(now.getTime() + opp.test.plan.duration_days * 86400_000);
    this.updateTest(oppId, { status: 'RUNNING', started_at: now.toISOString(), ends_at: ends.toISOString() });
    this.audit('owner', 'test.started', 'opportunity', oppId, 0, { ends_at: ends.toISOString() });
    return this.setOpportunityStatus(oppId, 'TESTING', `Test läuft bis ${localDay(ends)}`);
  }

  recordTestResult(oppId: string, notes: string): { opportunity: Opportunity; job: Job | null } {
    const opp = this.store.opportunities.require(oppId);
    if (opp.status !== 'TESTING' || !opp.test) throw new ConflictError('Für diese Opportunity läuft kein Nachfragetest');
    this.updateTest(oppId, {
      status: 'EVALUATING',
      started_at: opp.test.started_at ?? new Date().toISOString(),
      result: { notes: notes.slice(0, 4000), recorded_at: new Date().toISOString() },
    });
    this.audit('owner', 'test.result', 'opportunity', oppId, 0, {});
    const job = this.createJob({ type: 'test_evaluation', opportunity_id: oppId, created_by: 'owner', automatic: true });
    if (!job) this.updateTest(oppId, { status: 'RUNNING' });
    return { opportunity: this.setOpportunityStatus(oppId, 'TESTING', job ? 'Ergebnis wird ausgewertet' : 'Ergebnis erfasst'), job };
  }

  async applyTestPreparation(
    ctx: JobContext,
    out: { summary: string; files: string[]; owner_checklist: { step: string; minutes: number }[]; measurement: string; image_requests?: ImageRequest[] },
    info: CompletionInfo,
  ): Promise<void> {
    const opp = ctx.opportunity!;
    const files = [...new Set([...(info.filesChanged ?? []), ...(out.files ?? [])])].slice(0, 200);
    const commit = await commitWorkspace(this.memory.workspaceDir(opp.id), `${opp.id}: Testpaket Nachfragetest`);
    const minutes = (out.owner_checklist ?? []).reduce((sum, c) => sum + Math.max(0, num(c.minutes)), 0);
    const planned = (opp.test?.plan.owner_hours ?? 0) * 60;
    const imageNotes = this.requestImages(ctx, out.image_requests);
    const md = [
      `# Testpaket ${opp.id}: ${opp.title}`,
      '',
      out.summary,
      '',
      '## Deine Schritte',
      ...(out.owner_checklist?.length ? out.owner_checklist.map((c, i) => `${i + 1}. ${c.step} (ca. ${Math.round(num(c.minutes))} Min.)`) : ['- keine']),
      '',
      `Geschätzte Owner-Zeit: ${Math.round(minutes)} Min.${planned && minutes > planned ? ` – ⚠ mehr als geplant (${Math.round(planned)} Min.)` : ''}`,
      '',
      '## Messung',
      out.measurement,
      '',
      '## Dateien im Workspace',
      ...(files.length ? files.map((f) => `- ${f}`) : ['- (keine)']),
      ...(imageNotes.length ? ['', '## Bilder', ...imageNotes.map((n) => `- ${n}`)] : []),
      commit ? `\nGit-Commit: \`${commit}\`` : '',
      '',
      'Wenn alles veröffentlicht ist: in Davenet „Test ist live“ klicken. Einnahmen, Ausgaben und deine Zeit unter „Test & Zahlen“ erfassen.',
    ].join('\n');
    this.memory.saveArtifact(this.store, {
      area: 'projects',
      kind: 'test_kit',
      title: `Testpaket ${opp.id}`,
      content: md,
      summary: out.summary,
      job_id: ctx.job.id,
      agent_id: ctx.agent.id,
      opportunity_id: opp.id,
    });
    this.audit(`agent:${ctx.agent.id}`, 'workspace.changed', 'opportunity', opp.id, 1, { files, commit });
    if (opp.test && opp.test.status === 'PREPARING') this.updateTest(opp.id, { status: 'READY' });
    this.setOpportunityStatus(opp.id, 'TESTING', 'Testpaket bereit – deine Schritte');
  }

  onTestPreparationFailed(ctx: JobContext, reason: string): void {
    const opp = ctx.opportunity ? this.store.opportunities.get(ctx.opportunity.id) : undefined;
    if (opp?.test?.status === 'PREPARING') {
      this.updateTest(opp.id, { status: 'READY' });
      this.setOpportunityStatus(opp.id, 'TESTING', `Vorbereitung fehlgeschlagen – Materialien selbst erstellen oder Job wiederholen: ${reason}`.slice(0, 300));
    }
  }

  applyTestEvaluation(
    ctx: JobContext,
    out: { verdict: TestVerdict; success_criterion_met: boolean; summary: string; reasoning: string; adjusted_plan?: TestPlan; next_steps: string[] },
  ): void {
    const opp = this.store.opportunities.require(ctx.opportunity!.id);
    const test = opp.test;
    if (!test) return;
    const evaluation = { verdict: out.verdict, success_criterion_met: !!out.success_criterion_met, summary: out.summary, recorded_at: new Date().toISOString() };
    let verdict = out.verdict;
    if (verdict === 'ADJUST' && (test.attempt >= 2 || !out.adjusted_plan)) verdict = 'STOP';
    this.memory.saveArtifact(this.store, {
      area: 'research',
      kind: 'test_evaluation',
      title: `Testauswertung ${opp.id} (Versuch ${test.attempt})`,
      content: [
        `# Testauswertung ${opp.id}: ${opp.title}`,
        '',
        `**Empfehlung: ${TEST_VERDICT_LABELS[out.verdict]}**${verdict !== out.verdict ? ` → ${TEST_VERDICT_LABELS[verdict]} (höchstens ein Wiederholungstest)` : ''} · Erfolgskriterium ${out.success_criterion_met ? 'erfüllt' : 'nicht erfüllt'}`,
        '',
        out.summary,
        '',
        '## Begründung',
        out.reasoning,
        '',
        '## Nächste Schritte',
        ...(out.next_steps?.length ? out.next_steps.map((x) => `- ${x}`) : ['- keine']),
        ...(verdict === 'ADJUST' && out.adjusted_plan ? ['', '## Angepasster Test', ...planMarkdown(cleanPlan(out.adjusted_plan))] : []),
      ].join('\n'),
      summary: `${TEST_VERDICT_LABELS[verdict]}: ${out.summary}`.slice(0, 400),
      job_id: ctx.job.id,
      agent_id: ctx.agent.id,
      opportunity_id: opp.id,
    });
    const actor = `agent:${ctx.agent.id}`;
    if (verdict === 'BUILD') {
      this.updateTest(opp.id, { status: 'PASSED', evaluation });
      this.propose(opp.id, actor);
    } else if (verdict === 'ADJUST') {
      const plan = cleanPlan(out.adjusted_plan!);
      const round = { attempt: test.attempt, plan: test.plan, started_at: test.started_at, ends_at: test.ends_at, result: test.result, evaluation };
      this.updateTest(opp.id, {
        attempt: test.attempt + 1,
        status: 'PROPOSED',
        plan,
        guardrail_issues: guardrailIssues(plan, this.settings),
        started_at: null,
        ends_at: null,
        result: null,
        evaluation: null,
        history: [...(test.history ?? []), round],
      });
      this.proposeTest(opp.id, actor);
    } else {
      this.updateTest(opp.id, { status: 'FAILED', evaluation });
      this.setOpportunityStatus(opp.id, 'TESTING', 'Test nicht bestanden – Beenden vorgeschlagen');
      this.requestStop(opp.id, `Nachfragetest nicht bestanden: ${out.summary}`, actor);
    }
  }

  onTestEvaluationFailed(ctx: JobContext, _reason: string): void {
    const opp = ctx.opportunity ? this.store.opportunities.get(ctx.opportunity.id) : undefined;
    if (opp?.test?.status === 'EVALUATING') this.updateTest(opp.id, { status: 'RUNNING' });
  }

  // ---------------------------------------------------------------- Freigaben (Konzept §14)

  decideApproval(id: number, decision: 'APPROVED' | 'REJECTED', note?: string | null, actor = 'owner'): Approval {
    const approval = this.store.approvals.require(id);
    if (approval.status !== 'PENDING') throw new ConflictError('Freigabe wurde bereits entschieden');
    if (decision === 'APPROVED' && (approval.type === 'TEST_START' || approval.type === 'PROJECT_START') && approval.opportunity_id) {
      this.slotCheck(approval.opportunity_id); // Leitplanke: höchstens N Tests/Projekte gleichzeitig
    }
    const decided = this.store.approvals.decide(id, decision, note ?? null);
    this.audit(actor, decision === 'APPROVED' ? 'approval.approved' : 'approval.rejected', 'approval', id, approval.level, {
      type: approval.type,
      opportunity_id: approval.opportunity_id,
      job_id: approval.job_id,
      note,
    });
    this.recordDecision(decided);

    switch (approval.type) {
      case 'TEST_START': {
        const oppId = approval.opportunity_id!;
        const opp = this.store.opportunities.get(oppId);
        if (!opp) break;
        if (decision === 'APPROVED') {
          this.setOpportunityStatus(oppId, 'TESTING', 'Testpaket wird vorbereitet');
          if (opp.test) this.updateTest(oppId, { status: 'PREPARING' });
          const job = this.createJob({ type: 'test_preparation', opportunity_id: oppId, input: note ? { notes: note } : {}, automatic: true, created_by: 'owner' });
          if (!job) {
            if (opp.test) this.updateTest(oppId, { status: 'READY' });
            this.setOpportunityStatus(oppId, 'TESTING', 'Testvorbereitung ist deaktiviert – Materialien selbst erstellen');
          }
        } else if ((opp.test?.attempt ?? 1) > 1) {
          if (opp.test) this.updateTest(oppId, { status: 'FAILED' });
          this.stopOpportunity(oppId, `Wiederholungstest abgelehnt${note ? `: ${note}` : ''}`, actor, id);
        } else {
          this.setOpportunityStatus(oppId, 'REJECTED', `Nachfragetest abgelehnt${note ? `: ${note}` : ''}`);
        }
        break;
      }
      case 'PROJECT_STOP': {
        const oppId = approval.opportunity_id!;
        if (decision === 'APPROVED' && this.store.opportunities.get(oppId)) {
          const reason = String((approval.payload as { reason?: string }).reason ?? 'Abbruchregel');
          this.stopOpportunity(oppId, `${reason}${note ? ` – ${note}` : ''}`, actor, id);
        }
        break;
      }
      case 'PROJECT_START': {
        const oppId = approval.opportunity_id!;
        if (decision === 'APPROVED') {
          this.setOpportunityStatus(oppId, 'APPROVED', note ?? null);
          // Konzept §15: "Owner approved project -> Technical Planning"
          this.createJob({ type: 'technical_planning', opportunity_id: oppId, input: note ? { notes: note } : {}, automatic: true, created_by: 'owner' });
        } else {
          this.setOpportunityStatus(oppId, 'REJECTED', `Projektstart abgelehnt${note ? `: ${note}` : ''}`);
        }
        break;
      }
      case 'RELEASE': {
        const oppId = approval.opportunity_id!;
        if (decision === 'APPROVED') this.setOpportunityStatus(oppId, 'DEPLOYED', note ?? 'Release freigegeben');
        else this.setOpportunityStatus(oppId, 'DEVELOPMENT', `Release abgelehnt${note ? `: ${note}` : ''}`);
        break;
      }
      case 'PROVIDER_SWITCH': {
        const job = approval.job_id ? this.store.jobs.get(approval.job_id) : undefined;
        if (job && job.status === 'WAITING_FOR_APPROVAL') {
          const p = approval.payload as { alternative_provider_id?: string; alternative_model_id?: string; wait_until?: string | null; primary_provider_id?: string };
          if (decision === 'APPROVED') {
            this.store.jobs.update(job.id, {
              status: 'QUEUED',
              forced_provider_id: p.alternative_provider_id ?? null,
              forced_model_id: p.alternative_model_id ?? null,
              wait_reason: null,
            });
            this.store.jobs.appendLog(job.id, 'info', `Owner hat Wechsel zu ${p.alternative_provider_id} freigegeben`);
          } else {
            this.store.jobs.update(job.id, {
              status: 'WAITING_FOR_PROVIDER_QUOTA',
              policy_override: 'WAIT',
              not_before: p.wait_until ?? null,
              waiting_provider_id: p.primary_provider_id ?? null,
              wait_reason: 'Provider-Wechsel abgelehnt – wartet auf Kontingent',
            });
          }
          this.changed('job', job.id);
          this.bus.emit('scheduler.wake');
        }
        break;
      }
    }
    this.changed('approval', id);
    return decided;
  }

  /** Entscheidungen des Owners zusätzlich im Unternehmensgedächtnis protokollieren (/decisions). */
  private recordDecision(a: Approval): void {
    try {
      const file = 'decisions/entscheidungen.md';
      let existing = '';
      try {
        existing = this.memory.readFile(file);
      } catch {
        existing = '# Entscheidungen des Owners\n\n| Zeitpunkt | Freigabe | Entscheidung | Notiz |\n|---|---|---|---|\n';
      }
      const line = `| ${new Date().toISOString().slice(0, 16).replace('T', ' ')} | #${a.id} ${APPROVAL_TYPE_LABELS[a.type]}: ${a.title.replace(/\|/g, '/')} | ${a.status} | ${(a.decision_note ?? '').replace(/\|/g, '/').replace(/\n/g, ' ')} |\n`;
      this.memory.writeFile(file, existing + line);
    } catch {
      /* optional */
    }
  }

  requestProviderSwitch(job: Job, primary: { providerId: string; until: string | null }, alt: { providerId: string; modelId: string; label: string }, reason: string): void {
    if (this.store.approvals.pending('PROVIDER_SWITCH', undefined, job.id).length) return;
    const approval = this.store.approvals.create({
      type: 'PROVIDER_SWITCH',
      level: 2,
      title: `Provider-Wechsel für Job #${job.id}: ${job.title}`,
      summary: `${reason}\n\nAlternative: ${alt.label}. Ohne Freigabe wartet der Job auf den Reset des vorgesehenen Providers${primary.until ? ` (${primary.until})` : ''}.`,
      payload: {
        primary_provider_id: primary.providerId,
        wait_until: primary.until,
        alternative_provider_id: alt.providerId,
        alternative_model_id: alt.modelId,
      },
      opportunity_id: job.opportunity_id,
      job_id: job.id,
    });
    this.audit('system', 'approval.requested', 'approval', approval.id, 2, { type: 'PROVIDER_SWITCH', job_id: job.id });
    this.changed('approval', approval.id);
  }

  // ---------------------------------------------------------------- Pipeline: Entwicklung (Konzept §10)

  applyPlanning(ctx: JobContext, out: { spec_markdown: string; tech_stack: string; tasks: { key: string; title: string; description: string; acceptance_criteria: string[]; depends_on: string[] }[] }): void {
    const opp = ctx.opportunity!;
    const md = [
      `# MVP-Spezifikation ${opp.id}: ${opp.title}`,
      '',
      out.spec_markdown,
      '',
      '## Technologie',
      out.tech_stack,
      '',
      '## Tasks',
      ...out.tasks.map((t) => `- **${t.key} ${t.title}**${t.depends_on?.length ? ` (nach ${t.depends_on.join(', ')})` : ''}: ${t.description}`),
    ].join('\n');
    this.memory.saveArtifact(this.store, {
      area: 'projects',
      kind: 'spec',
      title: `MVP-Spezifikation ${opp.id}`,
      content: md,
      summary: `${out.tasks.length} Tasks · ${out.tech_stack.slice(0, 200)}`,
      job_id: ctx.job.id,
      agent_id: ctx.agent.id,
      opportunity_id: opp.id,
    });

    // Neuplanung: offene (TODO) Tasks ersetzen, begonnene/erledigte behalten
    for (const t of this.store.tasks.listForOpportunity(opp.id)) {
      if (t.status === 'TODO' && !this.store.jobs.openForTask(t.id).length) this.store.tasks.delete(t.id);
    }
    const keyMap = new Map<string, string>();
    const planned = out.tasks.slice(0, this.settings.max_tasks_per_project);
    const created: Task[] = [];
    for (const t of planned) {
      const task = this.store.tasks.create(opp.id, {
        key: t.key,
        title: t.title,
        description: t.description,
        acceptance_criteria: t.acceptance_criteria ?? [],
      });
      keyMap.set(t.key, task.key);
      created.push(task);
    }
    planned.forEach((t, i) => {
      const deps = (t.depends_on ?? []).map((d) => keyMap.get(d)).filter((d): d is string => !!d && d !== created[i].key);
      if (deps.length) this.store.tasks.update(created[i].id, { depends_on: deps });
    });
    this.audit(`agent:${ctx.agent.id}`, 'project.planned', 'opportunity', opp.id, 1, { tasks: created.map((t) => t.id) });
    this.setOpportunityStatus(opp.id, 'DEVELOPMENT', `${created.length} Tasks geplant`);
    this.changed('task');
    if (this.settings.auto_start_development) this.startDevelopment(opp.id, 'system');
  }

  /** Startet Implementierungs-Jobs für alle Tasks, deren Abhängigkeiten erledigt sind. */
  startDevelopment(oppId: string, actor: string): number {
    const opp = this.store.opportunities.require(oppId);
    if (opp.status === 'APPROVED') this.setOpportunityStatus(oppId, 'DEVELOPMENT', null);
    const tasks = this.store.tasks.listForOpportunity(oppId);
    const done = new Set(tasks.filter((t) => t.status === 'DONE').map((t) => t.key));
    let started = 0;
    for (const t of tasks) {
      if (t.status !== 'TODO') continue;
      if (!t.depends_on.every((d) => done.has(d))) continue;
      if (this.store.jobs.openForTask(t.id).length) continue;
      const job = this.createJob({ type: 'implementation', task_id: t.id, automatic: actor !== 'owner', created_by: actor });
      if (job) started++;
    }
    if (started) this.changed('task');
    this.updateProjectStatus(oppId);
    return started;
  }

  async applyImplementation(
    ctx: JobContext,
    out: { summary: string; files_changed: string[]; notes_for_reviewer: string; open_issues: string[]; image_requests?: ImageRequest[] },
    info: CompletionInfo,
  ): Promise<void> {
    const task = ctx.task!;
    const opp = ctx.opportunity!;
    const files = [...new Set([...(info.filesChanged ?? []), ...(out.files_changed ?? [])])].slice(0, 200);
    const commit = await commitWorkspace(this.memory.workspaceDir(opp.id), `${task.id}: ${task.title}`);
    const imageNotes = this.requestImages(ctx, out.image_requests);
    const md = [
      `# Implementierung ${task.id}: ${task.title}`,
      '',
      out.summary,
      '',
      '## Dateien',
      ...(files.length ? files.map((f) => `- ${f}`) : ['- (keine Änderungen erkannt)']),
      '',
      '## Hinweise für das Review',
      out.notes_for_reviewer || '–',
      '',
      '## Offene Punkte',
      ...(out.open_issues?.length ? out.open_issues.map((i) => `- ${i}`) : ['- keine']),
      ...(imageNotes.length ? ['', '## Bilder', ...imageNotes.map((n) => `- ${n}`)] : []),
      commit ? `\nGit-Commit: \`${commit}\`` : '',
    ].join('\n');
    this.memory.saveArtifact(this.store, {
      area: 'projects',
      kind: 'implementation_report',
      title: `Implementierung ${task.id}`,
      content: md,
      summary: out.summary,
      job_id: ctx.job.id,
      agent_id: ctx.agent.id,
      opportunity_id: opp.id,
      task_id: task.id,
    });
    // Approval-Level 1: autonom, aber im Audit-Log nachvollziehbar
    this.audit(`agent:${ctx.agent.id}`, 'workspace.changed', 'task', task.id, 1, { files, commit });
    this.store.tasks.setStatus(task.id, 'IN_REVIEW');
    this.changed('task', task.id);
    const reviewJob = this.createJob({ type: 'review', task_id: task.id, parent_job_id: ctx.job.id, automatic: true });
    if (!reviewJob) {
      // Review deaktiviert: Task gilt nach der Umsetzung als erledigt
      this.store.tasks.setStatus(task.id, 'DONE');
      this.startDevelopment(opp.id, 'system');
    }
    this.updateProjectStatus(opp.id);
  }

  applyReview(ctx: JobContext, out: { verdict: 'PASS' | 'REWORK'; summary: string; findings: { severity: 'critical' | 'major' | 'minor'; file?: string; description: string }[] }): void {
    const task = ctx.task!;
    const opp = ctx.opportunity!;
    const findings = out.findings ?? [];
    this.store.tasks.update(task.id, { last_review: { verdict: out.verdict, summary: out.summary, findings } });
    const md = [
      `# Review ${task.id}: ${task.title}`,
      '',
      `**Ergebnis: ${out.verdict}**`,
      '',
      out.summary,
      '',
      '## Findings',
      ...(findings.length ? findings.map((f) => `- [${f.severity}]${f.file ? ` \`${f.file}\`` : ''} ${f.description}`) : ['- keine']),
    ].join('\n');
    this.memory.saveArtifact(this.store, {
      area: 'projects',
      kind: 'review',
      title: `Review ${task.id} (${out.verdict})`,
      content: md,
      summary: `${out.verdict}: ${out.summary}`,
      job_id: ctx.job.id,
      agent_id: ctx.agent.id,
      opportunity_id: opp.id,
      task_id: task.id,
    });
    if (out.verdict === 'PASS') {
      this.store.tasks.setStatus(task.id, 'DONE');
      this.changed('task', task.id);
      this.startDevelopment(opp.id, 'system');
    } else {
      const rounds = task.rework_count + 1;
      if (rounds > this.settings.max_rework_rounds) {
        this.store.tasks.update(task.id, { status: 'BLOCKED', rework_count: rounds });
        this.audit('system', 'task.blocked', 'task', task.id, 0, { reason: `mehr als ${this.settings.max_rework_rounds} Nacharbeitsrunden` });
      } else {
        this.store.tasks.update(task.id, { status: 'REWORK', rework_count: rounds });
        const feedback = [out.summary, ...findings.map((f) => `- [${f.severity}]${f.file ? ` ${f.file}:` : ''} ${f.description}`)].join('\n');
        this.createJob({ type: 'implementation', task_id: task.id, input: { rework_feedback: feedback }, parent_job_id: ctx.job.id, automatic: true });
      }
      this.changed('task', task.id);
    }
    this.updateProjectStatus(opp.id);
  }

  onTaskJobFailed(ctx: JobContext, reason: string): void {
    if (!ctx.task) return;
    const t = this.store.tasks.get(ctx.task.id);
    if (!t || t.status === 'DONE') return;
    this.store.tasks.setStatus(t.id, 'BLOCKED');
    this.audit('system', 'task.blocked', 'task', t.id, 0, { reason });
    this.changed('task', t.id);
  }

  addTask(oppId: string, data: { title: string; description?: string; acceptance_criteria?: string[]; depends_on?: string[] }): Task {
    this.store.opportunities.require(oppId);
    const task = this.store.tasks.create(oppId, data);
    if (data.depends_on?.length) this.store.tasks.update(task.id, { depends_on: data.depends_on });
    this.audit('owner', 'task.created', 'task', task.id, 0, { title: task.title });
    this.changed('task', task.id);
    this.updateProjectStatus(oppId);
    return this.store.tasks.require(task.id);
  }

  taskAction(taskId: string, action: string): Task {
    const task = this.store.tasks.require(taskId);
    switch (action) {
      case 'implement': {
        if (this.store.jobs.openForTask(taskId).length) throw new ConflictError('Für diese Task läuft bereits ein Job');
        this.createJob({ type: 'implementation', task_id: taskId, created_by: 'owner' });
        break;
      }
      case 'review': {
        if (this.store.jobs.openForTask(taskId).length) throw new ConflictError('Für diese Task läuft bereits ein Job');
        this.store.tasks.setStatus(taskId, 'IN_REVIEW');
        this.createJob({ type: 'review', task_id: taskId, created_by: 'owner' });
        break;
      }
      case 'mark_done':
        this.store.tasks.setStatus(taskId, 'DONE');
        this.audit('owner', 'task.done', 'task', taskId, 0, {});
        this.startDevelopment(task.opportunity_id, 'system');
        break;
      case 'reset':
        this.store.tasks.update(taskId, { status: 'TODO', rework_count: 0 });
        break;
      case 'delete':
        for (const j of this.store.jobs.openForTask(taskId)) if (j.status !== 'RUNNING') this.cancelJob(j.id, 'owner');
        this.store.tasks.delete(taskId);
        this.audit('owner', 'task.deleted', 'task', taskId, 0, {});
        this.changed('task', taskId);
        this.updateProjectStatus(task.opportunity_id);
        return task;
      default:
        throw new ValidationError(`Unbekannte Aktion: ${action}`);
    }
    this.changed('task', taskId);
    this.updateProjectStatus(task.opportunity_id);
    return this.store.tasks.require(taskId);
  }

  /** Leitet den Projektstatus aus den Tasks ab und legt bei Fertigstellung die Release-Freigabe an. */
  updateProjectStatus(oppId: string): void {
    const opp = this.store.opportunities.get(oppId);
    if (!opp || !['APPROVED', 'DEVELOPMENT', 'REVIEW', 'READY'].includes(opp.status)) return;
    const tasks = this.store.tasks.listForOpportunity(oppId);
    if (!tasks.length) return;
    if (tasks.every((t) => t.status === 'DONE')) {
      if (opp.status !== 'READY') this.requestRelease(oppId);
    } else if (tasks.every((t) => t.status === 'DONE' || t.status === 'IN_REVIEW')) {
      if (opp.status !== 'REVIEW') this.setOpportunityStatus(oppId, 'REVIEW', null);
    } else if (opp.status !== 'DEVELOPMENT') {
      this.setOpportunityStatus(oppId, 'DEVELOPMENT', null);
    }
  }

  requestRelease(oppId: string): void {
    const opp = this.store.opportunities.require(oppId);
    const tasks = this.store.tasks.listForOpportunity(oppId);
    this.setOpportunityStatus(oppId, 'READY', null);
    if (this.store.approvals.pending('RELEASE', oppId).length) return;
    const approval = this.store.approvals.create({
      type: 'RELEASE',
      level: 2,
      title: `Release: ${opp.id} ${opp.title}`,
      summary: [
        `Alle ${tasks.length} Tasks sind umgesetzt und geprüft.`,
        '',
        ...tasks.map((t) => `- **${t.key} ${t.title}:** ${(t.last_review?.summary ?? t.status).replace(/^#+\s*/gm, '').replace(/\s*\n+\s*/g, ' ')}`),
        '',
        `Workspace: \`${this.memory.workspaceDir(oppId)}\``,
        '',
        'Mit der Freigabe wird das Projekt als veröffentlicht markiert. Das eigentliche Deployment führst du selbst durch.',
      ].join('\n'),
      opportunity_id: oppId,
    });
    this.audit('system', 'approval.requested', 'approval', approval.id, 2, { type: 'RELEASE', opportunity_id: oppId });
    this.changed('approval', approval.id);
  }

  // ---------------------------------------------------------------- Leitung & Berichte

  applyDirective(ctx: JobContext, out: { understanding: string; notes: string; actions: { type: 'opportunity_scan' | 'deep_research' | 'custom'; agent_id?: string; opportunity_id?: string; instructions: string; priority: 'low' | 'normal' | 'high' }[] }): void {
    const created: string[] = [];
    const rejected: string[] = [];
    const prio = { low: 0, normal: 1, high: 2 } as const;
    for (const a of (out.actions ?? []).slice(0, 5)) {
      try {
        let job: Job | null = null;
        const base = { parent_job_id: ctx.job.id, created_by: `job:${ctx.job.id}`, priority: prio[a.priority] ?? 1 };
        if (a.type === 'opportunity_scan') {
          job = this.createJob({ ...base, type: 'opportunity_scan', input: { focus: a.instructions } });
        } else if (a.type === 'deep_research') {
          const opp = a.opportunity_id ? this.store.opportunities.get(a.opportunity_id.trim().toUpperCase()) : undefined;
          if (!opp) throw new Error(`Opportunity ${a.opportunity_id ?? '?'} unbekannt`);
          // laufende Tests und Projekte behalten ihren Status – die Recherche ergänzt nur das Wissen
          if (PRE_DECISION_STATUSES.includes(opp.status)) this.setOpportunityStatus(opp.id, 'RESEARCH', 'Auftrag der Leitung');
          job = this.createJob({ ...base, type: 'deep_research', opportunity_id: opp.id, input: { focus: a.instructions } });
        } else {
          const agent = a.agent_id ? this.store.agents.get(a.agent_id.trim().toUpperCase()) : undefined;
          if (!agent || !agent.enabled) throw new Error(`Agent ${a.agent_id ?? '?'} unbekannt oder deaktiviert`);
          const opp = a.opportunity_id ? this.store.opportunities.get(a.opportunity_id.trim().toUpperCase()) : undefined;
          job = this.createJob({ ...base, type: 'custom', agent_id: agent.id, opportunity_id: opp?.id ?? null, input: { instructions: a.instructions } });
        }
        if (job) created.push(`#${job.id} ${job.title}`);
      } catch (e) {
        rejected.push(`${a.type}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const md = [
      `# ${ctx.job.title}`,
      '',
      '## Verständnis',
      out.understanding,
      '',
      '## Angelegte Jobs',
      ...(created.length ? created.map((c) => `- ${c}`) : ['- keine']),
      ...(rejected.length ? ['', '## Nicht umsetzbar', ...rejected.map((r) => `- ${r}`)] : []),
      '',
      '## Hinweise an den Owner',
      out.notes || '–',
    ].join('\n');
    this.memory.saveArtifact(this.store, {
      area: 'decisions',
      kind: 'directive_plan',
      title: ctx.job.title,
      content: md,
      summary: `${created.length} Jobs angelegt. ${out.notes ?? ''}`.slice(0, 400),
      job_id: ctx.job.id,
      agent_id: ctx.agent.id,
    });
  }

  saveReport(ctx: JobContext, area: MemoryArea, kind: string, title: string, out: Record<string, unknown>): void {
    const main = String(out.summary_markdown ?? out.briefing_markdown ?? out.result_markdown ?? '');
    const lists: string[] = [];
    const label: Record<string, string> = {
      findings: 'Auffälligkeiten',
      recommendations: 'Empfehlungen',
      priorities: 'Prioritäten',
      suggested_directives: 'Vorgeschlagene Aufträge',
      issues: 'Issues',
    };
    for (const [key, value] of Object.entries(out)) {
      if (!Array.isArray(value) || !value.length) continue;
      lists.push('', `## ${label[key] ?? key}`);
      for (const item of value) {
        if (item && typeof item === 'object') {
          const o = item as Record<string, unknown>;
          lists.push(`- ${o.severity ? `[${o.severity}] ` : ''}${o.description ?? JSON.stringify(o)}${o.reference ? ` (${o.reference})` : ''}`);
        } else lists.push(`- ${String(item)}`);
      }
    }
    const md = [`# ${title}`, '', main, ...lists].join('\n');
    this.memory.saveArtifact(this.store, {
      area,
      kind,
      title,
      content: md,
      summary: String(out.summary ?? main).replace(/[#*_`>]/g, '').trim().slice(0, 400),
      job_id: ctx.job.id,
      agent_id: ctx.agent.id,
      opportunity_id: ctx.opportunity?.id ?? null,
    });
  }

  // ================================================================== Einnahmen, Leitplanken, Portfolio

  addFinanceEntry(
    e: { opportunity_id?: string | null; kind: FinanceKind; amount_eur?: number | null; hours?: number | null; date?: string | null; note?: string | null },
    actor = 'owner',
  ): FinanceEntry {
    if (e.opportunity_id) this.store.opportunities.require(e.opportunity_id);
    const date = e.date && /^\d{4}-\d{2}-\d{2}$/.test(e.date) ? e.date : localDay(new Date());
    if (e.kind === 'time' ? !(num(e.hours) > 0) : !(num(e.amount_eur) > 0)) {
      throw new ValidationError(e.kind === 'time' ? 'Bitte Stunden angeben' : 'Bitte einen Betrag in € angeben');
    }
    const entry = this.store.finance.create({
      opportunity_id: e.opportunity_id ?? null,
      kind: e.kind,
      amount_eur: e.kind === 'time' ? null : Math.round(num(e.amount_eur) * 100) / 100,
      hours: e.kind === 'time' ? Math.round(num(e.hours) * 100) / 100 : null,
      date,
      note: (e.note ?? '').trim().slice(0, 500),
    });
    this.audit(actor, 'finance.added', 'finance', entry.id, 0, { kind: entry.kind, amount_eur: entry.amount_eur, hours: entry.hours, opportunity_id: entry.opportunity_id });
    this.changed('finance', entry.id);
    return entry;
  }

  deleteFinanceEntry(id: number, actor = 'owner'): void {
    const e = this.store.finance.delete(id);
    this.audit(actor, 'finance.deleted', 'finance', id, 0, { kind: e.kind, amount_eur: e.amount_eur, hours: e.hours, opportunity_id: e.opportunity_id });
    this.changed('finance', id);
  }

  guardrails(now = new Date()): GuardrailStatus {
    const s = this.settings;
    const ids = this.slotsUsed();
    const iso = now.getDay() || 7;
    const weekStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (iso - 1));
    const hours = this.store.finance.totals({ kind: 'time', from: localDay(weekStart) }).hours;
    return {
      parallel: { used: ids.length, max: s.guard_max_parallel, ids },
      owner_hours_week: { used: Math.round(hours * 100) / 100, max: s.guard_owner_hours_week, week_start: localDay(weekStart) },
      test_budget_eur: s.guard_test_budget_eur,
      test_owner_hours: s.guard_test_owner_hours,
      fixed_costs_eur_month: s.guard_fixed_costs_eur_month,
    };
  }

  /** Tests und Produkte mit Einnahmen, Ausgaben, Owner-Zeit und KI-Kosten (Grundlage für Abbruchregel und Review). */
  portfolioItems(now = new Date()): PortfolioItem[] {
    const all = this.store.finance.totalsByOpportunity();
    const month = this.store.finance.totalsByOpportunity({ from: localDay(monthStart(now)) });
    const last30 = this.store.finance.totalsByOpportunity({ from: localDay(new Date(now.getTime() - 30 * 86400_000)) });
    const ledger = new Map(this.store.ledger.grouped('opportunity_id').map((r) => [r.key, r]));
    return this.store.opportunities
      .list({ status: [...PORTFOLIO_STATUSES, 'STOPPED'] })
      .filter((o) => o.status !== 'STOPPED' || all.has(o.id))
      .map((o) => ({
        id: o.id,
        title: o.title,
        status: o.status,
        score: o.score,
        test_status: o.test?.status ?? null,
        test_ends_at: o.test?.ends_at ?? null,
        fixed_costs_eur_month: o.fixed_costs_eur_month,
        total: all.get(o.id) ?? emptyTotals(),
        month: month.get(o.id) ?? emptyTotals(),
        last30: last30.get(o.id) ?? emptyTotals(),
        ai_cost_usd: ledger.get(o.id)?.monetary_cost_usd ?? 0,
        ai_equivalent_usd: ledger.get(o.id)?.equivalent_cost_usd ?? 0,
        portfolio_note: o.portfolio_note,
      }));
  }

  /** Deterministische Portfolio-Kennzahlen für den Review – das Modell rechnet nicht selbst. */
  portfolioFacts(now = new Date()): string {
    const g = this.guardrails(now);
    const items = this.portfolioItems(now).filter((i) => i.status !== 'STOPPED');
    const lines: string[] = [
      '### Leitplanken',
      `- Plätze für Tests/Projekte: ${g.parallel.used} von ${g.parallel.max} belegt${g.parallel.ids.length ? ` (${g.parallel.ids.join(', ')})` : ''}`,
      `- Owner-Zeit diese Woche (seit ${g.owner_hours_week.week_start}): ${g.owner_hours_week.used} von ${g.owner_hours_week.max} Std.`,
      `- Je Test höchstens ${eur(g.test_budget_eur)} und ${g.test_owner_hours} Std.; Fixkosten je Produkt höchstens ${eur(g.fixed_costs_eur_month)}/Monat, solange nicht durch Erträge gedeckt`,
      '### Laufende Tests und Produkte',
    ];
    if (!items.length) lines.push('(keine)');
    for (const i of items) {
      const o = this.store.opportunities.require(i.id);
      const t = o.test;
      const tasks = this.store.tasks.listForOpportunity(o.id);
      lines.push(`#### ${o.id} ${o.title} [${OPPORTUNITY_STATUS_LABELS[o.status]}] Score ${o.score ?? '–'}`);
      if (t) {
        lines.push(
          `- Nachfragetest (Versuch ${t.attempt}): ${TEST_STATUS_LABELS[t.status]}; Kanal: ${t.plan.channel}; Erfolgskriterium: ${t.plan.success_criterion}; ` +
            `Laufzeit ${t.plan.duration_days} Tage${t.started_at ? `, gestartet ${t.started_at.slice(0, 10)}` : ''}${t.ends_at ? `, Ende ${t.ends_at.slice(0, 10)}` : ''}` +
            `${t.result ? `; Ergebnis: ${t.result.notes.slice(0, 300)}` : ''}${t.evaluation ? `; Auswertung: ${TEST_VERDICT_LABELS[t.evaluation.verdict]}` : ''}`,
        );
      }
      lines.push(
        `- Einnahmen: gesamt ${eur(i.total.revenue_eur)}, dieser Monat ${eur(i.month.revenue_eur)}, letzte 30 Tage ${eur(i.last30.revenue_eur)}`,
        `- Ausgaben: gesamt ${eur(i.total.expense_eur)}, letzte 30 Tage ${eur(i.last30.expense_eur)}; Fixkosten: ${i.fixed_costs_eur_month != null ? `${eur(i.fixed_costs_eur_month)}/Monat` : 'nicht erfasst'}`,
        `- Owner-Zeit: gesamt ${i.total.hours} Std., letzte 30 Tage ${i.last30.hours} Std.`,
        `- KI-Kosten: real $${i.ai_cost_usd.toFixed(2)}, Gegenwert $${i.ai_equivalent_usd.toFixed(2)}`,
      );
      if (tasks.length) lines.push(`- Tasks: ${tasks.filter((x) => x.status === 'DONE').length} von ${tasks.length} erledigt`);
      if (o.portfolio_note) {
        lines.push(`- Letzte Empfehlung (${o.portfolio_note.at.slice(0, 10)}): ${PORTFOLIO_RECOMMENDATION_LABELS[o.portfolio_note.recommendation]} – ${o.portfolio_note.reason}`);
      }
    }
    const candidates = this.store.opportunities
      .list({ status: ['PROPOSED', 'EVALUATION'] })
      .filter((o) => o.score != null)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 5);
    lines.push('### Kandidaten für den nächsten Test', candidates.map((o) => `- ${o.id} ${o.title} – Score ${o.score} [${OPPORTUNITY_STATUS_LABELS[o.status]}]`).join('\n') || '(keine)');
    const general = this.store.finance.totalsByOpportunity().get('');
    if (general) {
      lines.push('### Buchungen ohne Produktbezug (gesamt)', `- Einnahmen ${eur(general.revenue_eur)}, Ausgaben ${eur(general.expense_eur)}, Owner-Zeit ${general.hours} Std.`);
    }
    return lines.join('\n');
  }

  applyPortfolioReview(
    ctx: JobContext,
    out: {
      summary_markdown: string;
      items: { opportunity_id: string; recommendation: PortfolioRecommendation; reason: string; forecast: string }[];
      next_test_candidate_id: string;
      next_test_reason: string;
      owner_actions: string[];
    },
  ): void {
    const valid = new Set(this.portfolioItems().filter((i) => i.status !== 'STOPPED').map((i) => i.id));
    const rows: string[] = [];
    const at = new Date().toISOString();
    const seen = new Set<string>();
    for (const item of out.items ?? []) {
      const id = String(item.opportunity_id ?? '').trim().toUpperCase();
      if (!valid.has(id) || seen.has(id)) continue;
      seen.add(id);
      const rec = PORTFOLIO_RECOMMENDATIONS.find((x) => x === item.recommendation) ?? 'keep';
      this.store.opportunities.update(id, { portfolio_note: { recommendation: rec, reason: item.reason, forecast: item.forecast, job_id: ctx.job.id, at } });
      this.changed('opportunity', id);
      rows.push(`| ${id} | ${PORTFOLIO_RECOMMENDATION_LABELS[rec]} | ${item.reason.replace(/\|/g, '/')} | ${item.forecast.replace(/\|/g, '/')} |`);
      if (rec === 'stop') this.requestStop(id, `Portfolio-Review: ${item.reason}`, `agent:${ctx.agent.id}`);
    }
    const candidateId = String(out.next_test_candidate_id ?? '').trim().toUpperCase();
    const candidate = candidateId ? this.store.opportunities.get(candidateId) : undefined;
    const md = [
      `# ${ctx.job.title}`,
      '',
      out.summary_markdown,
      '',
      '## Empfehlungen',
      '| Opportunity | Empfehlung | Begründung | Prognose |',
      '|---|---|---|---|',
      ...(rows.length ? rows : ['| – | – | keine laufenden Tests oder Produkte | – |']),
      '',
      '## Nächster Testkandidat',
      candidate ? `${candidate.id} ${candidate.title}: ${out.next_test_reason}` : 'keiner',
      '',
      '## Für dich',
      ...(out.owner_actions?.length ? out.owner_actions.map((a) => `- ${a}`) : ['- nichts zu tun']),
    ].join('\n');
    this.memory.saveArtifact(this.store, {
      area: 'decisions',
      kind: 'portfolio_review',
      title: ctx.job.title,
      content: md,
      summary: String(out.summary_markdown ?? '').replace(/[#*_`>|]/g, '').trim().slice(0, 400),
      job_id: ctx.job.id,
      agent_id: ctx.agent.id,
    });
  }

  /** Hinweise zu Tests, Leitplanken und Fixkosten für die Übersicht. */
  businessAlerts(now = new Date()): { level: 'info' | 'warn' | 'error'; text: string; link?: string }[] {
    const out: { level: 'info' | 'warn' | 'error'; text: string; link?: string }[] = [];
    const g = this.guardrails(now);
    if (g.parallel.used > g.parallel.max) {
      out.push({ level: 'warn', text: `Leitplanke überschritten: ${g.parallel.used} Tests/Projekte gleichzeitig (höchstens ${g.parallel.max})`, link: '#/portfolio' });
    }
    if (g.owner_hours_week.max > 0 && g.owner_hours_week.used >= g.owner_hours_week.max) {
      out.push({ level: 'warn', text: `Owner-Zeit diese Woche ausgeschöpft: ${g.owner_hours_week.used} von ${g.owner_hours_week.max} Std.`, link: '#/portfolio' });
    } else if (g.owner_hours_week.max > 0 && g.owner_hours_week.used >= 0.8 * g.owner_hours_week.max) {
      out.push({ level: 'info', text: `Owner-Zeit diese Woche: ${g.owner_hours_week.used} von ${g.owner_hours_week.max} Std.`, link: '#/portfolio' });
    }
    for (const o of this.store.opportunities.list({ status: ['TESTING'] })) {
      const t = o.test;
      if (t?.status === 'READY') out.push({ level: 'info', text: `${o.id}: Testpaket bereit – deine Schritte erledigen, dann „Test ist live“`, link: `#/opportunities/${o.id}` });
      if (t?.status === 'RUNNING' && t.ends_at && t.ends_at <= now.toISOString()) {
        out.push({ level: 'warn', text: `${o.id}: Nachfragetest ist abgelaufen – bitte Ergebnis erfassen`, link: `#/opportunities/${o.id}` });
      }
    }
    for (const i of this.portfolioItems(now)) {
      if (i.status === 'STOPPED' || i.fixed_costs_eur_month == null) continue;
      if (i.fixed_costs_eur_month > g.fixed_costs_eur_month && i.last30.revenue_eur < i.fixed_costs_eur_month) {
        out.push({
          level: 'warn',
          text: `${i.id}: Fixkosten ${eur(i.fixed_costs_eur_month)}/Monat über der Leitplanke (${eur(g.fixed_costs_eur_month)}) und nicht durch Erträge gedeckt`,
          link: `#/opportunities/${i.id}`,
        });
      }
    }
    return out;
  }

  // ================================================================== Bilder

  /** Gibt es einen aktiven Bild-Provider mit mindestens einem Modell? */
  hasImageProvider(): boolean {
    return this.store.providers.list().some((p) => p.enabled && providerKind(p.type) === 'image' && this.store.models.list(p.id).some((m) => m.enabled));
  }

  /** Bildanfragen eines Agents als Bild-Jobs einreihen (höchstens 4 je Ergebnis). */
  requestImages(ctx: JobContext, requests: ImageRequest[] | undefined): string[] {
    const list = (requests ?? []).filter((r) => r && String(r.prompt ?? '').trim()).slice(0, 4);
    if (!list.length) return [];
    if (!this.hasImageProvider()) {
      return [
        `${list.length} Bildanfrage(n) nicht ausgeführt – kein Bild-Provider aktiv (Provider & Modelle → ChatGPT-Abo oder OpenAI-Bild-API): ` +
          list.map((r) => r.file_name || String(r.prompt).slice(0, 40)).join(', '),
      ];
    }
    const notes: string[] = [];
    for (const r of list) {
      try {
        const job = this.createJob({
          type: 'image_generation',
          opportunity_id: ctx.opportunity?.id ?? null,
          parent_job_id: ctx.job.id,
          created_by: `job:${ctx.job.id}`,
          automatic: true,
          input: { prompt: r.prompt, file_name: r.file_name, aspect: r.aspect, transparent: !!r.transparent, purpose: r.purpose },
        });
        if (job) notes.push(`Bild-Job #${job.id}: ${r.file_name || String(r.prompt).slice(0, 60)}`);
      } catch (e) {
        notes.push(`Bildanfrage ${r.file_name || ''}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return notes;
  }

  /** Speichert ein erzeugtes Bild im Gedächtnis (media/) und – mit Opportunity – im Workspace unter assets/. */
  async saveGeneratedImage(ctx: JobContext, result: ImageCallResult): Promise<Record<string, unknown>> {
    const base =
      String(ctx.job.input.file_name ?? '')
        .trim()
        .toLowerCase()
        .replace(/\.(png|jpe?g|webp)$/i, '')
        .replace(/[^a-z0-9äöüß_-]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'bild';
    const name = `${base}-${ctx.job.id}.png`;
    const oppId = ctx.opportunity?.id ?? null;
    const rel = `media/${oppId ?? 'allgemein'}/${name}`;
    this.memory.writeBinary(rel, result.image);
    let workspaceFile: string | null = null;
    if (oppId) {
      const ws = this.memory.workspaceDir(oppId);
      workspaceFile = `assets/${name}`;
      fs.mkdirSync(path.join(ws, 'assets'), { recursive: true });
      fs.writeFileSync(path.join(ws, workspaceFile), result.image);
      await commitWorkspace(ws, `${oppId}: Bild ${name}`);
    }
    const prompt = String(ctx.job.input.prompt ?? '');
    this.store.artifacts.create({
      kind: 'image',
      title: `Bild: ${base}`,
      path: rel,
      format: 'png',
      size: result.image.length,
      summary: `${prompt}${result.revisedPrompt ? ` (überarbeitet: ${result.revisedPrompt})` : ''}`.slice(0, 500),
      job_id: ctx.job.id,
      agent_id: ctx.agent.id,
      opportunity_id: oppId,
      task_id: null,
    });
    this.audit(`agent:${ctx.agent.id}`, 'image.created', 'job', ctx.job.id, 1, { file: rel, workspace_file: workspaceFile, bytes: result.image.length, model: result.model });
    this.changed('memory');
    if (oppId) this.changed('opportunity', oppId);
    return { file: rel, workspace_file: workspaceFile, bytes: result.image.length, model: result.model, revised_prompt: result.revisedPrompt };
  }

  // ================================================================== Provider

  providerViews(now = new Date()): ProviderView[] {
    const running = this.store.jobs.runningCountByProvider();
    return this.store.providers.list().map((p) => {
      const envName = typeof p.config.api_key_env === 'string' ? p.config.api_key_env : undefined;
      return {
        ...p,
        quota: computeQuota(this.store, p, now, running[p.id] ?? 0),
        secret: this.secrets.describe(p.id, envName),
      };
    });
  }

  providerView(id: string): ProviderView {
    const v = this.providerViews().find((p) => p.id === id);
    if (!v) throw new NotFoundError(`Provider ${id}`);
    return v;
  }

  async testProvider(id: string): Promise<{ ok: boolean; message: string }> {
    const provider = this.store.providers.require(id);
    let result: { ok: boolean; message: string };
    try {
      result = await createAdapter(provider, { secrets: this.secrets, dataDir: this.dataDir }).healthCheck();
    } catch (e) {
      result = { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    this.store.providers.setState(id, {
      health_status: result.ok ? 'ok' : 'error',
      health_message: result.message,
      health_checked_at: new Date().toISOString(),
    });
    this.changed('provider', id);
    if (result.ok) this.providerChanged(id);
    return result;
  }

  /** Nach Konfigurationsänderungen: blockierte/wartende Jobs dieses Providers erneut prüfen lassen. */
  providerChanged(id: string): void {
    const unblocked = this.store.jobs.unblock({ provider_id: id });
    const woken = this.store.jobs.wakeWaiting(new Date().toISOString(), id);
    if (unblocked.length || woken.length) {
      this.audit('system', 'jobs.requeued', 'provider', id, 0, { unblocked: unblocked.length, woken: woken.length });
      this.changed('job');
      this.bus.emit('scheduler.wake');
    }
  }

  /** Kontingent manuell zurücksetzen (Konzept §6: manuell aktualisiertes Kontingent aktiviert wartende Jobs). */
  resetProviderQuota(id: string, actor = 'owner'): void {
    this.store.providers.require(id);
    this.store.providers.setState(id, { quota_counter_reset_at: new Date().toISOString(), exhausted_until: null, exhausted_reason: null });
    this.audit(actor, 'provider.quota_reset', 'provider', id, 0, {});
    this.bus.emit('provider.quota_reset', 'provider', id);
    this.providerChanged(id);
    this.changed('provider', id);
  }

  systemBudget(now = new Date()) {
    return systemBudget(this.store, this.settings, now);
  }

  /** Workspace-Inhalt zu einer Opportunity (für die Oberfläche). */
  workspaceFiles(oppId: string): { path: string; size: number }[] {
    const dir = this.memory.workspaceDir(oppId);
    const out: { path: string; size: number }[] = [];
    const walk = (d: string) => {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === '.git' || e.name === 'node_modules') continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else out.push({ path: path.relative(dir, full).split(path.sep).join('/'), size: fs.statSync(full).size });
      }
    };
    walk(dir);
    return out.sort((a, b) => a.path.localeCompare(b.path)).slice(0, 2000);
  }
}

import fs from 'node:fs';
import path from 'node:path';
import {
  APPROVAL_TYPE_LABELS,
  type Approval,
  type Job,
  type Opportunity,
  type OpportunityStatus,
  type ProviderPolicy,
  type ProviderView,
  type Task,
} from '../../shared/domain.ts';
import type { EventBus } from '../events.ts';
import { createAdapter } from '../providers/registry.ts';
import type { Store } from '../repo/store.ts';
import { ConflictError, NotFoundError, ValidationError } from '../repo/util.ts';
import type { SecretStore } from '../secrets.ts';
import { commitWorkspace } from './git.ts';
import { jobType } from './jobtypes/index.ts';
import { clamp, normalizeTitle } from './jobtypes/common.ts';
import type { CompletionInfo, JobContext } from './jobtypes/types.ts';
import { CompanyMemory, type MemoryArea } from './memory.ts';
import { computeQuota, systemBudget } from './quota.ts';
import { computeScore } from './scoring.ts';

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
    const allowed: (keyof Opportunity)[] = ['title', 'problem', 'target_customer', 'proposed_solution', 'competition_summary', 'revenue_model', 'notes', 'sources'];
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
        return { opportunity: this.propose(id, 'owner') };
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
      case 'hold':
        return { opportunity: this.setOpportunityStatus(id, 'ON_HOLD', reason ?? 'vom Owner zurückgestellt') };
      case 'reopen':
        return { opportunity: this.setOpportunityStatus(id, 'DISCOVERED', reason) };
      default:
        throw new ValidationError(`Unbekannte Aktion: ${action}`);
    }
  }

  private cancelOpenWork(oppId: string): void {
    for (const j of this.store.jobs.openForOpportunity(oppId)) {
      if (j.status !== 'RUNNING') this.cancelJob(j.id, 'system');
    }
    for (const a of this.store.approvals.pending(undefined, oppId)) this.store.approvals.decide(a.id, 'CANCELLED', 'Opportunity verworfen');
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

  applyScreening(ctx: JobContext, out: { results: { id: string; decision: 'PASS' | 'REJECT'; market_score: number; technical_score: number; risk_score: number; reason: string }[] }): void {
    const ids = (Array.isArray(ctx.job.input.opportunity_ids) ? ctx.job.input.opportunity_ids : []) as string[];
    const threshold = this.settings.deep_research_threshold;
    const seen = new Set<string>();
    for (const r of out.results) {
      const id = String(r.id ?? '').trim().toUpperCase();
      if (!ids.includes(id) || seen.has(id)) continue;
      seen.add(id);
      const opp = this.store.opportunities.get(id);
      if (!opp || !['SCREENING', 'DISCOVERED'].includes(opp.status)) continue;
      const m = clamp(r.market_score, 0, 10);
      const t = clamp(r.technical_score, 0, 10);
      const k = clamp(r.risk_score, 0, 10);
      const score = computeScore(this.settings, m, t, k);
      this.store.opportunities.update(id, { market_score: m, technical_score: t, risk_score: k, score });
      this.memory.saveArtifact(this.store, {
        area: 'opportunities',
        kind: 'screening_note',
        title: `Screening ${id}`,
        content: `# Screening ${id}\n\nEntscheidung: **${r.decision}** – Score ${score ?? '–'} (Schwelle ${threshold})\n\nMarkt ${m} · Technik ${t} · Risiko ${k}\n\n${r.reason}`,
        summary: `${r.decision}, Score ${score}: ${r.reason}`,
        job_id: ctx.job.id,
        agent_id: ctx.agent.id,
        opportunity_id: id,
      });
      if (r.decision === 'PASS' && score != null && score >= threshold) {
        // Konzept §15: "Opportunity score > threshold -> Deep Research"
        this.setOpportunityStatus(id, 'RESEARCH', `Screening bestanden (Score ${score})`);
        this.createJob({ type: 'deep_research', opportunity_id: id, parent_job_id: ctx.job.id, automatic: true });
      } else {
        const why = r.decision === 'PASS' ? `Score ${score} unter Schwelle ${threshold}` : 'Screening: abgelehnt';
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

  applyResearch(ctx: JobContext, out: { report_markdown: string; problem: string; target_customer: string; proposed_solution: string; competition_summary: string; revenue_model: string; market_notes: string; key_risks: string[]; sources: { title: string; url: string; note?: string }[] }): void {
    const opp = ctx.opportunity!;
    const sources = [...opp.sources];
    for (const s of out.sources ?? []) if (s?.url && !sources.some((x) => x.url === s.url)) sources.push(s);
    this.store.opportunities.update(opp.id, {
      problem: out.problem || opp.problem,
      target_customer: out.target_customer || opp.target_customer,
      proposed_solution: out.proposed_solution || opp.proposed_solution,
      competition_summary: out.competition_summary || opp.competition_summary,
      revenue_model: out.revenue_model || opp.revenue_model,
      sources: sources.slice(0, 25),
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
    this.setOpportunityStatus(opp.id, 'EVALUATION', null);
    this.createJob({ type: 'evaluation', opportunity_id: opp.id, parent_job_id: ctx.job.id, automatic: true });
  }

  applyEvaluation(ctx: JobContext, out: { market_score: number; technical_score: number; risk_score: number; confidence: number; recommendation: 'GO' | 'NO_GO'; rationale: string; mvp_outline: string; estimated_effort: string }): void {
    const opp = ctx.opportunity!;
    const m = clamp(out.market_score, 0, 10);
    const t = clamp(out.technical_score, 0, 10);
    const k = clamp(out.risk_score, 0, 10);
    const confidence = clamp(out.confidence, 0, 1);
    const score = computeScore(this.settings, m, t, k);
    this.store.opportunities.update(opp.id, { market_score: m, technical_score: t, risk_score: k, confidence, score });
    const md = [
      `# Bewertung ${opp.id}: ${opp.title}`,
      '',
      `**Empfehlung: ${out.recommendation}** · Gesamt-Score ${score ?? '–'} · Konfidenz ${confidence ?? '–'}`,
      '',
      `| Markt | Technik | Risiko |`,
      `|---|---|---|`,
      `| ${m} | ${t} | ${k} |`,
      '',
      '## Begründung',
      out.rationale,
      '',
      '## MVP-Skizze',
      out.mvp_outline,
      '',
      `**Aufwand:** ${out.estimated_effort}`,
    ].join('\n');
    this.memory.saveArtifact(this.store, {
      area: 'research',
      kind: 'evaluation',
      title: `Bewertung ${opp.id}`,
      content: md,
      summary: `${out.recommendation}, Score ${score}: ${out.rationale.slice(0, 300)}`,
      job_id: ctx.job.id,
      agent_id: ctx.agent.id,
      opportunity_id: opp.id,
    });
    const threshold = this.settings.proposal_threshold;
    if (out.recommendation === 'GO' && score != null && score >= threshold) {
      this.propose(opp.id, `agent:${ctx.agent.id}`);
    } else {
      const why = out.recommendation === 'GO' ? `Score ${score} unter Vorschlags-Schwelle ${threshold}` : 'Bewertung: NO_GO';
      this.setOpportunityStatus(opp.id, 'REJECTED', `${why} – ${out.rationale}`.slice(0, 500));
    }
  }

  /** Legt die Opportunity dem Owner zur Freigabe des Projektstarts vor (Approval-Level 2). */
  propose(oppId: string, actor: string): Opportunity {
    const opp = this.store.opportunities.require(oppId);
    if (['DEVELOPMENT', 'REVIEW', 'READY', 'DEPLOYED', 'APPROVED'].includes(opp.status)) throw new ConflictError('Projekt läuft bereits');
    const updated = this.setOpportunityStatus(oppId, 'PROPOSED', null);
    if (!this.store.approvals.pending('PROJECT_START', oppId).length) {
      const evaluation = this.store.artifacts.latest(oppId, 'evaluation');
      const approval = this.store.approvals.create({
        type: 'PROJECT_START',
        level: 2,
        title: `Projektstart: ${opp.id} ${opp.title}`,
        summary: evaluation ? this.memory.readArtifact(evaluation).slice(0, 4000) : `${opp.problem}\n\nLösung: ${opp.proposed_solution}`,
        payload: { score: opp.score, market_score: opp.market_score, technical_score: opp.technical_score, risk_score: opp.risk_score },
        opportunity_id: oppId,
      });
      this.audit(actor, 'approval.requested', 'approval', approval.id, 2, { type: 'PROJECT_START', opportunity_id: oppId });
      this.changed('approval', approval.id);
    }
    return updated;
  }

  // ---------------------------------------------------------------- Freigaben (Konzept §14)

  decideApproval(id: number, decision: 'APPROVED' | 'REJECTED', note?: string | null, actor = 'owner'): Approval {
    const approval = this.store.approvals.require(id);
    if (approval.status !== 'PENDING') throw new ConflictError('Freigabe wurde bereits entschieden');
    const decided = this.store.approvals.decide(id, decision, note ?? null);
    this.audit(actor, decision === 'APPROVED' ? 'approval.approved' : 'approval.rejected', 'approval', id, approval.level, {
      type: approval.type,
      opportunity_id: approval.opportunity_id,
      job_id: approval.job_id,
      note,
    });
    this.recordDecision(decided);

    switch (approval.type) {
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

  async applyImplementation(ctx: JobContext, out: { summary: string; files_changed: string[]; notes_for_reviewer: string; open_issues: string[] }, info: CompletionInfo): Promise<void> {
    const task = ctx.task!;
    const opp = ctx.opportunity!;
    const files = [...new Set([...(info.filesChanged ?? []), ...(out.files_changed ?? [])])].slice(0, 200);
    const commit = await commitWorkspace(this.memory.workspaceDir(opp.id), `${task.id}: ${task.title}`);
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
        ...tasks.map((t) => `- ${t.key} ${t.title}: ${t.last_review?.summary ?? t.status}`),
        '',
        `Workspace: ${path.relative(process.cwd(), this.memory.workspaceDir(oppId)) || this.memory.workspaceDir(oppId)}`,
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
          if (!['REJECTED', 'DEPLOYED'].includes(opp.status)) this.setOpportunityStatus(opp.id, 'RESEARCH', 'Auftrag der Leitung');
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

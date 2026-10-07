import type { Agent, Job, Model, Provider } from '../../shared/domain.ts';
import { planInfoByProvider } from '../providers/claude-cli.ts';
import { createAdapter, createImageAdapter } from '../providers/registry.ts';
import { ProviderError, type CallUsage, type ModelCallRequest, type ProviderAdapter } from '../providers/types.ts';
import { extractJson } from './json.ts';
import { jobType } from './jobtypes/index.ts';
import type { JobTypeDef } from './jobtypes/types.ts';
import type { Orchestrator } from './orchestrator.ts';
import { buildSystemPrompt, clip, composeUserPrompt } from './prompt.ts';
import { computeQuota, periodWindow, priceOf } from './quota.ts';
import { Router, type Candidate } from './router.ts';
import { describeZodError, toJsonSchema } from './schema.ts';
import { Workspace } from './workspace.ts';

const ESTIMATED_RESET_MS = 30 * 60_000; // unbekannter Reset: in 30 Minuten erneut prüfen

export type DispatchResult = { started: false } | { started: true; providerId: string; done: Promise<void> };

/** Führt einzelne Jobs aus: Routing-Entscheidung, Prompt, Provider-Aufruf, Ergebnisprüfung, Ledger, Folgeaktionen. */
export class JobRunner {
  readonly router: Router;
  private readonly running = new Map<number, AbortController>();

  constructor(private readonly orch: Orchestrator) {
    this.router = new Router(orch.store);
    orch.bus.on((ev) => {
      if (ev.type === 'job.cancel' && typeof ev.id === 'number') this.running.get(ev.id)?.abort();
    });
  }

  get runningCount(): number {
    return this.running.size;
  }

  isRunning(id: number): boolean {
    return this.running.has(id);
  }

  abortAll(): void {
    for (const c of this.running.values()) c.abort();
  }

  private get store() {
    return this.orch.store;
  }

  private log(jobId: number, msg: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    this.store.jobs.appendLog(jobId, level, msg);
  }

  /** Prüft einen eingereihten Job und startet ihn, falls ein Provider verfügbar ist. */
  dispatch(job: Job, runningByProvider: Record<string, number>): DispatchResult {
    const def = jobType(job.type);
    if (!def) {
      this.fail(job, `Unbekannter Job-Typ ${job.type}`);
      return { started: false };
    }
    const agent = job.agent_id ? this.store.agents.get(job.agent_id) : undefined;
    if (!agent) {
      this.park(job, 'BLOCKED', 'Zuständiger Agent existiert nicht mehr – Job einem anderen Agent zuweisen oder abbrechen', null);
      return { started: false };
    }
    if (!agent.enabled) {
      this.park(job, 'BLOCKED', `Agent ${agent.name} ist deaktiviert`, null);
      return { started: false };
    }
    const route = this.store.routes.get(job.type);
    const capability = (job.type !== 'custom' && route?.capability_override) || agent.capability;
    const settings = this.orch.settings;
    const now = new Date();
    const decision = this.router.route({ job, agent, capability, settings, now, runningByProvider, kind: def.providerKind ?? 'llm' });

    switch (decision.kind) {
      case 'defer':
        if (job.wait_reason !== decision.reason) {
          this.store.jobs.update(job.id, { wait_reason: decision.reason });
          this.orch.changed('job', job.id);
        }
        return { started: false };
      case 'wait': {
        const until = decision.until ?? new Date(now.getTime() + ESTIMATED_RESET_MS).toISOString();
        this.store.jobs.update(job.id, {
          status: 'WAITING_FOR_PROVIDER_QUOTA',
          not_before: until,
          waiting_provider_id: decision.providerId,
          wait_reason: `${decision.reason} – Wiederaufnahme ${decision.until ? 'ab' : 'geschätzt ab'} ${until}`,
        });
        this.log(job.id, `Wartet auf Kontingent: ${decision.reason}`, 'warn');
        this.orch.changed('job', job.id);
        return { started: false };
      }
      case 'block':
        this.park(job, 'BLOCKED', decision.reason, decision.providerId);
        return { started: false };
      case 'approval':
        this.store.jobs.update(job.id, {
          status: 'WAITING_FOR_APPROVAL',
          wait_reason: `Freigabe für Provider-Wechsel nötig: ${decision.reason}`,
          waiting_provider_id: decision.primary.provider.id,
        });
        this.orch.requestProviderSwitch(
          job,
          { providerId: decision.primary.provider.id, until: computeQuota(this.store, decision.primary.provider, now).exhausted_until },
          { providerId: decision.alternative.provider.id, modelId: decision.alternative.model.id, label: `${decision.alternative.provider.name} / ${decision.alternative.model.label}` },
          decision.reason,
        );
        this.log(job.id, 'Wartet auf Owner-Freigabe für Provider-Wechsel', 'warn');
        this.orch.changed('job', job.id);
        return { started: false };
      case 'run': {
        const c = decision.candidate;
        this.store.jobs.update(job.id, {
          status: 'RUNNING',
          attempts: job.attempts + 1,
          started_at: now.toISOString(),
          provider_id: c.provider.id,
          model_id: c.model.id,
          wait_reason: null,
          waiting_provider_id: null,
          not_before: null,
          error: null,
        });
        this.log(job.id, `Start (Versuch ${job.attempts + 1}) mit ${c.provider.name} / ${c.model.label} [${capability}]${decision.note ? ` – ${decision.note}` : ''}`);
        if (decision.note) {
          this.orch.audit('system', 'router.fallback', 'job', job.id, 0, { provider: c.provider.id, model: c.model.model_name, note: decision.note });
        }
        this.orch.changed('job', job.id);
        const controller = new AbortController();
        this.running.set(job.id, controller);
        const done = this.execute(this.store.jobs.require(job.id), agent, def, c, controller).finally(() => {
          this.running.delete(job.id);
          this.orch.changed('job', job.id);
        });
        return { started: true, providerId: c.provider.id, done };
      }
    }
  }

  private park(job: Job, status: 'BLOCKED', reason: string, providerId: string | null): void {
    if (job.status === status && job.wait_reason === reason) return;
    this.store.jobs.update(job.id, { status, wait_reason: reason, waiting_provider_id: providerId });
    this.log(job.id, `Blockiert: ${reason}`, 'warn');
    this.orch.audit('system', 'job.blocked', 'job', job.id, 0, { reason });
    this.orch.changed('job', job.id);
  }

  private fail(job: Job, reason: string): void {
    const updated = this.store.jobs.update(job.id, { status: 'FAILED', error: reason.slice(0, 2000), finished_at: new Date().toISOString() });
    this.log(job.id, `Fehlgeschlagen: ${reason}`, 'error');
    this.orch.audit('system', 'job.failed', 'job', job.id, 0, { reason: reason.slice(0, 500) });
    this.orch.onJobEnded(updated, reason);
    this.orch.changed('job', job.id);
  }

  private cancelled(jobId: number): boolean {
    return this.store.jobs.get(jobId)?.status === 'CANCELLED';
  }

  /** Bild-Job: direkt beim Bild-Provider, ohne Sprachmodell. */
  private async executeImage(job: Job, agent: Agent, def: JobTypeDef, c: Candidate, controller: AbortController): Promise<void> {
    const { provider, model } = c;
    try {
      const ctx = this.orch.jobContext(job, agent);
      const spec = def.image!.request(ctx);
      if (!spec.prompt) throw new Error('Keine Bildbeschreibung angegeben');
      const adapter = createImageAdapter(provider, { secrets: this.orch.secrets, dataDir: this.orch.dataDir });
      const result = await adapter.generate({
        ...spec,
        model: model.model_name,
        timeoutMs: Math.max(60, agent.max_runtime_sec) * 1000,
        signal: controller.signal,
        log: (msg, level) => this.log(job.id, msg, level ?? 'info'),
      });
      this.recordUsage(job, agent, provider, model, result.usage, result.model, 'image');
      if (this.cancelled(job.id)) return;
      const fresh = this.orch.jobContext(this.store.jobs.require(job.id), agent);
      const output = await def.image!.complete(fresh, result, { providerId: provider.id });
      this.store.jobs.update(job.id, { status: 'COMPLETED', output, finished_at: new Date().toISOString(), error: null });
      this.log(job.id, `Abgeschlossen: ${String(output.file ?? '')}`);
      this.orch.audit(`agent:${agent.id}`, 'job.completed', 'job', job.id, 1, { type: job.type, provider: provider.id, model: result.model });
    } catch (e) {
      if (e instanceof ProviderError) this.handleProviderError(job, provider, e);
      else if (!this.cancelled(job.id)) this.fail(this.store.jobs.require(job.id), e instanceof Error ? e.message : String(e));
    }
  }

  private async execute(job: Job, agent: Agent, def: JobTypeDef, c: Candidate, controller: AbortController): Promise<void> {
    if (def.image) return this.executeImage(job, agent, def, c, controller);
    const { provider, model } = c;
    const settings = this.orch.settings;
    try {
      const ctx = this.orch.jobContext(job, agent);
      if (def.requiresOpportunity && !ctx.opportunity) throw new Error('Opportunity existiert nicht mehr');
      if (def.requiresTask && !ctx.task) throw new Error('Task existiert nicht mehr');

      // Werkzeuge: Schnittmenge aus Job-Typ und Agent-Berechtigung (Tool Gateway)
      let tools = def.tools.filter((t) => agent.tools.includes(t));
      const missing = def.tools.filter((t) => !agent.tools.includes(t) && (!t.startsWith('workspace_') || def.workspace));
      let workspace: ModelCallRequest['workspace'];
      if (def.workspace && ctx.opportunity && tools.some((t) => t.startsWith('workspace_'))) {
        workspace = { dir: this.orch.memory.workspaceDir(ctx.opportunity.id), writable: def.workspace === 'write' && tools.includes('workspace_write') };
      } else {
        tools = tools.filter((t) => !t.startsWith('workspace_'));
      }
      if (missing.length && job.type !== 'custom') this.log(job.id, `Agent hat keine Berechtigung für: ${missing.join(', ')}`, 'warn');

      const department = agent.department_id ? this.store.departments.get(agent.department_id) : undefined;
      const system = buildSystemPrompt(settings, agent, department);
      const schema = toJsonSchema(def.output);
      const { task, sections } = def.buildPrompt(ctx);
      const { prompt, truncated } = composeUserPrompt({
        jobLabel: def.label,
        jobId: job.id,
        task,
        sections,
        tools,
        maxToolCalls: agent.max_tool_calls,
        schema,
        outputHint: def.outputHint,
        maxInputTokens: Math.min(agent.max_input_tokens, model.context_window),
        systemPrompt: system,
        defaultSectionChars: settings.artifact_context_chars,
      });
      if (truncated.length) this.log(job.id, `Kontext gekürzt (Input-Limit): ${truncated.join(', ')}`, 'warn');

      const ws = workspace ? new Workspace(workspace.dir, workspace.writable) : null;
      const before = ws?.snapshot();
      const adapter = createAdapter(provider, { secrets: this.orch.secrets, dataDir: this.orch.dataDir });
      const maxOutputTokens = Math.max(1024, Math.min(agent.max_output_tokens, model.max_output_tokens));
      const billedProvider = provider.billing_mode === 'pay_as_you_go';

      const request: ModelCallRequest = {
        model: model.model_name,
        system,
        prompt,
        maxOutputTokens,
        tools,
        maxToolCalls: agent.max_tool_calls,
        effort: model.supports_effort ? agent.effort : null,
        outputSchema: schema,
        workspace,
        timeoutMs: Math.max(30, agent.max_runtime_sec) * 1000,
        signal: controller.signal,
        log: (msg, level) => this.log(job.id, msg, level ?? 'info'),
        onUsage: (u, actualModel) => this.recordUsage(job, agent, provider, model, u, actualModel, 'job'),
        guard: (total) => {
          const billed = total.billed ?? billedProvider;
          if (!billed || agent.max_job_cost_usd == null) return;
          const cost = priceOf(model, total);
          if (cost > agent.max_job_cost_usd) {
            throw new ProviderError('limit', `Kostenlimit pro Job ($${agent.max_job_cost_usd}) überschritten ($${cost.toFixed(3)})`);
          }
        },
      };

      let result;
      try {
        result = await adapter.call(request);
      } finally {
        this.persistPlanInfo(provider);
      }
      if (this.cancelled(job.id)) return;

      let output: unknown = result.structured ?? extractJson(result.text);
      let parsed = def.output.safeParse(output);
      if (!parsed.success) {
        this.log(job.id, `Ergebnis entspricht nicht dem Schema – Reparaturversuch: ${describeZodError(parsed.error).slice(0, 300)}`, 'warn');
        output = await this.repair(job, agent, provider, model, adapter, result.text || JSON.stringify(output ?? null), schema, describeZodError(parsed.error), controller.signal);
        parsed = def.output.safeParse(output);
      }
      if (!parsed.success) {
        this.orch.memory.saveArtifact(this.store, {
          area: 'knowledge',
          kind: 'raw_output',
          title: `Rohausgabe Job #${job.id} (ungültig)`,
          content: `# Rohausgabe Job #${job.id}\n\n${result.text || JSON.stringify(output, null, 2)}`,
          job_id: job.id,
          agent_id: agent.id,
          opportunity_id: job.opportunity_id,
          task_id: job.task_id,
        });
        throw new Error(`Ergebnis entspricht nicht dem erwarteten Format: ${describeZodError(parsed.error).slice(0, 500)}`);
      }

      const filesChanged = ws && before ? Workspace.diff(before, ws.snapshot()) : [];
      if (this.cancelled(job.id)) return;
      const fresh = this.orch.jobContext(this.store.jobs.require(job.id), agent);
      await def.complete(fresh, parsed.data, { providerId: provider.id, modelName: model.model_name, filesChanged });

      this.store.jobs.update(job.id, { status: 'COMPLETED', output: parsed.data, finished_at: new Date().toISOString(), error: null });
      this.log(job.id, 'Abgeschlossen');
      this.orch.audit(`agent:${agent.id}`, 'job.completed', 'job', job.id, def.workspace === 'write' ? 1 : 0, {
        type: job.type,
        provider: provider.id,
        model: model.model_name,
        files_changed: filesChanged.length || undefined,
      });
    } catch (e) {
      if (e instanceof ProviderError) this.handleProviderError(job, provider, e);
      else if (!this.cancelled(job.id)) this.fail(this.store.jobs.require(job.id), e instanceof Error ? e.message : String(e));
    }
  }

  private async repair(
    job: Job,
    agent: Agent,
    provider: Provider,
    model: Model,
    adapter: ProviderAdapter,
    raw: string,
    schema: Record<string, unknown>,
    errors: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    const result = await adapter.call({
      model: model.model_name,
      system: 'Du wandelst Arbeitsergebnisse verlustfrei in gültiges JSON gemäß einem vorgegebenen Schema um. Erfinde keine Inhalte.',
      prompt: [
        'Wandle das folgende Ergebnis in genau ein JSON-Objekt um, das dem Schema entspricht. Fehlende Pflichtfelder sinnvoll aus dem Text ableiten, sonst leer lassen.',
        '',
        'Validierungsfehler:',
        errors,
        '',
        'Schema:',
        '```json',
        JSON.stringify(schema),
        '```',
        '',
        'Ergebnis:',
        '"""',
        clip(raw, 40000),
        '"""',
      ].join('\n'),
      maxOutputTokens: Math.max(1024, Math.min(agent.max_output_tokens, model.max_output_tokens)),
      tools: [],
      maxToolCalls: 0,
      outputSchema: schema,
      timeoutMs: 300_000,
      signal,
      log: (msg, level) => this.log(job.id, `[Reparatur] ${msg}`, level ?? 'info'),
      onUsage: (u, actualModel) => this.recordUsage(job, agent, provider, model, u, actualModel, 'repair'),
    });
    return result.structured ?? extractJson(result.text);
  }

  private persistPlanInfo(provider: Provider): void {
    const info = planInfoByProvider.get(provider.id);
    if (!info) return;
    planInfoByProvider.delete(provider.id);
    this.store.providers.setState(provider.id, { plan_info: info });
    this.orch.changed('provider', provider.id);
  }

  /** Bucht einen einzelnen Modellaufruf ins Usage-/Kosten-Ledger (Konzept §12). */
  recordUsage(job: Job | null, agent: Agent | null, provider: Provider, model: Model | undefined, u: CallUsage, actualModel: string, purpose: string): void {
    const equivalent = priceOf(model, u);
    const billed = u.billed ?? provider.billing_mode === 'pay_as_you_go';
    const monetary = billed ? equivalent : 0;
    const now = new Date();
    const fresh = this.store.providers.get(provider.id) ?? provider;
    const quota = computeQuota(this.store, fresh, now);
    const remainingAfter =
      quota.limit == null
        ? null
        : Math.max(0, quota.limit - quota.used - (fresh.quota_unit === 'tokens' ? u.inputTokens + u.outputTokens : fresh.quota_unit === 'requests' ? Math.max(1, u.requests) : equivalent));
    this.store.ledger.add({
      job_id: job?.id ?? null,
      job_type: job?.type ?? null,
      agent_id: agent?.id ?? null,
      provider_id: provider.id,
      model_id: model?.id ?? null,
      model_name: actualModel || model?.model_name || null,
      opportunity_id: job?.opportunity_id ?? null,
      purpose,
      billing_mode: billed ? 'pay_as_you_go' : 'subscription',
      input_tokens: u.inputTokens,
      output_tokens: u.outputTokens,
      cache_read_tokens: u.cacheReadTokens,
      cache_write_tokens: u.cacheWriteTokens,
      requests: Math.max(1, u.requests),
      tool_calls: u.toolCalls,
      provider_units: u.webSearches || null,
      monetary_cost_usd: monetary,
      equivalent_cost_usd: equivalent,
      quota_period: periodWindow(fresh, now).key,
      quota_remaining: remainingAfter,
      duration_ms: null,
      success: true,
    });
    if (job) this.store.jobs.addUsage(job.id, { input: u.inputTokens, output: u.outputTokens, cost: monetary, equivalent });
    this.orch.changed('ledger');
  }

  private handleProviderError(job: Job, provider: Provider, err: ProviderError): void {
    const current = this.store.jobs.get(job.id);
    if (!current || current.status === 'CANCELLED') return;
    const now = new Date();
    switch (err.kind) {
      case 'cancelled':
        this.store.jobs.update(job.id, { status: 'CANCELLED', finished_at: now.toISOString() });
        return;
      case 'quota': {
        // Konzept §5: kein automatischer Wechsel – warten bis zum (bekannten oder geschätzten) Reset
        const until = err.resetAt && err.resetAt > now.toISOString() ? err.resetAt : new Date(now.getTime() + ESTIMATED_RESET_MS).toISOString();
        this.store.providers.setState(provider.id, { exhausted_until: until, exhausted_reason: err.message.slice(0, 300) });
        this.orch.audit('system', 'provider.exhausted', 'provider', provider.id, 0, { until, estimated: !err.resetAt, job_id: job.id });
        this.orch.changed('provider', provider.id);
        // Der Job wird neu geroutet: Der Router sieht den erschöpften Provider und wendet die Policy an
        // (WAIT -> wartet bis zum Reset, BLOCK -> blockiert, FALLBACK/OWNER_APPROVAL -> expliziter Wechsel).
        this.store.jobs.update(job.id, {
          status: 'QUEUED',
          attempts: Math.max(0, current.attempts - 1),
          not_before: null,
          wait_reason: `Kontingent erschöpft (${provider.name}) – wird neu eingeplant`,
        });
        this.log(job.id, `Kontingent erschöpft: ${err.message} (Reset ${err.resetAt ? '' : 'geschätzt '}${until})`, 'warn');
        this.orch.bus.emit('scheduler.wake');
        return;
      }
      case 'billing':
      case 'auth':
      case 'config':
        this.store.providers.setState(provider.id, { health_status: 'error', health_message: err.message.slice(0, 500), health_checked_at: now.toISOString() });
        this.orch.changed('provider', provider.id);
        this.store.jobs.update(job.id, { status: 'BLOCKED', waiting_provider_id: provider.id, wait_reason: err.message, attempts: Math.max(0, current.attempts - 1) });
        this.log(job.id, `Blockiert: ${err.message}`, 'error');
        this.orch.audit('system', 'job.blocked', 'job', job.id, 0, { reason: err.message, provider: provider.id });
        return;
      case 'rate_limit':
      case 'transient':
      case 'timeout':
      case 'unknown': {
        if (current.attempts < current.max_attempts) {
          const backoff = err.retryAfterMs ?? Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, current.attempts - 1));
          const notBefore = new Date(now.getTime() + backoff).toISOString();
          this.store.jobs.update(job.id, { status: 'QUEUED', not_before: notBefore, wait_reason: `Erneuter Versuch ab ${notBefore}: ${err.message}`.slice(0, 500) });
          this.log(job.id, `${err.message} – neuer Versuch in ${Math.round(backoff / 1000)} s`, 'warn');
          return;
        }
        this.fail(current, `${err.message} (nach ${current.attempts} Versuchen)`);
        return;
      }
      default:
        this.fail(current, err.message);
    }
  }
}

import type { Orchestrator } from './orchestrator.ts';
import { JobRunner } from './runner.ts';
import { computeNextRun } from './triggers.ts';

/**
 * Scheduler (Konzept §6, §15): arbeitet die Job-Queue ab, nimmt wartende Jobs nach Kontingent-Reset wieder auf,
 * führt Zeit-Trigger aus und meldet Budget-Schwellen. Agents laufen nie dauerhaft – nur pro Job.
 */
export class Scheduler {
  readonly runner: JobRunner;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private again = false;
  private unsubscribe: (() => void) | null = null;
  private readonly inflight = new Set<Promise<void>>();

  constructor(
    private readonly orch: Orchestrator,
    private readonly intervalMs = 2000,
  ) {
    this.runner = new JobRunner(orch);
  }

  start(): void {
    const requeued = this.orch.store.jobs.requeueInterrupted();
    if (requeued) this.orch.audit('system', 'jobs.resumed', null, null, 0, { count: requeued });
    this.initSchedules();
    this.unsubscribe = this.orch.bus.on((ev) => {
      if (ev.type === 'scheduler.wake') this.kick();
    });
    this.timer = setInterval(() => this.kick(), this.intervalMs);
    this.kick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    // Laufende Jobs bleiben als RUNNING gespeichert und werden beim nächsten Start wieder eingereiht.
    this.runner.abortAll();
    await Promise.allSettled([...this.inflight]);
  }

  /** Wartet, bis keine Jobs mehr laufen (für Tests). */
  async idle(): Promise<void> {
    while (this.inflight.size || this.ticking) {
      await Promise.allSettled([...this.inflight]);
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  kick(): void {
    if (this.ticking) {
      this.again = true;
      return;
    }
    void this.tick();
  }

  private initSchedules(): void {
    const now = new Date();
    for (const s of this.orch.store.schedules.list()) {
      if (s.enabled && !s.next_run_at) {
        this.orch.store.schedules.update(s.id, { next_run_at: computeNextRun(s, now)?.toISOString() ?? null });
      }
    }
  }

  async tick(): Promise<void> {
    if (this.ticking) {
      this.again = true;
      return;
    }
    this.ticking = true;
    try {
      do {
        this.again = false;
        this.step();
      } while (this.again);
    } catch (e) {
      console.error('[scheduler]', e);
    } finally {
      this.ticking = false;
    }
  }

  private step(): void {
    const { store } = this.orch;
    const now = new Date();
    const nowIso = now.toISOString();

    // 1) Provider, deren gemeldete Erschöpfung abgelaufen ist -> Reset-Event, wartende Jobs aufwecken
    for (const p of store.providers.list()) {
      if (p.exhausted_until && p.exhausted_until <= nowIso) {
        store.providers.setState(p.id, { exhausted_until: null, exhausted_reason: null });
        this.orch.audit('system', 'provider.quota_reset', 'provider', p.id, 0, { automatic: true });
        this.orch.bus.emit('provider.quota_reset', 'provider', p.id);
        store.jobs.wakeWaiting(nowIso, p.id);
        this.orch.changed('provider', p.id);
        this.orch.changed('job');
      }
    }
    // 2) Wartende Jobs mit erreichtem Wiederaufnahmezeitpunkt
    if (store.jobs.wakeWaiting(nowIso).length) this.orch.changed('job');

    // 3) Zeit-Trigger
    for (const s of store.schedules.due(nowIso)) {
      try {
        const job = this.orch.createJob({ type: s.job_type, agent_id: s.agent_id, input: s.input, priority: s.priority, created_by: `schedule:${s.id}` });
        this.orch.audit('system', 'schedule.fired', 'schedule', s.id, 0, { job_id: job?.id, name: s.name });
      } catch (e) {
        this.orch.audit('system', 'schedule.failed', 'schedule', s.id, 0, { error: e instanceof Error ? e.message : String(e) });
      }
      store.schedules.update(s.id, { last_run_at: nowIso, next_run_at: computeNextRun(s, now)?.toISOString() ?? null });
      this.orch.changed('schedule', s.id);
    }

    // 4) Budget-Schwellen als Ereignis (einmal pro Monat und Stufe)
    this.checkBudget(now);

    // 5) Jobs starten
    const settings = this.orch.settings;
    if (settings.engine_paused) return;
    let capacity = Math.max(1, settings.max_concurrent_jobs) - this.runner.runningCount;
    if (capacity <= 0) return;
    const runningByProvider = store.jobs.runningCountByProvider();
    for (const job of store.jobs.runnable(nowIso, 100)) {
      if (capacity <= 0) break;
      if (this.runner.isRunning(job.id)) continue;
      const res = this.runner.dispatch(job, runningByProvider);
      if (res.started) {
        capacity--;
        runningByProvider[res.providerId] = (runningByProvider[res.providerId] ?? 0) + 1;
        const p = res.done.finally(() => {
          this.inflight.delete(p);
          this.kick();
        });
        this.inflight.add(p);
      }
    }
  }

  private checkBudget(now: Date): void {
    const budget = this.orch.systemBudget(now);
    if (budget.limit == null) return;
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const level = budget.exceeded ? 'exceeded' : budget.warning ? 'warning' : null;
    if (!level) return;
    const key = `budget_event:${month}:${level}`;
    const db = this.orch.store.db;
    if (db.get("SELECT value FROM meta WHERE key = ?", key)) return;
    db.run('INSERT INTO meta (key, value) VALUES (?, ?)', key, now.toISOString());
    this.orch.audit('system', level === 'exceeded' ? 'budget.exceeded' : 'budget.threshold_reached', null, null, 0, {
      spent: Number(budget.spent.toFixed(4)),
      limit: budget.limit,
      pct: Number((budget.pct ?? 0).toFixed(1)),
    });
    this.orch.bus.emit('budget.alert', 'budget', month, { level, spent: budget.spent, limit: budget.limit });
  }
}

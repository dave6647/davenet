import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerProviderType } from '../server/providers/registry.ts';
import { emptyUsage, ProviderError, type ModelCallRequest } from '../server/providers/types.ts';
import { MockAdapter } from '../server/providers/mock.ts';
import { periodWindow } from '../server/engine/quota.ts';
import { computeNextRun } from '../server/engine/triggers.ts';
import { testApp } from './helpers.ts';

/** Test-Provider, der beim ersten Aufruf ein erschöpftes Plan-Kontingent meldet (wie die Claude-CLI). */
const scriptedCalls: string[] = [];
registerProviderType({
  info: {
    type: 'scripted_quota',
    label: 'Test: Limit',
    description: '',
    billing_mode_default: 'subscription',
    supports_tools: [],
    needs_secret: false,
    secret_label: null,
    config_fields: [],
  },
  create: (provider) => ({
    async healthCheck() {
      return { ok: true, message: 'ok' };
    },
    async call(req: ModelCallRequest) {
      scriptedCalls.push(provider.id);
      if (provider.config.fail === 'quota') {
        const u = emptyUsage();
        u.requests = 1;
        u.billed = false;
        req.onUsage(u, req.model);
        throw new ProviderError('quota', "You've hit your limit", { resetAt: String(provider.config.reset_at) });
      }
      return new MockAdapter({ ...provider, config: { latency_ms: 0 } }).call(req);
    },
  }),
});

function addProvider(app: ReturnType<typeof testApp>, id: string, extra: Record<string, unknown> = {}) {
  app.store.providers.create({ id, name: id, type: 'mock', enabled: true, priority: 50, billing_mode: 'subscription', config: { latency_ms: 0 }, ...extra });
  for (const tier of ['LOW', 'MEDIUM', 'HIGH'] as const) {
    app.store.models.create({ provider_id: id, model_name: `${id}-${tier}`, tier, label: `${id} ${tier}` });
  }
}

test('WAIT: erschöpftes Kontingent -> Job wartet, kein Wechsel; Reset nimmt ihn wieder auf (Konzept §5/§6)', async () => {
  const app = testApp();
  try {
    app.store.providers.update('simulation', { quota_unit: 'requests', quota_limit: 1, quota_period: 'daily' });
    addProvider(app, 'backup'); // Alternative wäre verfügbar – WAIT darf sie nicht nutzen
    app.store.agents.update('AUDITOR', { allowed_providers: ['simulation', 'backup'], provider_policy: 'WAIT' });

    const j1 = app.orch.createJob({ type: 'audit_review', created_by: 'owner' })!;
    const j2 = app.orch.createJob({ type: 'audit_review', created_by: 'owner', priority: 1 })!;
    // zweiter Job darf nicht als Duplikat zusammengefasst werden (kein Opportunity-Bezug)
    assert.notEqual(j1.id, j2.id);
    await app.drain();

    assert.equal(app.store.jobs.require(j1.id).status, 'COMPLETED');
    const waiting = app.store.jobs.require(j2.id);
    assert.equal(waiting.status, 'WAITING_FOR_PROVIDER_QUOTA');
    assert.equal(waiting.waiting_provider_id, 'simulation');
    const expected = periodWindow(app.store.providers.require('simulation'), new Date()).next!.toISOString();
    assert.equal(waiting.not_before, expected, 'Wiederaufnahme zum Periodenwechsel');
    assert.equal(app.store.ledger.list({ provider_id: 'backup' }).total, 0, 'kein impliziter Providerwechsel');

    // Owner aktualisiert das Kontingent manuell -> wartende Jobs laufen weiter
    app.orch.resetProviderQuota('simulation');
    await app.drain();
    assert.equal(app.store.jobs.require(j2.id).status, 'COMPLETED');
  } finally {
    await app.close();
  }
});

test('Provider meldet Limit mit Reset-Zeit -> Job wartet bis genau dahin', async () => {
  const app = testApp();
  try {
    const resetAt = new Date(Date.now() + 3 * 3600_000).toISOString();
    app.store.providers.create({ id: 'plan', name: 'Plan', type: 'scripted_quota', enabled: true, priority: 1, config: { fail: 'quota', reset_at: resetAt } });
    app.store.models.create({ provider_id: 'plan', model_name: 'plan-low', tier: 'LOW', label: 'Plan LOW' });
    const job = app.orch.createJob({ type: 'cost_report', created_by: 'owner' })!; // COST_CONTROLLER = LOW
    await app.drain();
    const j = app.store.jobs.require(job.id);
    assert.equal(j.status, 'WAITING_FOR_PROVIDER_QUOTA');
    assert.equal(j.not_before, resetAt);
    assert.equal(j.attempts, 0, 'Kontingent-Wartezeit zählt nicht als Fehlversuch');
    const p = app.store.providers.require('plan');
    assert.equal(p.exhausted_until, resetAt);
    assert.equal(app.store.ledger.list({ provider_id: 'plan' }).total, 1, 'auch der abgewiesene Aufruf ist protokolliert');
  } finally {
    await app.close();
  }
});

test('FALLBACK_SAME_TIER nutzt explizit einen anderen Provider gleicher Klasse', async () => {
  const app = testApp();
  try {
    app.store.providers.update('simulation', { quota_unit: 'requests', quota_limit: 0, quota_period: 'daily' });
    addProvider(app, 'second');
    app.store.agents.update('AUDITOR', { allowed_providers: ['simulation', 'second'], provider_policy: 'FALLBACK_SAME_TIER' });
    const job = app.orch.createJob({ type: 'audit_review', created_by: 'owner' })!;
    await app.drain();
    const j = app.store.jobs.require(job.id);
    assert.equal(j.status, 'COMPLETED');
    assert.equal(j.provider_id, 'second');
    assert.equal(app.store.models.require(j.model_id!).tier, 'MEDIUM');
    assert.ok(app.store.audit.list({ limit: 50 }).items.some((e) => e.action === 'router.fallback'));
  } finally {
    await app.close();
  }
});

test('OWNER_APPROVAL: Wechsel erst nach Freigabe, Ablehnung führt zu WAIT', async () => {
  const app = testApp();
  try {
    app.store.providers.update('simulation', { quota_unit: 'requests', quota_limit: 0, quota_period: 'daily' });
    addProvider(app, 'paid', { billing_mode: 'pay_as_you_go' });
    app.store.agents.update('AUDITOR', { allowed_providers: ['simulation', 'paid'], provider_policy: 'OWNER_APPROVAL' });

    const a = app.orch.createJob({ type: 'audit_review', created_by: 'owner' })!;
    await app.drain();
    assert.equal(app.store.jobs.require(a.id).status, 'WAITING_FOR_APPROVAL');
    const approval = app.store.approvals.pending('PROVIDER_SWITCH')[0];
    assert.equal(approval.job_id, a.id);
    app.orch.decideApproval(approval.id, 'APPROVED');
    await app.drain();
    assert.equal(app.store.jobs.require(a.id).status, 'COMPLETED');
    assert.equal(app.store.jobs.require(a.id).provider_id, 'paid');

    const b = app.orch.createJob({ type: 'audit_review', created_by: 'owner' })!;
    await app.drain();
    const approval2 = app.store.approvals.pending('PROVIDER_SWITCH')[0];
    app.orch.decideApproval(approval2.id, 'REJECTED');
    await app.drain();
    const jb = app.store.jobs.require(b.id);
    assert.equal(jb.status, 'WAITING_FOR_PROVIDER_QUOTA');
    assert.equal(jb.policy_override, 'WAIT');
  } finally {
    await app.close();
  }
});

test('Kostenlimit eines Pay-as-you-go-Providers blockiert (BLOCK) und Budget-Schwelle bremst normale Jobs', async () => {
  const app = testApp();
  try {
    app.store.providers.update('simulation', { enabled: false });
    addProvider(app, 'payg', { billing_mode: 'pay_as_you_go', monthly_cost_limit_usd: 1, policy_on_exhaustion: 'BLOCK' });
    // Bereits 1,50 $ ausgegeben
    app.store.ledger.add({
      job_id: null, job_type: null, agent_id: 'AUDITOR', provider_id: 'payg', model_id: null, model_name: 'x', opportunity_id: null,
      purpose: 'job', billing_mode: 'pay_as_you_go', input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0,
      requests: 1, tool_calls: 0, provider_units: null, monetary_cost_usd: 1.5, equivalent_cost_usd: 1.5, quota_period: null,
      quota_remaining: null, duration_ms: null, success: true,
    });
    const job = app.orch.createJob({ type: 'audit_review', created_by: 'owner' })!;
    await app.drain();
    const j = app.store.jobs.require(job.id);
    assert.equal(j.status, 'BLOCKED');
    assert.match(j.wait_reason ?? '', /Kostenlimit/);

    // Owner erhöht das Limit -> Job wird automatisch neu geprüft; Systembudget-Schwelle (80 % von 1,80 $) bremst normale Priorität
    app.store.settings.update({ system_monthly_budget_usd: 1.8, budget_warning_pct: 80 });
    app.store.providers.update('payg', { monthly_cost_limit_usd: 10 });
    app.orch.providerChanged('payg');
    await app.drain();
    assert.match(app.store.jobs.require(job.id).wait_reason ?? '', /Budget-Schwelle/);

    // hohe Priorität darf weiterlaufen
    app.store.jobs.update(job.id, { priority: 2 });
    app.orch.retryJob(job.id);
    await app.drain();
    assert.equal(app.store.jobs.require(job.id).status, 'COMPLETED');
    assert.ok(app.store.audit.list({ limit: 100 }).items.some((e) => e.action === 'budget.threshold_reached'));
  } finally {
    await app.close();
  }
});

test('Kein passendes Modell -> Job blockiert mit verständlichem Grund', async () => {
  const app = testApp();
  try {
    app.store.agents.update('AUDITOR', { min_context_tokens: 5_000_000 });
    const job = app.orch.createJob({ type: 'audit_review', created_by: 'owner' })!;
    await app.drain();
    const j = app.store.jobs.require(job.id);
    assert.equal(j.status, 'BLOCKED');
    assert.match(j.wait_reason ?? '', /Kein aktiver Provider mit Modell der Klasse MEDIUM/);
  } finally {
    await app.close();
  }
});

test('Zeit-Trigger berechnen den nächsten Lauf korrekt', () => {
  const from = new Date(2026, 9, 6, 10, 0); // Di 6.10.2026 10:00
  assert.equal(computeNextRun({ kind: 'daily', time_of_day: '08:00', interval_minutes: null, weekday: null, day_of_month: null }, from)!.getDate(), 7);
  const weekly = computeNextRun({ kind: 'weekly', time_of_day: '08:00', interval_minutes: null, weekday: 1, day_of_month: null }, from)!;
  assert.equal(weekly.getDay(), 1);
  assert.equal(weekly.getDate(), 12);
  const monthly = computeNextRun({ kind: 'monthly', time_of_day: '09:00', interval_minutes: null, weekday: null, day_of_month: 1 }, from)!;
  assert.equal(monthly.getMonth(), 10);
  assert.equal(computeNextRun({ kind: 'interval', time_of_day: null, interval_minutes: 60, weekday: null, day_of_month: null }, from)!.getHours(), 11);
});

test('Zeit-Trigger legt Jobs an', async () => {
  const app = testApp();
  try {
    const s = app.store.schedules.list().find((x) => x.job_type === 'audit_review')!;
    app.store.schedules.update(s.id, { enabled: true, next_run_at: new Date(Date.now() - 1000).toISOString() });
    await app.drain();
    const jobs = app.store.jobs.list({ type: 'audit_review' }).items;
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].created_by, `schedule:${s.id}`);
    assert.ok(app.store.schedules.require(s.id).next_run_at! > new Date().toISOString());
  } finally {
    await app.close();
  }
});

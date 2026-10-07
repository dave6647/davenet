import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CRITERIA_WEIGHTS, KO_SCORE_CAP, type TestPlan } from '../shared/domain.ts';
import { DEFAULT_SETTINGS } from '../server/repo/schedules.ts';
import { cappedScore, criteriaScore, guardrailIssues, knockouts } from '../server/engine/scoring.ts';
import { ensureSeedV2 } from '../server/db/seed.ts';
import { buildHttp } from '../server/http/server.ts';
import { testApp } from './helpers.ts';

const H = { host: 'localhost:4310', 'x-davenet': '1', 'content-type': 'application/json' };

const all = (v: number) => Object.fromEntries(Object.keys(DEFAULT_CRITERIA_WEIGHTS).map((k) => [k, v]));
const withNotes = (v: number, over: Record<string, number> = {}) =>
  Object.fromEntries(Object.keys(DEFAULT_CRITERIA_WEIGHTS).map((k) => [k, { score: over[k] ?? v, note: 'Test' }]));

const PLAN: TestPlan = {
  hypothesis: 'Serverbetreiber zahlen für ein fertiges Script',
  channel: 'Tebex-Listing',
  budget_eur: 0,
  owner_hours: 2,
  duration_days: 21,
  metric: 'Verkäufe',
  success_criterion: 'mindestens 3 Verkäufe',
  owner_steps: ['Listing veröffentlichen'],
  materials: ['Listing-Text', 'Vorschaubild als SVG'],
};

test('Bewertung: 13 Kriterien multiplikativ, K.-o.-Kriterien deckeln den Score', () => {
  const s = DEFAULT_SETTINGS;
  assert.equal(criteriaScore(all(7), s.criteria_weights), 70);
  assert.equal(criteriaScore(all(10), s.criteria_weights), 100);
  const weak = { ...all(8), margin: 1 };
  const mean = Object.values(weak).reduce((a, b) => a + b, 0) / 13;
  assert.ok(criteriaScore(weak, s.criteria_weights)! < mean * 10 - 5, 'ein sehr schwacher Wert zieht stärker als beim Durchschnitt');
  assert.equal(criteriaScore({}, s.criteria_weights), null);

  assert.deepEqual(knockouts(all(7), { status: 'green' }, PLAN, s), []);
  assert.match(knockouts({ ...all(7), demand: 2 }, null, null, s)[0], /Nachfrage/);
  assert.match(knockouts(all(7), { status: 'red' }, null, s)[0], /Rechtsprüfung rot/);
  const over = knockouts(all(7), null, { ...PLAN, budget_eur: 12, owner_hours: 5 }, s);
  assert.match(over[0], /Leitplanken.*12 € über 5 €.*5 Std\. über 3 Std\./);
  assert.deepEqual(guardrailIssues(PLAN, s), []);
  assert.equal(cappedScore(80, ['x']), KO_SCORE_CAP);
  assert.equal(cappedScore(80, []), 80);
});

test('Bewertung mit K.-o. (fehlende Nachfrage) verwirft die Opportunity, ohne Test vorzuschlagen', async () => {
  const app = testApp();
  try {
    const opp = app.orch.createOpportunity({ title: 'Nischen-Tool ohne Nachfrage' });
    const job = app.orch.createJob({ type: 'evaluation', opportunity_id: opp.id, created_by: 'owner' })!;
    app.orch.applyEvaluation(app.orch.jobContext(job), {
      criteria: withNotes(9, { demand: 1 }),
      confidence: 0.8,
      recommendation: 'GO',
      rationale: 'Technisch schön, aber niemand sucht danach',
      test_plan: PLAN,
      mvp_outline: '-',
      estimated_effort: '-',
    });
    const o = app.store.opportunities.require(opp.id);
    assert.equal(o.status, 'REJECTED');
    assert.match(o.status_reason!, /K\.-o\.: keine ausreichende Nachfrage/);
    assert.equal(o.score, KO_SCORE_CAP);
    assert.equal(app.store.approvals.pending(undefined, opp.id).length, 0);
  } finally {
    await app.close();
  }
});

test('Leitplanke: höchstens N Tests/Projekte gleichzeitig – Freigabe wartet auf einen freien Platz', async () => {
  const app = testApp();
  try {
    app.store.settings.update({ guard_max_parallel: 1 });
    app.store.routes.upsert({ job_type: 'test_preparation', enabled: false });
    const ids = ['Idee A', 'Idee B'].map((title) => {
      const o = app.orch.createOpportunity({ title });
      app.store.opportunities.update(o.id, {
        test: { attempt: 1, status: 'PROPOSED', plan: PLAN, guardrail_issues: [], started_at: null, ends_at: null, result: null, evaluation: null, history: [] },
      });
      app.orch.proposeTest(o.id, 'owner');
      return o.id;
    });
    const [a, b] = ids.map((id) => app.store.approvals.pending('TEST_START', id)[0]);
    assert.match(a.summary, /Plätze für Tests\/Projekte: 0\/1/);
    app.orch.decideApproval(a.id, 'APPROVED');
    assert.equal(app.store.opportunities.require(ids[0]).status, 'TESTING');
    assert.throws(() => app.orch.decideApproval(b.id, 'APPROVED'), /höchstens 1 Tests\/Projekten/);
    assert.equal(app.store.approvals.require(b.id).status, 'PENDING', 'Freigabe bleibt offen');
    assert.equal(app.orch.guardrails().parallel.used, 1);

    // Test beenden -> Platz frei -> zweite Freigabe möglich
    app.orch.opportunityAction(ids[0], 'stop', 'kein Interesse');
    assert.equal(app.store.opportunities.require(ids[0]).status, 'STOPPED');
    app.orch.decideApproval(b.id, 'APPROVED');
    assert.equal(app.store.opportunities.require(ids[1]).status, 'TESTING');
  } finally {
    await app.close();
  }
});

test('Abbruchregel: nicht bestandener Test führt zur Freigabe "Beenden", der Owner entscheidet', async () => {
  const app = testApp();
  try {
    const opp = app.orch.createOpportunity({ title: 'Logo-Service' });
    app.store.opportunities.update(opp.id, {
      status: 'TESTING',
      test: { attempt: 1, status: 'EVALUATING', plan: PLAN, guardrail_issues: [], started_at: new Date().toISOString(), ends_at: null, result: { notes: '0 Verkäufe', recorded_at: '' }, evaluation: null, history: [] },
    });
    app.orch.addFinanceEntry({ opportunity_id: opp.id, kind: 'expense', amount_eur: 4.5, note: 'Listing-Gebühr' });
    app.orch.addFinanceEntry({ opportunity_id: opp.id, kind: 'time', hours: 3 });
    const job = app.orch.createJob({ type: 'test_evaluation', opportunity_id: opp.id, created_by: 'owner' })!;
    // ADJUST ohne angepassten Plan wird zu STOP
    app.orch.applyTestEvaluation(app.orch.jobContext(job), {
      verdict: 'ADJUST',
      success_criterion_met: false,
      summary: '0 von 3 Verkäufen',
      reasoning: 'Kosten und Zeit ohne Ertrag',
      next_steps: [],
    });
    let o = app.store.opportunities.require(opp.id);
    assert.equal(o.test?.status, 'FAILED');
    const stop = app.store.approvals.pending('PROJECT_STOP', opp.id);
    assert.equal(stop.length, 1);
    assert.match(stop[0].summary, /Ausgaben 4,50 €, Owner-Zeit 3 Std\./);

    app.orch.decideApproval(stop[0].id, 'APPROVED', 'ok');
    o = app.store.opportunities.require(opp.id);
    assert.equal(o.status, 'STOPPED');
    assert.equal(app.store.jobs.require(job.id).status, 'CANCELLED', 'offene Arbeit wird gestoppt');
  } finally {
    await app.close();
  }
});

test('Wiederholungstest: ADJUST mit neuem Plan schlägt Versuch 2 vor, danach ist Schluss', async () => {
  const app = testApp();
  try {
    const opp = app.orch.createOpportunity({ title: 'FiveM-Script' });
    app.store.opportunities.update(opp.id, {
      status: 'TESTING',
      test: { attempt: 1, status: 'EVALUATING', plan: PLAN, guardrail_issues: [], started_at: null, ends_at: null, result: { notes: '1 Verkauf', recorded_at: '' }, evaluation: null, history: [] },
    });
    const ctx = () => app.orch.jobContext(app.orch.createJob({ type: 'test_evaluation', opportunity_id: opp.id, created_by: 'owner' })!);
    app.orch.applyTestEvaluation(ctx(), {
      verdict: 'ADJUST',
      success_criterion_met: false,
      summary: 'Kanal passte nicht',
      reasoning: '-',
      adjusted_plan: { ...PLAN, channel: 'Discord-Community' },
      next_steps: [],
    });
    const o = app.store.opportunities.require(opp.id);
    assert.equal(o.test?.attempt, 2);
    assert.equal(o.test?.plan.channel, 'Discord-Community');
    assert.equal(o.test?.history.length, 1);
    assert.equal(app.store.approvals.pending('TEST_START', opp.id).length, 1);
    for (const j of app.store.jobs.openForOpportunity(opp.id)) app.orch.cancelJob(j.id);

    app.store.opportunities.update(opp.id, { test: { ...o.test!, status: 'EVALUATING' } });
    app.orch.applyTestEvaluation(ctx(), { verdict: 'ADJUST', success_criterion_met: false, summary: 'wieder nichts', reasoning: '-', adjusted_plan: PLAN, next_steps: [] });
    assert.equal(app.store.approvals.pending('PROJECT_STOP', opp.id).length, 1, 'kein dritter Versuch – Beenden wird vorgeschlagen');
  } finally {
    await app.close();
  }
});

test('Portfolio-Review: Kennzahlen, Empfehlung je Produkt und monatlicher Zeitplan', async () => {
  const app = testApp();
  try {
    const schedule = app.store.schedules.list().find((s) => s.job_type === 'portfolio_review')!;
    assert.ok(schedule.enabled, 'monatlicher Portfolio-Review ist aktiv');
    assert.equal(schedule.kind, 'monthly');
    assert.ok(schedule.next_run_at && schedule.next_run_at > new Date().toISOString());

    const opp = app.orch.createOpportunity({ title: 'Icon-Paket' });
    app.store.opportunities.update(opp.id, { status: 'DEPLOYED', fixed_costs_eur_month: 8 });
    app.orch.addFinanceEntry({ opportunity_id: opp.id, kind: 'revenue', amount_eur: 3 });
    app.orch.addFinanceEntry({ opportunity_id: opp.id, kind: 'time', hours: 2 });
    const facts = app.orch.portfolioFacts();
    assert.match(facts, new RegExp(`${opp.id} Icon-Paket`));
    assert.match(facts, /Einnahmen: gesamt 3,00 €/);
    assert.match(facts, /Fixkosten: 8,00 €\/Monat/);
    assert.ok(app.orch.businessAlerts().some((a) => /Fixkosten 8,00 €\/Monat über der Leitplanke/.test(a.text)));

    app.orch.createJob({ type: 'portfolio_review', created_by: 'owner' });
    await app.drain();
    const report = app.store.artifacts.list({ kind: 'portfolio_review' })[0];
    assert.ok(report, 'Review liegt unter /decisions');
    assert.equal(app.store.opportunities.require(opp.id).portfolio_note?.recommendation, 'keep');
  } finally {
    await app.close();
  }
});

test('HTTP: Einnahmen, Ausgaben und Owner-Zeit erfassen, Portfolio und Leitplanken abrufen', async () => {
  const app = testApp();
  const http = await buildHttp(app);
  try {
    const opp = app.orch.createOpportunity({ title: 'Banner-Vorlagen' });
    const add = (payload: Record<string, unknown>) => http.inject({ method: 'POST', url: '/api/finance/entries', headers: H, payload });
    assert.equal((await add({ opportunity_id: opp.id, kind: 'revenue', amount_eur: 19.9, note: 'Etsy' })).statusCode, 200);
    assert.equal((await add({ opportunity_id: opp.id, kind: 'time', hours: 9 })).statusCode, 200);
    assert.equal((await add({ kind: 'time' })).statusCode, 400, 'Stunden fehlen');
    assert.equal((await add({ kind: 'expense', amount_eur: -5 })).statusCode, 400);
    assert.equal((await add({ opportunity_id: 'OPP-9999', kind: 'expense', amount_eur: 5 })).statusCode, 404);

    const portfolio = (await http.inject({ method: 'GET', url: '/api/portfolio', headers: H })).json();
    assert.equal(portfolio.total.revenue_eur, 19.9);
    assert.equal(portfolio.guardrails.owner_hours_week.used, 9);
    const overview = (await http.inject({ method: 'GET', url: '/api/overview', headers: H })).json();
    assert.ok(overview.alerts.some((a: { text: string }) => /Owner-Zeit diese Woche: 9 von 10 Std\./.test(a.text)));

    const fixed = await http.inject({ method: 'PUT', url: `/api/opportunities/${opp.id}`, headers: H, payload: { fixed_costs_eur_month: 4 } });
    assert.equal(fixed.json().fixed_costs_eur_month, 4);

    const entries = (await http.inject({ method: 'GET', url: `/api/finance/entries?opportunity_id=${opp.id}`, headers: H })).json();
    assert.equal(entries.length, 2);
    assert.equal((await http.inject({ method: 'DELETE', url: `/api/finance/entries/${entries[0].id}`, headers: H })).statusCode, 200);

    const weights = await http.inject({ method: 'PUT', url: '/api/settings', headers: H, payload: { criteria_weights: { demand: 5 }, guard_max_parallel: 3 } });
    assert.equal(weights.statusCode, 200, weights.body);
    assert.equal(weights.json().criteria_weights.demand, 5);
    assert.equal(weights.json().criteria_weights.margin, DEFAULT_CRITERIA_WEIGHTS.margin, 'andere Gewichte bleiben erhalten');
  } finally {
    await http.close();
    await app.close();
  }
});

test('Update bestehender Installationen: Designer, Bild-Provider und Review-Zeitplan werden genau einmal ergänzt', async () => {
  const app = testApp();
  try {
    // Zustand einer Installation vor dem Update simulieren
    app.store.db.run("DELETE FROM meta WHERE key = 'seed_v2'");
    app.store.schedules.list().filter((s) => s.job_type === 'portfolio_review').forEach((s) => app.store.db.run('DELETE FROM schedules WHERE id = ?', s.id));
    app.store.db.run("DELETE FROM providers WHERE id IN ('chatgpt_abo', 'openai_images', 'image_simulation')");
    app.store.db.run("DELETE FROM agents WHERE id = 'DESIGNER'");
    ensureSeedV2(app.store);
    assert.ok(app.store.agents.get('DESIGNER'));
    assert.ok(app.store.providers.get('chatgpt_abo'));
    assert.equal(app.store.models.list('openai_images').length, 2);
    assert.equal(app.store.schedules.list().filter((s) => s.job_type === 'portfolio_review').length, 1);
    // vom Owner gelöschter Zeitplan kommt nicht wieder
    app.store.schedules.list().filter((s) => s.job_type === 'portfolio_review').forEach((s) => app.store.db.run('DELETE FROM schedules WHERE id = ?', s.id));
    ensureSeedV2(app.store);
    assert.equal(app.store.schedules.list().filter((s) => s.job_type === 'portfolio_review').length, 0);
  } finally {
    await app.close();
  }
});

test('Neubewertung oder Recherche setzen einen laufenden Test nicht zurück', async () => {
  const app = testApp();
  try {
    const opp = app.orch.createOpportunity({ title: 'Laufender Test' });
    const running = { attempt: 1, status: 'RUNNING' as const, plan: PLAN, guardrail_issues: [], started_at: new Date().toISOString(), ends_at: null, result: null, evaluation: null, history: [] };
    app.store.opportunities.update(opp.id, { status: 'TESTING', test: running });
    const job = app.orch.createJob({ type: 'evaluation', opportunity_id: opp.id, created_by: 'owner' })!;
    app.orch.applyEvaluation(app.orch.jobContext(job), {
      criteria: withNotes(8),
      confidence: 0.7,
      recommendation: 'GO',
      rationale: 'Neubewertung',
      test_plan: { ...PLAN, channel: 'anderer Kanal' },
      mvp_outline: '-',
      estimated_effort: '-',
    });
    const o = app.store.opportunities.require(opp.id);
    assert.equal(o.status, 'TESTING');
    assert.equal(o.test?.status, 'RUNNING');
    assert.equal(o.test?.plan.channel, PLAN.channel, 'laufender Testplan bleibt');
    assert.equal(o.score, 80, 'Bewertung wird trotzdem aktualisiert');
    assert.equal(app.store.approvals.pending(undefined, opp.id).length, 0);
  } finally {
    await app.close();
  }
});

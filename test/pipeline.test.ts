import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { testApp } from './helpers.ts';

test('Komplette Pipeline mit Simulation: Scan, Nachfragetest, Bau, Release (Konzept §8/§10, Strategie §8)', async () => {
  const app = testApp();
  try {
    const scan = app.orch.createJob({ type: 'opportunity_scan', input: { count: 2 }, created_by: 'owner' });
    assert.ok(scan);
    await app.drain();

    const opps = app.store.opportunities.list();
    assert.equal(opps.length, 2, 'Scan legt zwei Kandidaten an');
    for (const o of opps) {
      assert.equal(o.status, 'PROPOSED', `${o.id} sollte nach Screening/Research/Bewertung vorgeschlagen sein (ist ${o.status}: ${o.status_reason})`);
      assert.equal(o.score, 70, 'alle 13 Kriterien 7/10 ergeben Score 70');
      assert.equal(Object.keys(o.criteria ?? {}).length, 13, 'Bewertung nach 13 Kriterien');
      assert.deepEqual(o.knockouts, []);
      assert.equal(o.legal?.source, 'research', 'Rechtsprüfung aus der Tiefenrecherche');
      assert.equal(o.test?.status, 'PROPOSED', 'Nachfragetest vorgeschlagen');
    }
    const approvals = app.store.approvals.list({ status: 'PENDING' });
    assert.equal(approvals.length, 2);
    assert.ok(approvals.every((a) => a.type === 'TEST_START' && a.level === 2), 'zuerst wird der Nachfragetest freigegeben, nicht der Bau');

    // Owner gibt einen Test frei, lehnt den anderen ab
    const [first, second] = approvals;
    app.orch.decideApproval(second.id, 'REJECTED', 'passt nicht');
    assert.equal(app.store.opportunities.require(second.opportunity_id!).status, 'REJECTED');
    app.orch.decideApproval(first.id, 'APPROVED', 'los gehts');
    await app.drain();

    const oppId = first.opportunity_id!;
    let opp = app.store.opportunities.require(oppId);
    assert.equal(opp.status, 'TESTING');
    assert.equal(opp.test?.status, 'READY', 'Testpaket ist vorbereitet – jetzt ist der Owner dran');
    assert.ok(app.store.artifacts.latest(oppId, 'test_kit'), 'Testpaket als Artefakt');
    assert.equal(app.store.tasks.listForOpportunity(oppId).length, 0, 'vor dem bestandenen Test wird nicht gebaut');

    app.orch.opportunityAction(oppId, 'test_live');
    opp = app.store.opportunities.require(oppId);
    assert.equal(opp.test?.status, 'RUNNING');
    assert.ok(opp.test?.ends_at && opp.test.ends_at > new Date(Date.now() + 13 * 86400_000).toISOString(), 'Laufzeit aus dem Testplan');
    app.orch.addFinanceEntry({ opportunity_id: oppId, kind: 'revenue', amount_eur: 12.5, note: 'erste Verkäufe' });
    app.orch.addFinanceEntry({ opportunity_id: oppId, kind: 'time', hours: 1.5, note: 'Listing angelegt' });

    app.orch.opportunityAction(oppId, 'test_result', '3 Verkäufe in 14 Tagen, Erfolgskriterium erreicht');
    await app.drain();
    opp = app.store.opportunities.require(oppId);
    assert.equal(opp.test?.status, 'PASSED');
    assert.equal(opp.status, 'TESTING', 'behält seinen Platz bis zur Entscheidung über den Bau');
    const start = app.store.approvals.pending('PROJECT_START', oppId);
    assert.equal(start.length, 1);
    assert.match(start[0].summary, /Ergebnis des Nachfragetests/);

    app.orch.decideApproval(start[0].id, 'APPROVED', 'bauen');
    await app.drain();
    opp = app.store.opportunities.require(oppId);
    const tasks = app.store.tasks.listForOpportunity(oppId);
    assert.equal(tasks.length, 2);
    assert.ok(tasks.every((t) => t.status === 'DONE'), 'alle Tasks umgesetzt und geprüft');
    assert.equal(opp.status, 'READY');
    const release = app.store.approvals.pending('RELEASE', oppId);
    assert.equal(release.length, 1);

    // Workspace enthält Testpaket und simulierte Umsetzung
    const ws = app.memory.workspaceDir(oppId);
    assert.ok(fs.existsSync(path.join(ws, 'simulation', 'T1.md')));

    app.orch.decideApproval(release[0].id, 'APPROVED');
    assert.equal(app.store.opportunities.require(oppId).status, 'DEPLOYED');

    // Ledger: jeder Modellaufruf ist protokolliert (Konzept §12)
    const jobs = app.store.jobs.list({ limit: 500 }).items;
    assert.ok(jobs.every((j) => j.status === 'COMPLETED'), jobs.map((j) => `${j.id} ${j.type} ${j.status} ${j.error ?? ''}`).join('\n'));
    const ledger = app.store.ledger.list({ limit: 500 });
    assert.equal(ledger.total, jobs.length, 'ein Usage-Event pro Job');
    assert.ok(ledger.items.every((e) => e.provider_id === 'simulation' && e.input_tokens > 0));

    // Artefakte liegen im Unternehmensgedächtnis
    const kinds = new Set(app.store.artifacts.list({ limit: 500 }).map((a) => a.kind));
    for (const k of ['scan_report', 'screening_note', 'research_report', 'evaluation', 'test_kit', 'test_evaluation', 'spec', 'implementation_report', 'review']) {
      assert.ok(kinds.has(k), `Artefakt ${k} fehlt`);
    }
    assert.ok(fs.existsSync(path.join(app.memory.root, 'opportunities', oppId, 'opportunity.json')));
    const decisions = fs.readFileSync(path.join(app.memory.root, 'decisions', 'entscheidungen.md'), 'utf8');
    assert.ok(decisions.includes('Nachfragetest') && decisions.includes('Projektstart'));

    // Einnahmen und Owner-Zeit stehen im Portfolio
    const item = app.orch.portfolioItems().find((i) => i.id === oppId)!;
    assert.equal(item.total.revenue_eur, 12.5);
    assert.equal(item.total.hours, 1.5);

    // Audit-Trail enthält Level-2-Entscheidungen und Level-1-Workspace-Änderungen
    const audit = app.store.audit.list({ limit: 1000 }).items;
    assert.ok(audit.some((e) => e.action === 'approval.approved' && e.level === 2));
    assert.ok(audit.some((e) => e.action === 'workspace.changed' && e.level === 1));
  } finally {
    await app.close();
  }
});

test('Deaktivierter Job-Typ stoppt die Automatik nach der Planung', async () => {
  const app = testApp();
  try {
    app.store.routes.upsert({ job_type: 'implementation', enabled: false });
    const opp = app.orch.createOpportunity({ title: 'Manuelle Idee' });
    app.orch.propose(opp.id, 'owner');
    const approval = app.store.approvals.pending('PROJECT_START', opp.id)[0];
    app.orch.decideApproval(approval.id, 'APPROVED');
    await app.drain();
    const tasks = app.store.tasks.listForOpportunity(opp.id);
    assert.equal(tasks.length, 2);
    assert.ok(tasks.every((t) => t.status === 'TODO'));
    assert.equal(app.store.opportunities.require(opp.id).status, 'DEVELOPMENT');
    assert.ok(app.store.audit.list({ limit: 100 }).items.some((e) => e.action === 'job.skipped'));
  } finally {
    await app.close();
  }
});

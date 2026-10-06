import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { testApp } from './helpers.ts';

test('Komplette Pipeline mit Simulation: Scan bis Release (Konzept §8/§10)', async () => {
  const app = testApp();
  try {
    const scan = app.orch.createJob({ type: 'opportunity_scan', input: { count: 2 }, created_by: 'owner' });
    assert.ok(scan);
    await app.drain();

    const opps = app.store.opportunities.list();
    assert.equal(opps.length, 2, 'Scan legt zwei Kandidaten an');
    for (const o of opps) {
      assert.equal(o.status, 'PROPOSED', `${o.id} sollte nach Screening/Research/Bewertung vorgeschlagen sein (ist ${o.status}: ${o.status_reason})`);
      assert.equal(o.score, 70);
    }
    const approvals = app.store.approvals.list({ status: 'PENDING' });
    assert.equal(approvals.length, 2);
    assert.ok(approvals.every((a) => a.type === 'PROJECT_START' && a.level === 2));

    // Owner gibt eine Opportunity frei, lehnt die andere ab
    const [first, second] = approvals;
    app.orch.decideApproval(second.id, 'REJECTED', 'passt nicht');
    assert.equal(app.store.opportunities.require(second.opportunity_id!).status, 'REJECTED');
    app.orch.decideApproval(first.id, 'APPROVED', 'los gehts');
    await app.drain();

    const oppId = first.opportunity_id!;
    const opp = app.store.opportunities.require(oppId);
    const tasks = app.store.tasks.listForOpportunity(oppId);
    assert.equal(tasks.length, 2);
    assert.ok(tasks.every((t) => t.status === 'DONE'), 'alle Tasks umgesetzt und geprüft');
    assert.equal(opp.status, 'READY');
    const release = app.store.approvals.pending('RELEASE', oppId);
    assert.equal(release.length, 1);

    // Workspace enthält die simulierte Umsetzung
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
    for (const k of ['scan_report', 'screening_note', 'research_report', 'evaluation', 'spec', 'implementation_report', 'review']) {
      assert.ok(kinds.has(k), `Artefakt ${k} fehlt`);
    }
    assert.ok(fs.existsSync(path.join(app.memory.root, 'opportunities', oppId, 'opportunity.json')));
    assert.ok(fs.readFileSync(path.join(app.memory.root, 'decisions', 'entscheidungen.md'), 'utf8').includes('Projektstart'));

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

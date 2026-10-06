import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildHttp } from '../server/http/server.ts';
import { testApp } from './helpers.ts';

const H = { host: 'localhost:4310', 'x-davenet': '1', 'content-type': 'application/json' };

test('HTTP: Sicherheitsprüfungen (Host, CSRF-Header, Origin)', async () => {
  const app = testApp();
  const http = await buildHttp(app);
  try {
    const evil = await http.inject({ method: 'GET', url: '/api/agents', headers: { host: 'evil.example:4310' } });
    assert.equal(evil.statusCode, 403, 'fremder Host (DNS-Rebinding) wird abgewiesen');

    const noHeader = await http.inject({ method: 'POST', url: '/api/engine/pause', headers: { host: 'localhost' } });
    assert.equal(noHeader.statusCode, 403, 'schreibender Aufruf ohne X-Davenet wird abgewiesen');

    const foreignOrigin = await http.inject({ method: 'POST', url: '/api/engine/pause', headers: { ...H, origin: 'https://evil.example' } });
    assert.equal(foreignOrigin.statusCode, 403);

    const ok = await http.inject({ method: 'POST', url: '/api/engine/pause', headers: { ...H, origin: 'http://localhost:5173' } });
    assert.equal(ok.statusCode, 200);
  } finally {
    await http.close();
    await app.close();
  }
});

test('HTTP: Organisation verwalten (Abteilung, Agent, Zuständigkeit)', async () => {
  const app = testApp();
  const http = await buildHttp(app);
  try {
    const dep = await http.inject({ method: 'POST', url: '/api/departments', headers: H, payload: { id: 'marketing', name: 'Marketing' } });
    assert.equal(dep.statusCode, 200, dep.body);

    const agent = await http.inject({
      method: 'POST',
      url: '/api/agents',
      headers: H,
      payload: { id: 'content_writer', name: 'Content Writer', department_id: 'marketing', capability: 'LOW', tools: ['web_search'] },
    });
    assert.equal(agent.statusCode, 200, agent.body);
    assert.equal(agent.json().id, 'CONTENT_WRITER');

    const invalid = await http.inject({ method: 'PUT', url: '/api/agents/CONTENT_WRITER', headers: H, payload: { capability: 'ULTRA' } });
    assert.equal(invalid.statusCode, 400);

    const route = await http.inject({ method: 'PUT', url: '/api/routes/screening', headers: H, payload: { agent_id: 'CONTENT_WRITER', capability_override: null } });
    assert.equal(route.statusCode, 200, route.body);
    const routes = (await http.inject({ method: 'GET', url: '/api/routes', headers: H })).json() as { key: string; route: { agent_id: string } }[];
    assert.equal(routes.find((r) => r.key === 'screening')!.route.agent_id, 'CONTENT_WRITER');

    const del = await http.inject({ method: 'DELETE', url: '/api/departments/marketing', headers: H });
    assert.equal(del.statusCode, 200);
    const a = (await http.inject({ method: 'GET', url: '/api/agents/CONTENT_WRITER', headers: H })).json();
    assert.equal(a.agent.department_id, null, 'Agent bleibt erhalten, nur ohne Abteilung');

    const audit = (await http.inject({ method: 'GET', url: '/api/audit?limit=50', headers: H })).json();
    assert.ok(audit.items.some((e: { action: string }) => e.action === 'agent.created'));
  } finally {
    await http.close();
    await app.close();
  }
});

test('HTTP: Provider-Secret wird nie ausgeliefert', async () => {
  const app = testApp();
  const http = await buildHttp(app);
  try {
    const res = await http.inject({ method: 'PUT', url: '/api/providers/anthropic_api/secret', headers: H, payload: { value: 'sk-ant-test-1234567890abcd' } });
    assert.equal(res.statusCode, 200);
    const list = await http.inject({ method: 'GET', url: '/api/providers', headers: H });
    assert.ok(!list.body.includes('sk-ant-test'), 'Secret darf nicht in der API-Antwort stehen');
    const p = (list.json() as { id: string; secret: { has_secret: boolean; hint: string } }[]).find((x) => x.id === 'anthropic_api')!;
    assert.equal(p.secret.has_secret, true);
    assert.equal(p.secret.hint, '…abcd');
    const audit = app.store.audit.list({ limit: 10 }).items.find((e) => e.action === 'secret.set')!;
    assert.equal(audit.level, 3);
    assert.ok(!JSON.stringify(audit).includes('sk-ant'));
  } finally {
    await http.close();
    await app.close();
  }
});

test('HTTP: Owner-Idee anlegen, Screening starten, Übersicht & Ledger abrufen', async () => {
  const app = testApp();
  const http = await buildHttp(app);
  try {
    const created = await http.inject({ method: 'POST', url: '/api/opportunities', headers: H, payload: { title: 'KI-Rechnungsprüfung für Handwerker', screen: true } });
    assert.equal(created.statusCode, 200, created.body);
    const opp = created.json();
    assert.equal(opp.status, 'SCREENING');
    await app.drain();
    const detail = (await http.inject({ method: 'GET', url: `/api/opportunities/${opp.id}`, headers: H })).json();
    assert.equal(detail.opportunity.status, 'PROPOSED');
    assert.ok(detail.jobs.length >= 3);

    const overview = (await http.inject({ method: 'GET', url: '/api/overview', headers: H })).json();
    assert.equal(overview.approvals_pending, 1);
    assert.ok(overview.alerts.some((a: { text: string }) => /Freigabe/.test(a.text)));

    const ledger = (await http.inject({ method: 'GET', url: '/api/ledger/summary', headers: H })).json();
    assert.ok(ledger.totals.requests >= 3);
    assert.ok(ledger.groups.agent_id.length >= 1);

    const manual = await http.inject({ method: 'POST', url: '/api/jobs', headers: H, payload: { type: 'screening', input: {} } });
    assert.equal(manual.statusCode, 400, 'interne Job-Typen sind nicht manuell anlegbar');

    const directive = await http.inject({ method: 'POST', url: '/api/jobs', headers: H, payload: { type: 'owner_directive', input: { directive: '' } } });
    assert.equal(directive.statusCode, 400, 'Pflichtfeld fehlt');
  } finally {
    await http.close();
    await app.close();
  }
});

test('HTTP: Unternehmensgedächtnis – nur freigegebene Bereiche schreibbar, kein Pfad-Ausbruch', async () => {
  const app = testApp();
  const http = await buildHttp(app);
  try {
    const ok = await http.inject({ method: 'PUT', url: '/api/memory/file', headers: H, payload: { path: 'knowledge/notizen.md', content: '# Notizen' } });
    assert.equal(ok.statusCode, 200);
    const ro = await http.inject({ method: 'PUT', url: '/api/memory/file', headers: H, payload: { path: 'finance/x.md', content: 'x' } });
    assert.equal(ro.statusCode, 400);
    const escape = await http.inject({ method: 'GET', url: '/api/memory/file?path=../davenet.db', headers: H });
    assert.equal(escape.statusCode, 400);
    const tree = (await http.inject({ method: 'GET', url: '/api/memory/tree', headers: H })).json();
    assert.ok(tree.files.some((f: { path: string }) => f.path === 'strategy/strategie.md'));
  } finally {
    await http.close();
    await app.close();
  }
});

test('HTTP: Oberfläche – SPA-Fallback, neue Build-Dateien ohne Neustart, 404 für fehlende Assets', async () => {
  const app = testApp();
  const web = fs.mkdtempSync(path.join(os.tmpdir(), 'davenet-web-'));
  fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><title>Davenet</title>');
  const http = await buildHttp(app, { webDir: web });
  try {
    const index = await http.inject({ method: 'GET', url: '/', headers: { host: 'localhost' } });
    assert.equal(index.statusCode, 200);
    assert.match(index.body, /Davenet/);
    // Datei erst nach dem Start anlegen (wie ein neuer Build)
    fs.mkdirSync(path.join(web, 'assets'));
    fs.writeFileSync(path.join(web, 'assets', 'app-123.js'), 'console.log(1)');
    const asset = await http.inject({ method: 'GET', url: '/assets/app-123.js', headers: { host: 'localhost' } });
    assert.equal(asset.statusCode, 200);
    assert.match(String(asset.headers['content-type']), /javascript/);
    const missing = await http.inject({ method: 'GET', url: '/assets/alt-999.js', headers: { host: 'localhost' } });
    assert.equal(missing.statusCode, 404);
    const deep = await http.inject({ method: 'GET', url: '/irgendeine/seite', headers: { host: 'localhost' } });
    assert.equal(deep.statusCode, 200, 'SPA-Fallback auf index.html');
    const api = await http.inject({ method: 'GET', url: '/api/gibtsnicht', headers: { host: 'localhost' } });
    assert.equal(api.statusCode, 404);
    assert.match(api.body, /Unbekannter Endpunkt/);
  } finally {
    await http.close();
    await app.close();
    fs.rmSync(web, { recursive: true, force: true });
  }
});

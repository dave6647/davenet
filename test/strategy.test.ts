import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { strategySection } from '../server/engine/jobtypes/common.ts';
import { STRATEGY_FILE, STRATEGY_SUMMARY_FILE } from '../server/engine/memory.ts';
import { buildHttp } from '../server/http/server.ts';
import { testApp } from './helpers.ts';

const H = { host: 'localhost:4310', 'x-davenet': '1', 'content-type': 'application/json' };

const LONG = `# Unternehmensstrategie\n\n${'## Abschnitt\nRegeln und Beispiele für die Agents. '.repeat(300)}`;
const SUMMARY = `# Kurzfassung\n\n${'- Regel mit Zahl: Testbudget 5 €, Freigabe ab 0 €.\n'.repeat(20)}`;

/** Änderungszeit einer Gedächtnis-Datei setzen (relativ zu jetzt). */
function age(app: ReturnType<typeof testApp>, rel: string, minutesAgo: number): void {
  const t = new Date(Date.now() - minutesAgo * 60_000);
  fs.utimesSync(app.memory.resolve(rel), t, t);
}

test('Strategie: Agents erhalten die Kurzfassung, sonst die Langfassung – gekürzt auf das eingestellte Limit', async () => {
  const app = testApp();
  try {
    assert.equal(app.store.settings.get().strategy_context_chars, 8000, 'Standardlimit');
    app.memory.ownerWrite(STRATEGY_FILE, LONG);

    let section = strategySection(app.orch);
    assert.match(section.body, /^# Unternehmensstrategie/);
    assert.equal(section.maxChars, 8000);
    assert.doesNotMatch(section.title, /Kurzfassung/);
    let status = app.memory.strategyStatus(8000);
    assert.equal(status.source, 'full');
    assert.equal(status.truncated, true, 'Langfassung ist länger als das Limit');

    app.memory.ownerWrite(STRATEGY_SUMMARY_FILE, SUMMARY);
    section = strategySection(app.orch);
    assert.match(section.title, /Kurzfassung/);
    assert.equal(section.body, SUMMARY.trim());
    status = app.memory.strategyStatus(8000);
    assert.equal(status.source, 'summary');
    assert.equal(status.truncated, false);
    assert.equal(status.summary_outdated, false);

    app.store.settings.update({ strategy_context_chars: 12000 });
    assert.equal(strategySection(app.orch).maxChars, 12000, 'Limit aus den Einstellungen');
  } finally {
    await app.close();
  }
});

test('Strategie: fast leere Kurzfassung wird ignoriert, veraltete Kurzfassung erkannt', async () => {
  const app = testApp();
  try {
    app.memory.ownerWrite(STRATEGY_FILE, LONG);
    app.memory.ownerWrite(STRATEGY_SUMMARY_FILE, '# Kurzfassung\n\n> Hinweis: hier kürzen\n');
    let status = app.memory.strategyStatus(8000);
    assert.equal(status.source, 'full', 'Agents arbeiten nicht versehentlich ohne Strategie');
    assert.equal(status.summary.ignored, true);
    assert.match(strategySection(app.orch).body, /^# Unternehmensstrategie/);

    app.memory.ownerWrite(STRATEGY_SUMMARY_FILE, SUMMARY);
    age(app, STRATEGY_SUMMARY_FILE, 60);
    age(app, STRATEGY_FILE, 1);
    status = app.memory.strategyStatus(8000);
    assert.equal(status.summary_outdated, true, 'Langfassung wurde nach der Kurzfassung geändert');

    // Gemeinsam kopierte Dateien (wenige Sekunden Abstand) gelten nicht als veraltet
    age(app, STRATEGY_SUMMARY_FILE, 0.5);
    age(app, STRATEGY_FILE, 0);
    assert.equal(app.memory.strategyStatus(8000).summary_outdated, false);
  } finally {
    await app.close();
  }
});

test('HTTP: Hinweise zur Strategie in der Übersicht und Status im Gedächtnis', async () => {
  const app = testApp();
  const http = await buildHttp(app);
  const alerts = async () =>
    ((await http.inject({ method: 'GET', url: '/api/overview', headers: H })).json().alerts as { text: string; link?: string }[]).filter((a) =>
      /strategie/i.test(a.text),
    );
  try {
    let list = await alerts();
    assert.equal(list.length, 1);
    assert.match(list[0].text, /noch die Vorlage/);

    await http.inject({ method: 'PUT', url: '/api/memory/file', headers: H, payload: { path: STRATEGY_FILE, content: LONG } });
    list = await alerts();
    assert.equal(list.length, 1);
    assert.match(list[0].text, /länger als das Kontextlimit/);
    assert.match(list[0].text, /8\.000/);

    const raised = await http.inject({ method: 'PUT', url: '/api/settings', headers: H, payload: { strategy_context_chars: 20000 } });
    assert.equal(raised.statusCode, 200, raised.body);
    assert.equal((await alerts()).length, 0, 'mit höherem Limit wird nichts mehr gekürzt');
    const tooLow = await http.inject({ method: 'PUT', url: '/api/settings', headers: H, payload: { strategy_context_chars: 100 } });
    assert.equal(tooLow.statusCode, 400);

    await http.inject({ method: 'PUT', url: '/api/memory/file', headers: H, payload: { path: STRATEGY_SUMMARY_FILE, content: SUMMARY } });
    age(app, STRATEGY_SUMMARY_FILE, 30);
    list = await alerts();
    assert.equal(list.length, 1);
    assert.match(list[0].text, /nach der Kurzfassung geändert/);
    assert.equal(list[0].link, `#/memory?file=${STRATEGY_SUMMARY_FILE}`);

    const tree = (await http.inject({ method: 'GET', url: '/api/memory/tree', headers: H })).json();
    assert.equal(tree.strategy.source, 'summary');
    assert.equal(tree.strategy.limit, 20000);
    assert.equal(tree.strategy.summary.chars, SUMMARY.trim().length);
  } finally {
    await http.close();
    await app.close();
  }
});

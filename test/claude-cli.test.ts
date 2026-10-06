import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Provider } from '../shared/domain.ts';
import { ClaudeCliAdapter, parseResetFromText, planInfoByProvider } from '../server/providers/claude-cli.ts';
import { ProviderError, type CallUsage, type ModelCallRequest } from '../server/providers/types.ts';

const fake = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-claude.mjs');

function provider(config: Record<string, unknown> = {}): Provider {
  return {
    id: 'cli_test',
    name: 'CLI Test',
    type: 'claude_cli',
    enabled: true,
    priority: 1,
    billing_mode: 'subscription',
    config: { cli_path: fake, ...config },
    quota_unit: 'none',
    quota_limit: null,
    quota_period: 'rolling',
    quota_period_hours: 5,
    quota_reset_day: 1,
    quota_reset_hour: 0,
    policy_on_exhaustion: 'WAIT',
    monthly_cost_limit_usd: null,
    max_concurrent: 1,
    notes: '',
    exhausted_until: null,
    exhausted_reason: null,
    quota_counter_reset_at: null,
    plan_info: null,
    health_status: 'unknown',
    health_message: null,
    health_checked_at: null,
    created_at: '',
    updated_at: '',
  };
}

function request(prompt: string, extra: Partial<ModelCallRequest> = {}): { req: ModelCallRequest; usage: { u: CallUsage; model: string }[]; logs: string[] } {
  const usage: { u: CallUsage; model: string }[] = [];
  const logs: string[] = [];
  const req: ModelCallRequest = {
    model: 'claude-sonnet-5-5',
    system: 'Systemprompt',
    prompt,
    maxOutputTokens: 4000,
    tools: ['web_search', 'web_fetch'],
    maxToolCalls: 5,
    timeoutMs: 20000,
    signal: new AbortController().signal,
    log: (m) => logs.push(m),
    onUsage: (u, model) => usage.push({ u, model }),
    outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
    ...extra,
  };
  return { req, usage, logs };
}

test('Claude-CLI: Aufrufparameter, Werkzeug-Allowlist, Umgebung, kumulierte Nutzung', async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-should-not-leak';
  process.env.CLAUDECODE = '1';
  try {
    const adapter = new ClaudeCliAdapter(provider({ config_dir: '/tmp/zweitkonto' }));
    const { req, usage, logs } = request('MODE:success Bitte arbeiten');
    const res = await adapter.call(req);
    const echo = (res.structured as { echo: { args: string[]; hasApiKey: boolean; configDir: string; maxOut: string; nested: boolean } }).echo;
    const a = echo.args;
    assert.ok(a.includes('-p'));
    assert.equal(a[a.indexOf('--model') + 1], 'claude-sonnet-5-5');
    assert.equal(a[a.indexOf('--tools') + 1], 'WebSearch,WebFetch', 'nur die erlaubten Werkzeuge');
    assert.equal(a[a.indexOf('--allowedTools') + 1], 'WebSearch,WebFetch');
    assert.equal(a[a.indexOf('--setting-sources') + 1], '', 'keine Nutzer-/Projekt-Settings');
    assert.ok(a.includes('--strict-mcp-config'));
    assert.ok(a.includes('--no-session-persistence'));
    assert.ok(a.includes('--json-schema'));
    assert.ok(!a.includes('--permission-mode'), 'ohne Workspace keine Schreibrechte');
    assert.equal(echo.hasApiKey, false, 'API-Key wird für das Abo nicht weitergereicht');
    assert.equal(echo.nested, false);
    assert.equal(echo.configDir, '/tmp/zweitkonto');
    assert.equal(echo.maxOut, '4000');

    // Nutzung: Summe aus modelUsage (nicht nur der letzte Teilschritt)
    assert.equal(usage.length, 1);
    assert.equal(usage[0].u.inputTokens, 1100);
    assert.equal(usage[0].u.outputTokens, 220);
    assert.equal(usage[0].u.cacheReadTokens, 300);
    assert.equal(usage[0].u.webSearches, 1);
    assert.equal(usage[0].u.requests, 3);
    assert.equal(usage[0].u.reportedCostUsd, 0.0123);
    assert.equal(usage[0].u.billed, false, 'Abo-Anmeldung -> keine Kosten');
    assert.equal(usage[0].model, 'claude-sonnet-5-5');
    assert.ok(logs.some((l) => l.includes('WebSearch')));

    const plan = planInfoByProvider.get('cli_test');
    assert.equal(plan?.windows.five_hour.utilization, 0.25);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDECODE;
  }
});

test('Claude-CLI: Workspace-Job bekommt Datei-Werkzeuge und acceptEdits', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'davenet-ws-'));
  try {
    const adapter = new ClaudeCliAdapter(provider());
    const { req } = request('MODE:success', { tools: ['workspace_read', 'workspace_write', 'web_search'], workspace: { dir, writable: true } });
    const res = await adapter.call(req);
    const a = (res.structured as { echo: { args: string[] } }).echo.args;
    assert.equal(a[a.indexOf('--tools') + 1], 'Read,Glob,Grep,Write,Edit,WebSearch');
    assert.equal(a[a.indexOf('--permission-mode') + 1], 'acceptEdits');

    const ro = await adapter.call(request('MODE:success', { tools: ['workspace_read', 'workspace_write'], workspace: { dir, writable: false } }).req);
    const b = (ro.structured as { echo: { args: string[] } }).echo.args;
    assert.equal(b[b.indexOf('--tools') + 1], 'Read,Glob,Grep', 'schreibgeschützter Workspace -> keine Schreibwerkzeuge');
    assert.ok(!b.includes('--permission-mode'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Claude-CLI: Plan-Limit -> quota-Fehler mit Reset aus rate_limit_event', async () => {
  const adapter = new ClaudeCliAdapter(provider());
  const { req, usage } = request('MODE:quota');
  const before = Date.now();
  await assert.rejects(adapter.call(req), (e: unknown) => {
    assert.ok(e instanceof ProviderError);
    assert.equal(e.kind, 'quota');
    assert.ok(e.resetAt);
    const reset = new Date(e.resetAt!).getTime();
    assert.ok(reset > before + 3500_000 && reset < before + 3700_000, 'Reset in ca. 1 Stunde');
    return true;
  });
  assert.equal(usage.length, 1, 'auch abgewiesene Aufrufe werden gebucht');
});

test('Claude-CLI: nicht angemeldet -> auth-Fehler; Absturz -> transient', async () => {
  const adapter = new ClaudeCliAdapter(provider());
  await assert.rejects(adapter.call(request('MODE:auth').req), (e: unknown) => e instanceof ProviderError && e.kind === 'auth');
  await assert.rejects(adapter.call(request('MODE:crash').req), (e: unknown) => e instanceof ProviderError && e.kind === 'transient');
  const missing = new ClaudeCliAdapter(provider({ cli_path: '/nicht/vorhanden/claude' }));
  await assert.rejects(missing.call(request('x').req), (e: unknown) => e instanceof ProviderError && e.kind === 'config');
  const health = await missing.healthCheck();
  assert.equal(health.ok, false);
  const ok = await adapter.healthCheck();
  assert.equal(ok.ok, true);
  assert.match(ok.message, /9\.9\.9.*angemeldet/);
});

test('Claude-CLI: ältere Version ohne --restricted -> automatischer Rückfall', async () => {
  const adapter = new ClaudeCliAdapter(provider());
  const { req, logs } = request('MODE:flag');
  const res = await adapter.call(req);
  const a = (res.structured as { echo: { args: string[] } }).echo.args;
  assert.ok(!a.includes('--restricted'));
  assert.ok(logs.some((l) => l.includes('--restricted')));
});

test('Reset-Zeit aus Limit-Texten lesen', () => {
  const now = new Date(2026, 9, 6, 14, 0);
  const epoch = parseResetFromText('Claude AI usage limit reached|1791338400', now)!;
  assert.equal(new Date(epoch).getTime(), 1791338400 * 1000);
  const pm = new Date(parseResetFromText("You've hit your limit · resets 5pm (Europe/Berlin)", now)!);
  assert.equal(pm.getHours(), 17);
  assert.equal(pm.getDate(), 6);
  const am = new Date(parseResetFromText('limit reached ∙ resets 2am', now)!);
  assert.equal(am.getDate(), 7);
  const dated = new Date(parseResetFromText('Weekly limit reached · resets Oct 9, 3pm', now)!);
  assert.equal(dated.getMonth(), 9);
  assert.equal(dated.getDate(), 9);
  assert.equal(dated.getHours(), 15);
  assert.equal(parseResetFromText('irgendein Fehler', now), null);
});

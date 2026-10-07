import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Provider } from '../shared/domain.ts';
import { buildHttp } from '../server/http/server.ts';
import { CodexCliImageAdapter, parseCodexReset } from '../server/providers/codex-cli.ts';
import { OpenAiImagesAdapter } from '../server/providers/openai-images.ts';
import { encodePng, isPng } from '../server/providers/png.ts';
import { ProviderError, type ImageCallRequest } from '../server/providers/types.ts';
import { SecretStore } from '../server/secrets.ts';
import { testApp } from './helpers.ts';

const FAKE = path.join(import.meta.dirname, 'fixtures', 'fake-codex.mjs');
const H = { host: 'localhost:4310', 'x-davenet': '1', 'content-type': 'application/json' };

function provider(type: string, config: Record<string, unknown>): Provider {
  return { id: `test_${type}`, name: type, type, config } as unknown as Provider;
}

function request(over: Partial<ImageCallRequest> = {}): ImageCallRequest {
  return {
    model: 'gpt-image-2',
    prompt: 'Minimalistisches Poster mit einem Berg bei Sonnenaufgang',
    size: '1024x1536',
    quality: 'medium',
    transparent: true,
    timeoutMs: 30_000,
    signal: new AbortController().signal,
    log: () => undefined,
    ...over,
  };
}

async function rejects(p: Promise<unknown>, kind: string): Promise<ProviderError> {
  try {
    await p;
  } catch (e) {
    assert.ok(e instanceof ProviderError, String(e));
    assert.equal(e.kind, kind, e.message);
    return e;
  }
  throw new Error(`Fehler "${kind}" erwartet`);
}

test('Bild-Job über die Bild-Simulation: Ablage im Gedächtnis und Workspace, Ledger, Auslieferung als PNG', async () => {
  const app = testApp();
  const server = await buildHttp(app);
  try {
    app.store.providers.update('image_simulation', { enabled: true, config: { latency_ms: 0 } });
    const opp = app.orch.createOpportunity({ title: 'Poster-Shop' });
    const job = app.orch.createJob({
      type: 'image_generation',
      opportunity_id: opp.id,
      input: { prompt: 'Berg bei Sonnenaufgang', file_name: 'Poster Motiv', aspect: 'portrait', transparent: true },
      created_by: 'owner',
    })!;
    assert.equal(job.agent_id, 'DESIGNER');
    await app.drain();

    const done = app.store.jobs.require(job.id);
    assert.equal(done.status, 'COMPLETED', done.error ?? '');
    assert.equal(done.provider_id, 'image_simulation');
    const out = done.output as { file: string; workspace_file: string };
    assert.equal(out.file, `media/${opp.id}/poster-motiv-${job.id}.png`);
    assert.ok(isPng(fs.readFileSync(path.join(app.memory.root, out.file))));
    assert.ok(isPng(fs.readFileSync(path.join(app.memory.workspaceDir(opp.id), out.workspace_file))), 'Kopie im Workspace unter assets/');
    const artifact = app.store.artifacts.list({ opportunity_id: opp.id }).find((a) => a.kind === 'image')!;
    assert.equal(artifact.format, 'png');
    const usage = app.store.ledger.list({ job_id: job.id });
    assert.equal(usage.total, 1);
    assert.equal(usage.items[0].purpose, 'image');

    const raw = await server.inject({ method: 'GET', url: `/api/memory/raw?path=${encodeURIComponent(out.file)}`, headers: { host: 'localhost' } });
    assert.equal(raw.statusCode, 200);
    assert.equal(raw.headers['content-type'], 'image/png');
    assert.ok(isPng(raw.rawPayload));
    const ws = await server.inject({ method: 'GET', url: `/api/opportunities/${opp.id}/workspace/raw?path=${encodeURIComponent(out.workspace_file)}`, headers: { host: 'localhost' } });
    assert.equal(ws.statusCode, 200);
    const text = await server.inject({ method: 'GET', url: '/api/memory/raw?path=strategy/strategie.md', headers: { host: 'localhost' } });
    assert.equal(text.statusCode, 400, 'nur Rasterbilder');

    // Sprachmodell-Jobs laufen weiter über Sprachmodell-Provider, nie über Bild-Provider
    const llm = app.orch.createJob({ type: 'executive_briefing', created_by: 'owner' })!;
    await app.drain();
    assert.equal(app.store.jobs.require(llm.id).provider_id, 'simulation');
  } finally {
    await server.close();
    await app.close();
  }
});

test('Bildanfragen der Agents: ohne Bild-Provider nur Hinweis, mit Provider eigene Bild-Jobs', async () => {
  const app = testApp();
  try {
    const opp = app.orch.createOpportunity({ title: 'Sticker' });
    const parent = app.orch.createJob({ type: 'evaluation', opportunity_id: opp.id, created_by: 'owner' })!;
    const ctx = app.orch.jobContext(parent);
    const req = [{ file_name: 'sticker', prompt: 'Katze mit Sonnenbrille', aspect: 'square' as const, transparent: true, purpose: 'Listing' }];
    const notes = app.orch.requestImages(ctx, req);
    assert.match(notes[0], /kein Bild-Provider aktiv/);
    assert.equal(app.store.jobs.list({ limit: 50 }).items.filter((j) => j.type === 'image_generation').length, 0);

    app.store.providers.update('image_simulation', { enabled: true });
    const created = app.orch.requestImages(ctx, [...req, ...req, ...req, ...req, ...req]);
    assert.equal(created.length, 4, 'höchstens vier Bilder je Ergebnis');
    const jobs = app.store.jobs.list({ limit: 50 }).items.filter((j) => j.type === 'image_generation');
    assert.equal(jobs.length, 4);
    assert.ok(jobs.every((j) => j.opportunity_id === opp.id && j.parent_job_id === parent.id));
  } finally {
    await app.close();
  }
});

test('ChatGPT-Abo über Codex CLI: Aufruf, Sandbox, kein API-Key, Bild aus CODEX_HOME', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'davenet-codex-home-'));
  const log = path.join(home, 'calls.jsonl');
  const promptFile = path.join(home, 'prompt.txt');
  const env = { FAKE_CODEX_LOG: log, FAKE_CODEX_PROMPT: promptFile, OPENAI_API_KEY: 'sk-sollte-entfernt-werden', FAKE_CODEX_MODE: 'ok' };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    const adapter = new CodexCliImageAdapter(provider('codex_cli', { cli_path: FAKE, codex_home: home }));
    const health = await adapter.healthCheck();
    assert.equal(health.ok, true, health.message);
    assert.match(health.message, /ChatGPT/);

    const result = await adapter.generate(request());
    assert.ok(isPng(result.image));
    assert.equal(result.usage.billed, false, 'Abo – keine Kosten pro Bild');
    assert.equal(result.usage.inputTokens, 1200);

    const call = fs
      .readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .find((c) => c.args[0] === 'exec');
    for (const flag of ['--json', '--skip-git-repo-check', '--ignore-user-config']) assert.ok(call.args.includes(flag), flag);
    assert.equal(call.args[call.args.indexOf('--sandbox') + 1], 'read-only');
    assert.equal(call.codex_home, home);
    assert.equal(call.openai_key, null, 'OPENAI_API_KEY wird nicht an Codex weitergegeben');
    const prompt = fs.readFileSync(promptFile, 'utf8');
    assert.match(prompt, /image_gen\.imagegen/);
    assert.match(prompt, /portrait/);
    assert.match(prompt, /Berg bei Sonnenaufgang/);

    process.env.FAKE_CODEX_MODE = 'cwd';
    assert.ok(isPng((await adapter.generate(request())).image), 'Rückfall: Bild im Arbeitsverzeichnis');

    process.env.FAKE_CODEX_MODE = 'limit';
    const limit = await rejects(adapter.generate(request()), 'quota');
    const reset = new Date(limit.resetAt!).getTime() - Date.now();
    assert.ok(reset > 2.4 * 3600_000 && reset < 2.6 * 3600_000, `Reset in ca. 2,5 Std. (${limit.resetAt})`);

    process.env.FAKE_CODEX_MODE = 'noimage';
    await rejects(adapter.generate(request()), 'refusal');

    process.env.FAKE_CODEX_MODE = 'old';
    assert.ok(isPng((await adapter.generate(request())).image), 'ältere CLI ohne --ignore-rules');

    process.env.FAKE_CODEX_MODE = 'logged_out';
    const out = await adapter.healthCheck();
    assert.equal(out.ok, false);
    assert.match(out.message, /codex login/);

    const missing = new CodexCliImageAdapter(provider('codex_cli', { cli_path: path.join(home, 'gibt-es-nicht') }));
    await rejects(missing.generate(request()), 'config');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Reset-Zeit aus Codex-Limitmeldungen', () => {
  const now = new Date('2026-10-07T10:00:00Z');
  assert.equal(parseCodexReset('Try again in 2 hours 30 minutes.', now), '2026-10-07T12:30:00.000Z');
  assert.equal(parseCodexReset('try again in 3 days', now), '2026-10-10T10:00:00.000Z');
  assert.ok(parseCodexReset('Please try again at 5:00 PM', now));
  assert.equal(parseCodexReset('unbekannt', now), null);
});

test('OpenAI-Bild-API: Anfrage, Abrechnung und Fehlerarten', async () => {
  const png = encodePng(4, 4, () => [10, 20, 30]);
  const seen: { auth?: string; body?: Record<string, unknown> }[] = [];
  let reply: { status: number; body: unknown } = { status: 200, body: {} };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      seen.push({ auth: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined });
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'davenet-secrets-'));
  try {
    const secrets = new SecretStore(path.join(dir, 'secrets.json'));
    const p = provider('openai_images', { base_url: base, api_key_env: 'DAVENET_TEST_OPENAI_KEY_UNSET' });
    secrets.set(p.id, 'api_key', 'sk-test-openai');
    const adapter = new OpenAiImagesAdapter(p, secrets);

    reply = { status: 200, body: { data: [{ b64_json: png.toString('base64') }], usage: { input_tokens: 50, output_tokens: 1056 } } };
    const result = await adapter.generate(request());
    assert.ok(isPng(result.image));
    assert.equal(result.usage.billed, true);
    assert.equal(result.usage.outputTokens, 1056);
    const sent = seen.at(-1)!;
    assert.equal(sent.auth, 'Bearer sk-test-openai');
    assert.deepEqual(
      { model: sent.body!.model, size: sent.body!.size, quality: sent.body!.quality, background: sent.body!.background, output_format: sent.body!.output_format },
      { model: 'gpt-image-2', size: '1024x1536', quality: 'medium', background: 'transparent', output_format: 'png' },
    );

    reply = { status: 401, body: { error: { message: 'Incorrect API key provided' } } };
    await rejects(adapter.generate(request()), 'auth');
    reply = { status: 429, body: { error: { message: 'You exceeded your current quota', code: 'insufficient_quota' } } };
    await rejects(adapter.generate(request()), 'billing');
    reply = { status: 429, body: { error: { message: 'Rate limit reached' } } };
    await rejects(adapter.generate(request()), 'rate_limit');
    reply = { status: 400, body: { error: { message: 'Your request was rejected by the safety system', code: 'moderation_blocked' } } };
    await rejects(adapter.generate(request()), 'refusal');

    const noKey = new OpenAiImagesAdapter({ ...provider('openai_images', { base_url: base, api_key_env: 'DAVENET_TEST_OPENAI_KEY_UNSET' }), id: 'ohne_key' }, secrets);
    await rejects(noKey.generate(request()), 'auth');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP: Bild-Job im Job-Dialog verfügbar, Provider-Arten in den Metadaten', async () => {
  const app = testApp();
  const server = await buildHttp(app);
  try {
    const meta = (await server.inject({ method: 'GET', url: '/api/meta', headers: H })).json();
    const image = meta.job_types.find((t: { key: string }) => t.key === 'image_generation');
    assert.equal(image.provider_kind, 'image');
    assert.ok(image.input_fields.some((f: { type: string }) => f.type === 'select'));
    const types = Object.fromEntries(meta.provider_types.map((t: { type: string; kind: string }) => [t.type, t.kind]));
    assert.deepEqual([types.codex_cli, types.openai_images, types.claude_cli], ['image', 'image', 'llm']);
    const providers = (await server.inject({ method: 'GET', url: '/api/providers', headers: H })).json() as { id: string; enabled: boolean }[];
    assert.ok(providers.some((p) => p.id === 'chatgpt_abo' && !p.enabled), 'ChatGPT-Abo ist angelegt, aber aus, bis Codex angemeldet ist');
  } finally {
    await server.close();
    await app.close();
  }
});

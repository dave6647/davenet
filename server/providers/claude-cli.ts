import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PlanInfo, Provider, ToolKey } from '../../shared/domain.ts';
import {
  emptyUsage,
  ProviderError,
  type CallUsage,
  type ModelCallRequest,
  type ModelCallResult,
  type ProviderAdapter,
  type ProviderTypeDef,
} from './types.ts';

/**
 * Adapter für die lokal installierte Claude Code CLI (`claude -p`).
 *
 * Damit laufen Agents über den Claude-Plan (Pro/Max) des Owners statt über einen API-Key.
 * Jeder Modellaufruf startet genau einen CLI-Prozess; Werkzeuge werden strikt auf die vom
 * Job erlaubten Claude-Code-Tools begrenzt (keine Shell, keine MCP-Server, keine Nutzer-Settings),
 * Datei-Werkzeuge arbeiten nur im Projekt-Workspace.
 *
 * Kontingent: Die CLI meldet über `rate_limit_event` die Auslastung der Plan-Fenster (5 Stunden / 7 Tage)
 * samt Reset-Zeitpunkt. Ist ein Fenster erschöpft, wirft der Adapter einen 'quota'-Fehler mit Reset-Zeit –
 * der Scheduler lässt den Job dann bis dahin warten (Konzept §5/§6).
 */

const TOOL_MAP: Record<ToolKey, string[]> = {
  web_search: ['WebSearch'],
  web_fetch: ['WebFetch'],
  workspace_read: ['Read', 'Glob', 'Grep'],
  workspace_write: ['Write', 'Edit'],
};

/** Letzte von der CLI gemeldete Plan-Auslastung je Provider; der Runner übernimmt sie in den Provider-Zustand. */
export const planInfoByProvider = new Map<string, PlanInfo>();

interface CliCommand {
  file: string;
  pre: string[];
}

export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function which(name: string): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').concat(['']) : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext.toLowerCase());
      if (isFile(candidate)) return candidate;
      const upper = path.join(dir, name + ext);
      if (isFile(upper)) return upper;
    }
  }
  return null;
}

export function resolveClaudeCommand(cliPath: string): CliCommand | null {
  const configured = cliPath.trim() || 'claude';
  let bin: string | null = configured.includes('/') || configured.includes('\\') ? (isFile(configured) ? configured : null) : which(configured);
  if (!bin) {
    const home = os.homedir();
    const native = path.join(home, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
    if (isFile(native)) bin = native;
  }
  if (!bin) return null;
  try {
    const real = fs.realpathSync(bin);
    // npm-Installation (Link auf ein JS-Skript) oder direkt angegebenes Skript -> mit dem eigenen Node starten
    if (/\.(c|m)?js$/i.test(real)) return { file: process.execPath, pre: [real] };
  } catch {
    /* ignorieren */
  }
  if (/\.(cmd|bat)$/i.test(bin)) {
    // Windows + npm: .cmd-Wrapper lassen sich ohne Shell nicht starten -> zugehöriges cli.js direkt mit Node ausführen
    const cli = path.join(path.dirname(bin), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    if (isFile(cli)) return { file: process.execPath, pre: [cli] };
    return null;
  }
  return { file: bin, pre: [] };
}

export function killTree(child: ChildProcess | null): void {
  if (!child || child.exitCode !== null || !child.pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill());
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }
  } catch {
    /* Prozess bereits beendet */
  }
}

const epochToIso = (v: unknown): string | null => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n > 1e12 ? n : n * 1000).toISOString();
};

/** Versucht, aus Limit-Meldungen ("resets 5pm", "…|1760000000") einen Reset-Zeitpunkt zu lesen. */
export function parseResetFromText(text: string, now = new Date()): string | null {
  const epoch = text.match(/\|(\d{10,13})\b/);
  if (epoch) return epochToIso(epoch[1]);
  const m = text.match(/resets?\s+(?:at\s+)?(?:([A-Z][a-z]{2})\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!m) return null;
  let hour = Number(m[3]);
  const minute = m[4] ? Number(m[4]) : 0;
  const ampm = m[5]?.toLowerCase();
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  const d = new Date(now);
  if (m[1] && m[2]) {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const month = months.indexOf(m[1].toLowerCase());
    if (month < 0) return null;
    d.setMonth(month, Number(m[2]));
    d.setHours(hour, minute, 0, 0);
    if (d.getTime() < now.getTime()) d.setFullYear(d.getFullYear() + 1);
  } else {
    d.setHours(hour, minute, 0, 0);
    if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1);
  }
  return d.toISOString();
}

interface CliRunOutcome {
  result: Record<string, any> | null;
  apiKeySource: string | null;
  apiError: string | null;
  rateLimit: Record<string, any> | null;
  toolCalls: number;
  texts: string[];
  stderr: string;
  exitCode: number | null;
  killedFor: 'timeout' | 'cancelled' | 'tool_limit' | null;
}

export class ClaudeCliAdapter implements ProviderAdapter {
  /** Flags, die eine ältere CLI-Version nicht kennt, werden nach dem ersten Fehlschlag weggelassen. */
  private static readonly unsupportedFlags = new Set<string>();

  constructor(private readonly provider: Provider) {}

  private get cfg(): { cli_path: string; config_dir: string; keep_api_key_env: boolean } {
    const c = this.provider.config ?? {};
    return {
      cli_path: String(c.cli_path ?? 'claude'),
      config_dir: String(c.config_dir ?? ''),
      keep_api_key_env: c.keep_api_key_env === true || c.keep_api_key_env === 'true',
    };
  }

  private childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
    delete env.CLAUDECODE; // Davenet ist keine verschachtelte Claude-Code-Sitzung
    delete env.CLAUDE_CODE_ENTRYPOINT;
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
    if (!this.cfg.keep_api_key_env) {
      // Sicherstellen, dass das Abo genutzt wird und nicht versehentlich ein API-Key (Kosten!)
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
    }
    if (this.cfg.config_dir) env.CLAUDE_CONFIG_DIR = this.cfg.config_dir;
    return env;
  }

  async healthCheck(): Promise<{ ok: boolean; message: string }> {
    const cmd = resolveClaudeCommand(this.cfg.cli_path);
    if (!cmd) {
      return {
        ok: false,
        message: `Claude Code CLI nicht gefunden (Pfad: "${this.cfg.cli_path}"). Installieren und mit "claude" einmal anmelden.`,
      };
    }
    const version = await this.runSimple(cmd, ['--version'], 15000);
    if (version.code !== 0) return { ok: false, message: `CLI antwortet nicht: ${version.stderr.slice(0, 200)}` };
    const status = await this.runSimple(cmd, ['auth', 'status'], 15000);
    let loggedIn = false;
    let detail = '';
    try {
      const j = JSON.parse(status.stdout.trim());
      loggedIn = j.loggedIn === true;
      detail = [j.authMethod, j.subscriptionType, j.email].filter(Boolean).join(', ');
    } catch {
      loggedIn = status.code === 0 && /logged in|angemeldet/i.test(status.stdout);
    }
    const v = version.stdout.trim().split('\n')[0];
    if (!loggedIn) return { ok: false, message: `${v} – nicht angemeldet. Im Terminal "claude" starten und /login ausführen.` };
    return { ok: true, message: `${v} – angemeldet${detail ? ` (${detail})` : ''}` };
  }

  private runSimple(cmd: CliCommand, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let child: ChildProcess;
      try {
        child = spawn(cmd.file, [...cmd.pre, ...args], { env: this.childEnv(), cwd: os.tmpdir(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        resolve({ code: -1, stdout: '', stderr: String(e) });
        return;
      }
      const timer = setTimeout(() => killTree(child), timeoutMs);
      child.stdout?.on('data', (d) => (stdout += d));
      child.stderr?.on('data', (d) => (stderr += d));
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: stderr + String(e) });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
  }

  async call(req: ModelCallRequest): Promise<ModelCallResult> {
    const cmd = resolveClaudeCommand(this.cfg.cli_path);
    if (!cmd) throw new ProviderError('config', `Claude Code CLI nicht gefunden (Pfad: "${this.cfg.cli_path}").`);
    for (let attempt = 0; attempt < 3; attempt++) {
      const outcome = await this.runOnce(cmd, req);
      const unknown = outcome.stderr.match(/unknown option '(--[\w-]+)'/);
      if (!outcome.result && unknown && !ClaudeCliAdapter.unsupportedFlags.has(unknown[1])) {
        ClaudeCliAdapter.unsupportedFlags.add(unknown[1]);
        req.log(`CLI kennt ${unknown[1]} nicht (ältere Version) – Aufruf ohne diese Option wiederholt`, 'warn');
        continue;
      }
      return this.interpret(outcome, req);
    }
    throw new ProviderError('config', 'Claude Code CLI lehnt die Aufrufparameter ab – bitte CLI aktualisieren.');
  }

  private buildArgs(req: ModelCallRequest, sysFile: string): string[] {
    const writable = req.tools.includes('workspace_write') && !!req.workspace?.writable;
    // Datei-Werkzeuge nur mit Workspace; Schreib-Werkzeuge nur mit beschreibbarem Workspace
    const tools = req.tools.filter((t) => (t.startsWith('workspace_') ? !!req.workspace : true) && (t !== 'workspace_write' || writable));
    const cliTools = [...new Set(tools.flatMap((t) => TOOL_MAP[t] ?? []))];
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      req.model,
      '--system-prompt-file',
      sysFile,
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--setting-sources',
      '',
      '--disable-slash-commands',
      '--no-session-persistence',
      '--tools',
      cliTools.join(','),
      // Alles, was eine Rückfrage auslösen würde, wird automatisch abgelehnt (niemand sitzt am Terminal)
      '--permission-prompts',
      'none',
      // Datei-Werkzeuge nur im Arbeitsverzeichnis, keine Shell, keine Nutzer-/Projekt-Settings
      '--restricted',
      '--max-turns',
      String(Math.max(3, req.maxToolCalls + 3)),
    ];
    if (writable) args.push('--permission-mode', 'acceptEdits');
    if (cliTools.length) args.push('--allowedTools', cliTools.join(','));
    if (req.effort) args.push('--effort', req.effort);
    if (req.outputSchema) args.push('--json-schema', JSON.stringify(req.outputSchema));
    // Optionen entfernen, die diese CLI-Version nicht kennt (inkl. ihres Werts)
    const valueFlags = new Set(['--json-schema', '--effort', '--max-turns', '--permission-mode', '--permission-prompts']);
    const out: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (ClaudeCliAdapter.unsupportedFlags.has(args[i])) {
        if (valueFlags.has(args[i])) i++;
        continue;
      }
      out.push(args[i]);
    }
    return out;
  }

  private runOnce(cmd: CliCommand, req: ModelCallRequest): Promise<CliRunOutcome> {
    const sysFile = path.join(os.tmpdir(), `davenet-system-${randomUUID()}.txt`);
    fs.writeFileSync(sysFile, req.system, { encoding: 'utf8', mode: 0o600 });
    const cwd = req.workspace?.dir ?? os.tmpdir();
    const args = this.buildArgs(req, sysFile);

    return new Promise<CliRunOutcome>((resolve) => {
      const out: CliRunOutcome = {
        result: null,
        apiKeySource: null,
        apiError: null,
        rateLimit: null,
        toolCalls: 0,
        texts: [],
        stderr: '',
        exitCode: null,
        killedFor: null,
      };
      let child: ChildProcess | null = null;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.signal.removeEventListener('abort', onAbort);
        fs.rm(sysFile, { force: true }, () => undefined);
        resolve(out);
      };
      const onAbort = () => {
        out.killedFor = 'cancelled';
        killTree(child);
      };
      const timer = setTimeout(() => {
        out.killedFor = 'timeout';
        killTree(child);
      }, req.timeoutMs);
      req.signal.addEventListener('abort', onAbort, { once: true });

      try {
        child = spawn(cmd.file, [...cmd.pre, ...args], {
          cwd,
          env: this.childEnv({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(req.maxOutputTokens) }),
          windowsHide: true,
          detached: process.platform !== 'win32',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (e) {
        out.stderr = String(e);
        finish();
        return;
      }

      let buf = '';
      child.stdout!.setEncoding('utf8');
      child.stderr!.setEncoding('utf8');
      child.stdout!.on('data', (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) this.onLine(line, out, req, () => {
            out.killedFor = 'tool_limit';
            killTree(child);
          });
        }
      });
      child.stderr!.on('data', (d: string) => {
        out.stderr = (out.stderr + d).slice(-4000);
      });
      child.on('error', (e: NodeJS.ErrnoException) => {
        out.stderr += e.code === 'ENOENT' ? 'ENOENT' : String(e);
        finish();
      });
      child.on('close', (code) => {
        if (buf.trim()) this.onLine(buf.trim(), out, req, () => undefined);
        out.exitCode = code;
        finish();
      });
      child.stdin!.on('error', () => undefined);
      child.stdin!.end(req.prompt);
    });
  }

  private onLine(line: string, out: CliRunOutcome, req: ModelCallRequest, stopForToolLimit: () => void): void {
    let j: Record<string, any>;
    try {
      j = JSON.parse(line);
    } catch {
      return;
    }
    switch (j.type) {
      case 'system':
        if (j.subtype === 'init') out.apiKeySource = j.apiKeySource == null ? null : String(j.apiKeySource);
        break;
      case 'assistant': {
        if (j.error) out.apiError = String(j.error);
        const content = Array.isArray(j.message?.content) ? j.message.content : [];
        for (const block of content) {
          if (block?.type === 'tool_use' && block.name !== 'StructuredOutput') {
            out.toolCalls++;
            const target = block.input?.file_path ?? block.input?.url ?? block.input?.query ?? block.input?.pattern ?? '';
            req.log(`Tool ${block.name}${target ? `: ${String(target).slice(0, 160)}` : ''}`);
            if (out.toolCalls > req.maxToolCalls + 2) {
              req.log(`Tool-Call-Limit (${req.maxToolCalls}) überschritten – Lauf wird beendet`, 'error');
              stopForToolLimit();
            }
          } else if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
            out.texts.push(block.text);
          }
        }
        break;
      }
      case 'rate_limit_event':
        out.rateLimit = j.rate_limit_info ?? null;
        this.recordPlanInfo(out.rateLimit);
        break;
      case 'result':
        out.result = j;
        break;
      default:
        break;
    }
  }

  private recordPlanInfo(info: Record<string, any> | null): void {
    if (!info) return;
    const windows: PlanInfo['windows'] = {};
    for (const [name, w] of Object.entries((info.unifiedWindows ?? {}) as Record<string, any>)) {
      windows[name] = { utilization: w?.utilization == null ? null : Number(w.utilization), resets_at: epochToIso(w?.resetsAt) };
    }
    planInfoByProvider.set(this.provider.id, {
      status: String(info.status ?? 'unknown'),
      rate_limit_type: info.rateLimitType ? String(info.rateLimitType) : null,
      resets_at: epochToIso(info.resetsAt),
      windows,
      updated_at: new Date().toISOString(),
    });
  }

  private usageFrom(out: CliRunOutcome): CallUsage {
    const usage = emptyUsage();
    // `modelUsage` ist über alle Teilschritte (Tool-Runden) kumuliert – `usage` enthält nur den letzten Schritt.
    const perModel = Object.values((out.result?.modelUsage ?? {}) as Record<string, Record<string, unknown>>);
    if (perModel.length) {
      for (const m of perModel) {
        usage.inputTokens += Number(m.inputTokens) || 0;
        usage.outputTokens += Number(m.outputTokens) || 0;
        usage.cacheReadTokens += Number(m.cacheReadInputTokens) || 0;
        usage.cacheWriteTokens += Number(m.cacheCreationInputTokens) || 0;
        usage.webSearches += Number(m.webSearchRequests) || 0;
      }
    } else {
      const u = out.result?.usage ?? {};
      usage.inputTokens = Number(u.input_tokens) || 0;
      usage.outputTokens = Number(u.output_tokens) || 0;
      usage.cacheReadTokens = Number(u.cache_read_input_tokens) || 0;
      usage.cacheWriteTokens = Number(u.cache_creation_input_tokens) || 0;
      usage.webSearches = Number(u.server_tool_use?.web_search_requests) || 0;
    }
    usage.requests = Math.max(1, Number(out.result?.num_turns) || 1);
    usage.toolCalls = out.toolCalls;
    const cost = Number(out.result?.total_cost_usd);
    usage.reportedCostUsd = Number.isFinite(cost) ? cost : null;
    // apiKeySource 'none' = Anmeldung über den Claude-Plan -> keine Kosten pro Aufruf
    usage.billed = out.apiKeySource == null ? null : out.apiKeySource !== 'none';
    return usage;
  }

  private quotaError(out: CliRunOutcome, text: string): ProviderError {
    const info = out.rateLimit;
    let resetAt = epochToIso(info?.resetsAt);
    if (info?.unifiedWindows) {
      // das erschöpfte Fenster mit dem spätesten Reset ist maßgeblich
      for (const w of Object.values(info.unifiedWindows as Record<string, any>)) {
        if (Number(w?.utilization) >= 1) {
          const r = epochToIso(w.resetsAt);
          if (r && (!resetAt || r > resetAt)) resetAt = r;
        }
      }
    }
    const parsed = resetAt ?? parseResetFromText(text);
    return new ProviderError('quota', `Claude-Plan-Limit erreicht: ${text.slice(0, 300) || 'usage limit'}`, {
      resetAt: parsed,
      resetEstimated: !parsed,
    });
  }

  /** Tatsächlich genutztes Modell: das angefragte, falls es Nutzung hatte, sonst das mit dem meisten Output. */
  private servedModel(result: Record<string, any> | null, requested: string): string {
    const mu = (result?.modelUsage ?? {}) as Record<string, Record<string, unknown>>;
    const names = Object.keys(mu);
    if (!names.length || names.includes(requested)) return requested;
    return names.sort((a, b) => (Number(mu[b].outputTokens) || 0) - (Number(mu[a].outputTokens) || 0))[0];
  }

  private interpret(out: CliRunOutcome, req: ModelCallRequest): ModelCallResult {
    if (out.killedFor === 'cancelled') throw new ProviderError('cancelled', 'Abgebrochen');
    if (out.killedFor === 'timeout') throw new ProviderError('timeout', `Zeitlimit (${Math.round(req.timeoutMs / 1000)} s) überschritten`);
    if (out.killedFor === 'tool_limit') throw new ProviderError('limit', `Tool-Call-Limit (${req.maxToolCalls}) überschritten`);
    const r = out.result;
    const model = this.servedModel(r, req.model);
    if (r) req.onUsage(this.usageFrom(out), model);

    if (!r) {
      if (/ENOENT/.test(out.stderr)) throw new ProviderError('config', `Claude Code CLI nicht startbar (Pfad: "${this.cfg.cli_path}").`);
      const tail = out.stderr.trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 400);
      if (/not logged in|login|authenticat/i.test(tail)) throw new ProviderError('auth', `Claude Code nicht angemeldet: ${tail}`);
      throw new ProviderError('transient', `Claude Code beendet ohne Ergebnis (Exit ${out.exitCode})${tail ? `: ${tail}` : ''}`);
    }

    const text = String(r.result ?? '');
    const rejected = out.rateLimit && String(out.rateLimit.status) === 'rejected';
    if (r.is_error || (r.subtype && r.subtype !== 'success')) {
      if (out.apiError === 'rate_limit' || rejected || /hit your limit|usage limit|limit reached|limit will reset/i.test(text)) {
        throw this.quotaError(out, text);
      }
      if (out.apiError === 'authentication_failed' || /not logged in|\/login|invalid api key|authentication/i.test(text)) {
        throw new ProviderError('auth', `Claude Code nicht angemeldet: ${text.slice(0, 200)}`);
      }
      if (/credit balance|billing/i.test(text)) throw new ProviderError('billing', `Billing-Problem: ${text.slice(0, 200)}`);
      if (r.subtype === 'error_max_turns') throw new ProviderError('limit', 'Maximale Anzahl an Schritten erreicht, ohne Ergebnis');
      if (/overloaded|529|5\d\d|internal server error|timed out|ECONNRESET|socket hang up|network/i.test(text)) {
        throw new ProviderError('transient', `Claude Code: ${text.slice(0, 300)}`, { retryAfterMs: 60_000 });
      }
      throw new ProviderError('unknown', `Claude Code Fehler: ${text.slice(0, 400) || r.subtype}`);
    }
    if (Array.isArray(r.permission_denials) && r.permission_denials.length) {
      req.log(`CLI hat ${r.permission_denials.length} Tool-Aufruf(e) verweigert (außerhalb der Berechtigungen)`, 'warn');
    }
    if (out.rateLimit && String(out.rateLimit.status) === 'allowed_warning') {
      req.log('Hinweis der CLI: Plan-Kontingent fast ausgeschöpft', 'warn');
    }
    const finalText = text || out.texts.join('\n\n');
    return {
      text: finalText,
      structured: r.structured_output ?? undefined,
      usage: this.usageFrom(out),
      model,
      stopReason: r.stop_reason ?? undefined,
    };
  }
}

export const claudeCliType: ProviderTypeDef = {
  info: {
    type: 'claude_cli',
    kind: 'llm',
    label: 'Claude Code CLI (Claude-Abo)',
    description:
      'Nutzt die lokal installierte und angemeldete Claude Code CLI – damit laufen Agents über deinen Claude-Plan (Pro/Max). ' +
      'Für ein zweites Abo-Konto ein eigenes Konfigurationsverzeichnis angeben.',
    billing_mode_default: 'subscription',
    supports_tools: ['web_search', 'web_fetch', 'workspace_read', 'workspace_write'],
    needs_secret: false,
    secret_label: null,
    config_fields: [
      { key: 'cli_path', label: 'Pfad zur CLI', type: 'text', help: 'Standard: claude (aus PATH)' },
      {
        key: 'config_dir',
        label: 'Konfigurationsverzeichnis (optional)',
        type: 'text',
        help: 'CLAUDE_CONFIG_DIR für ein separates Konto, z. B. ein zweites Abo. Leer = Standard-Anmeldung.',
      },
    ],
  },
  create: (provider) => new ClaudeCliAdapter(provider),
};

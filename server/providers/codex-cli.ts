import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Provider } from '../../shared/domain.ts';
import { isFile, killTree, parseResetFromText, which } from './claude-cli.ts';
import { isPng } from './png.ts';
import {
  emptyUsage,
  imageOnlyAdapter,
  ProviderError,
  type CallUsage,
  type ImageAdapter,
  type ImageCallRequest,
  type ImageCallResult,
  type ProviderTypeDef,
} from './types.ts';

/**
 * Bilder über das ChatGPT-Abo: nutzt die lokal installierte, mit ChatGPT angemeldete Codex CLI (`codex exec`).
 *
 * Codex erzeugt das Bild mit seinem eingebauten Werkzeug (Modell gpt-image-2) und legt es unter
 * `$CODEX_HOME/generated_images/<thread>/` ab – Davenet übernimmt die Datei von dort. Die Nutzung zählt auf das
 * Kontingent des ChatGPT-Plans (Plus/Pro …), es entstehen keine API-Kosten. Codex läuft dabei mit Sandbox
 * "read-only", ohne Nutzer-Konfiguration (keine eigenen MCP-Server) und wird angewiesen, ausschließlich das
 * Bildwerkzeug zu benutzen.
 */

interface CliCommand {
  file: string;
  pre: string[];
}

export function resolveCodexCommand(cliPath: string): CliCommand | null {
  const configured = cliPath.trim() || 'codex';
  let bin: string | null = configured.includes('/') || configured.includes('\\') ? (isFile(configured) ? configured : null) : which(configured);
  if (!bin) {
    const home = os.homedir();
    const exe = process.platform === 'win32' ? 'codex.exe' : 'codex';
    bin = [path.join(home, '.local', 'bin', exe), path.join(home, '.codex', 'bin', exe)].find(isFile) ?? null;
  }
  if (!bin) return null;
  try {
    const real = fs.realpathSync(bin);
    // npm-Installation (Link auf bin/codex.js) oder direkt angegebenes Skript -> mit dem eigenen Node starten
    if (/\.(c|m)?js$/i.test(real)) return { file: process.execPath, pre: [real] };
  } catch {
    /* ignorieren */
  }
  if (/\.(cmd|bat)$/i.test(bin)) {
    // Windows + npm: .cmd-Wrapper ohne Shell nicht startbar -> zugehöriges codex.js direkt mit Node ausführen
    const js = path.join(path.dirname(bin), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    return isFile(js) ? { file: process.execPath, pre: [js] } : null;
  }
  return { file: bin, pre: [] };
}

/** Liest "try again in 2 hours 30 minutes" / "try again at 5:00 PM" aus Limit-Meldungen. */
export function parseCodexReset(text: string, now = new Date()): string | null {
  const rel = text.match(/try again in\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m)\b[\s,and]*)+)/i);
  if (rel) {
    let ms = 0;
    for (const m of rel[1].matchAll(/(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m)\b/gi)) {
      const n = Number(m[1]);
      const unit = m[2].toLowerCase();
      ms += unit.startsWith('d') ? n * 86400_000 : unit.startsWith('h') ? n * 3600_000 : n * 60_000;
    }
    if (ms > 0) return new Date(now.getTime() + ms).toISOString();
  }
  const at = text.match(/try again (?:at|after)\s+([^.\n]+)/i);
  if (at) return parseResetFromText(`resets at ${at[1]}`, now);
  return parseResetFromText(text, now);
}

const sanitize = (v: string) => v.replace(/[^A-Za-z0-9_-]/g, '_') || 'generated_image';

const ASPECT: Record<ImageCallRequest['size'], string> = {
  '1024x1024': 'square (1:1)',
  '1536x1024': 'landscape (3:2)',
  '1024x1536': 'portrait (2:3)',
};

interface RunOutcome {
  threadId: string | null;
  usage: Record<string, number> | null;
  messages: string[];
  errors: string[];
  commands: number;
  stderr: string;
  exitCode: number | null;
  killedFor: 'timeout' | 'cancelled' | 'network' | null;
}

export class CodexCliImageAdapter implements ImageAdapter {
  /** Optionen, die eine ältere CLI-Version nicht kennt, werden nach dem ersten Fehlschlag weggelassen. */
  private static readonly unsupportedFlags = new Set<string>();

  constructor(private readonly provider: Provider) {}

  private get cfg(): { cli_path: string; codex_home: string; agent_model: string } {
    const c = this.provider.config ?? {};
    return { cli_path: String(c.cli_path ?? 'codex'), codex_home: String(c.codex_home ?? '').trim(), agent_model: String(c.agent_model ?? '').trim() };
  }

  /** Verzeichnis mit Anmeldung und erzeugten Bildern (CODEX_HOME, Standard ~/.codex). */
  codexHome(): string {
    return this.cfg.codex_home || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  }

  private childEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, CODEX_HOME: this.codexHome(), NO_COLOR: '1' };
    // Sicherstellen, dass das ChatGPT-Abo genutzt wird und nicht versehentlich ein API-Key (Kosten!)
    delete env.OPENAI_API_KEY;
    delete env.CODEX_API_KEY;
    return env;
  }

  async healthCheck(): Promise<{ ok: boolean; message: string }> {
    const cmd = resolveCodexCommand(this.cfg.cli_path);
    if (!cmd) {
      return {
        ok: false,
        message: `Codex CLI nicht gefunden (Pfad: "${this.cfg.cli_path}"). Installieren (npm install -g @openai/codex) und mit "codex login" über ChatGPT anmelden.`,
      };
    }
    const version = await this.runSimple(cmd, ['--version'], 15000);
    if (version.code !== 0) return { ok: false, message: `Codex CLI antwortet nicht: ${(version.stderr || version.stdout).slice(-200)}` };
    const v = version.stdout.trim().split('\n').pop() ?? 'codex';
    const status = await this.runSimple(cmd, ['login', 'status'], 15000);
    const text = `${status.stdout}\n${status.stderr}`;
    if (/logged in using chatgpt/i.test(text)) return { ok: true, message: `${v} – mit ChatGPT angemeldet, Bilder laufen über dein ChatGPT-Abo` };
    if (/logged in using an api key|api key/i.test(text) && /logged in/i.test(text)) {
      return { ok: true, message: `${v} – mit API-Key statt ChatGPT angemeldet: Bilder werden über die OpenAI-API abgerechnet` };
    }
    return { ok: false, message: `${v} – nicht angemeldet. Im Terminal "codex login" ausführen und "Sign in with ChatGPT" wählen.` };
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

  async generate(req: ImageCallRequest): Promise<ImageCallResult> {
    const cmd = resolveCodexCommand(this.cfg.cli_path);
    if (!cmd) throw new ProviderError('config', `Codex CLI nicht gefunden (Pfad: "${this.cfg.cli_path}").`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'davenet-codex-'));
    const before = this.snapshot();
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const out = await this.runOnce(cmd, req, tmp);
        const unknown = out.stderr.match(/unexpected argument '(--[\w-]+)'/);
        if (unknown && !out.threadId && !CodexCliImageAdapter.unsupportedFlags.has(unknown[1])) {
          CodexCliImageAdapter.unsupportedFlags.add(unknown[1]);
          req.log(`Codex CLI kennt ${unknown[1]} nicht (ältere Version) – Aufruf ohne diese Option wiederholt`, 'warn');
          continue;
        }
        return this.interpret(out, req, tmp, before);
      }
      throw new ProviderError('config', 'Codex CLI lehnt die Aufrufparameter ab – bitte Codex aktualisieren.');
    } finally {
      fs.rm(tmp, { recursive: true, force: true }, () => undefined);
    }
  }

  private buildArgs(tmp: string): string[] {
    const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '--ignore-user-config', '--ignore-rules', '--color', 'never', '-C', tmp];
    if (this.cfg.agent_model) args.push('-m', this.cfg.agent_model);
    const valueFlags = new Set(['--sandbox', '--color', '-C', '-m']);
    const out: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (CodexCliImageAdapter.unsupportedFlags.has(args[i])) {
        if (valueFlags.has(args[i])) i++;
        continue;
      }
      out.push(args[i]);
    }
    return out;
  }

  private prompt(req: ImageCallRequest): string {
    return [
      'Generate exactly one image with your built-in image generation tool (image_gen.imagegen).',
      'Do not run shell commands, do not read or modify files, do not browse the web and do not use any other tool.',
      `Transparent background: ${req.transparent ? 'yes (set transparent_background to true)' : 'no'}.`,
      `Aspect ratio: ${ASPECT[req.size]} – state it in the image prompt.`,
      'When the image has been generated, reply with the single word DONE. If image generation fails, reply with FAILED: <reason>.',
      '',
      'Image description:',
      req.prompt.trim(),
    ].join('\n');
  }

  private runOnce(cmd: CliCommand, req: ImageCallRequest, tmp: string): Promise<RunOutcome> {
    const args = this.buildArgs(tmp);
    return new Promise<RunOutcome>((resolve) => {
      const out: RunOutcome = { threadId: null, usage: null, messages: [], errors: [], commands: 0, stderr: '', exitCode: null, killedFor: null };
      let child: ChildProcess | null = null;
      let settled = false;
      let networkWaits = 0;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.signal.removeEventListener('abort', onAbort);
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
          cwd: tmp,
          env: this.childEnv(),
          windowsHide: true,
          detached: process.platform !== 'win32',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (e) {
        out.stderr = String(e);
        finish();
        return;
      }

      const onLine = (line: string) => {
        let j: Record<string, any>;
        try {
          j = JSON.parse(line);
        } catch {
          return;
        }
        switch (j.type) {
          case 'thread.started':
            out.threadId = String(j.thread_id ?? '') || null;
            break;
          case 'turn.completed':
            out.usage = (j.usage ?? null) as Record<string, number> | null;
            break;
          case 'turn.failed':
            out.errors.push(String(j.error?.message ?? 'Turn fehlgeschlagen'));
            break;
          case 'error': {
            const msg = String(j.message ?? '');
            if (/waiting for network/i.test(msg) && ++networkWaits >= 3) {
              out.killedFor = 'network';
              out.errors.push(msg);
              killTree(child);
            } else if (!/^Reconnecting/i.test(msg)) out.errors.push(msg);
            break;
          }
          case 'item.started':
          case 'item.completed': {
            const item = j.item ?? {};
            if (j.type === 'item.completed' && item.type === 'agent_message' && typeof item.text === 'string') out.messages.push(item.text);
            if (j.type === 'item.completed' && item.type === 'error' && item.message) out.errors.push(String(item.message));
            if (j.type === 'item.started' && item.type === 'command_execution') {
              out.commands++;
              req.log(`Codex wollte einen Befehl ausführen (Sandbox read-only): ${String(item.command ?? '').slice(0, 120)}`, 'warn');
            }
            break;
          }
          default:
            break;
        }
      };

      let buf = '';
      child.stdout!.setEncoding('utf8');
      child.stderr!.setEncoding('utf8');
      child.stdout!.on('data', (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) onLine(line);
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
        if (buf.trim()) onLine(buf.trim());
        out.exitCode = code;
        finish();
      });
      child.stdin!.on('error', () => undefined);
      child.stdin!.end(this.prompt(req));
    });
  }

  private images(dir: string): { file: string; mtime: number }[] {
    try {
      return fs
        .readdirSync(dir)
        .filter((n) => /\.(png|webp|jpe?g)$/i.test(n))
        .map((n) => ({ file: path.join(dir, n), mtime: fs.statSync(path.join(dir, n)).mtimeMs }));
    } catch {
      return [];
    }
  }

  private threadDirs(): string[] {
    const base = path.join(this.codexHome(), 'generated_images');
    try {
      return fs
        .readdirSync(base, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(base, e.name));
    } catch {
      return [];
    }
  }

  /** Vorhandene Bilder vor dem Aufruf – damit nur wirklich neue Dateien übernommen werden. */
  snapshot(): Map<string, number> {
    return new Map(this.threadDirs().flatMap((d) => this.images(d)).map((f) => [f.file, f.mtime]));
  }

  /** Neuestes Bild, das während dieses Aufrufs entstanden ist (zuerst im Ordner des Threads). */
  findImage(threadId: string | null, tmp: string, before: Map<string, number>): string | null {
    const isNew = (f: { file: string; mtime: number }) => !before.has(f.file) || f.mtime > before.get(f.file)!;
    const base = path.join(this.codexHome(), 'generated_images');
    const preferred = [...(threadId ? [path.join(base, sanitize(threadId))] : []), path.join(tmp, 'generated_images')];
    let found = preferred.flatMap((d) => this.images(d)).filter(isNew);
    // Rückfall: andere Thread-Ordner (z. B. abweichende Benennung in neueren Versionen)
    if (!found.length) found = this.threadDirs().flatMap((d) => this.images(d)).filter(isNew);
    found.sort((a, b) => b.mtime - a.mtime);
    return found[0]?.file ?? null;
  }

  private usageFrom(out: RunOutcome): CallUsage {
    const u = emptyUsage();
    u.requests = 1;
    u.inputTokens = Number(out.usage?.input_tokens) || 0;
    u.cacheReadTokens = Number(out.usage?.cached_input_tokens) || 0;
    u.outputTokens = (Number(out.usage?.output_tokens) || 0) + (Number(out.usage?.reasoning_output_tokens) || 0);
    u.toolCalls = 1;
    u.reportedCostUsd = 0;
    u.billed = false; // Abo-Kontingent, keine Kosten pro Bild
    return u;
  }

  private interpret(out: RunOutcome, req: ImageCallRequest, tmp: string, before: Map<string, number>): ImageCallResult {
    if (out.killedFor === 'cancelled') throw new ProviderError('cancelled', 'Abgebrochen');
    if (out.killedFor === 'timeout') throw new ProviderError('timeout', `Zeitlimit (${Math.round(req.timeoutMs / 1000)} s) überschritten`);
    if (out.killedFor === 'network') throw new ProviderError('transient', 'Codex erreicht OpenAI nicht (Netzwerk) – später erneut', { retryAfterMs: 5 * 60_000 });

    const file = this.findImage(out.threadId, tmp, before);
    if (file) {
      const image = fs.readFileSync(file);
      if (!isPng(image)) req.log('Codex hat kein PNG geliefert – Datei wird trotzdem übernommen', 'warn');
      req.log(`Bild von Codex übernommen: ${file}`);
      return { image, revisedPrompt: null, usage: this.usageFrom(out), model: 'gpt-image-2 (ChatGPT-Abo)' };
    }

    const text = [...out.errors, ...out.messages, out.stderr.trim().split(/\r?\n/).slice(-3).join(' ')].filter(Boolean).join(' | ').slice(0, 600);
    if (/ENOENT/.test(out.stderr) && !out.threadId) throw new ProviderError('config', `Codex CLI nicht startbar (Pfad: "${this.cfg.cli_path}").`);
    if (/usage limit|hit your limit|limit reached|rate limit|quota|too many requests/i.test(text)) {
      const resetAt = parseCodexReset(text);
      throw new ProviderError('quota', `ChatGPT-Limit für Bilder erreicht: ${text.slice(0, 300)}`, { resetAt, resetEstimated: !resetAt });
    }
    if (/not logged in|unauthori[sz]ed|\b401\b|codex login|sign in|authenticat|token.*(expired|invalid)/i.test(text)) {
      throw new ProviderError('auth', `Codex ist nicht (mehr) angemeldet – im Terminal "codex login" ausführen: ${text.slice(0, 200)}`);
    }
    if (/content policy|safety|moderation|not allowed/i.test(text)) throw new ProviderError('refusal', `Bild abgelehnt (Inhaltsrichtlinie): ${text.slice(0, 300)}`);
    if (/overloaded|5\d\d|internal server error|timed out|ECONNRESET|network|disconnected/i.test(text)) {
      throw new ProviderError('transient', `Codex: ${text.slice(0, 300)}`, { retryAfterMs: 2 * 60_000 });
    }
    throw new ProviderError('unknown', `Codex hat kein Bild erzeugt${text ? `: ${text}` : ` (Exit ${out.exitCode})`}`);
  }
}

export const codexCliType: ProviderTypeDef = {
  info: {
    type: 'codex_cli',
    kind: 'image',
    label: 'ChatGPT-Abo (Codex CLI)',
    description:
      'Erzeugt Bilder über dein ChatGPT-Abo (Plus/Pro …): nutzt die lokal installierte Codex CLI mit ihrem Bildwerkzeug (gpt-image-2). ' +
      'Einmalig "npm install -g @openai/codex" und "codex login" (Sign in with ChatGPT). Keine API-Kosten, es zählt das Kontingent deines Plans.',
    billing_mode_default: 'subscription',
    supports_tools: [],
    needs_secret: false,
    secret_label: null,
    config_fields: [
      { key: 'cli_path', label: 'Pfad zur Codex CLI', type: 'text', help: 'Standard: codex (aus PATH)' },
      {
        key: 'codex_home',
        label: 'Codex-Verzeichnis (optional)',
        type: 'text',
        help: 'CODEX_HOME für ein separates Konto. Leer = Standard (~/.codex). Dort legt Codex auch die Bilder ab.',
      },
      { key: 'agent_model', label: 'Codex-Modell (optional)', type: 'text', help: 'Steuermodell für den Bildauftrag; leer = Standard der CLI' },
    ],
  },
  create: (provider) => imageOnlyAdapter(new CodexCliImageAdapter(provider), 'Das ChatGPT-Abo (Codex)'),
  createImage: (provider) => new CodexCliImageAdapter(provider),
};

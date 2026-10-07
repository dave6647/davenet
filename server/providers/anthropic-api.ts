import Anthropic from '@anthropic-ai/sdk';
import type { Provider } from '../../shared/domain.ts';
import { Workspace } from '../engine/workspace.ts';
import type { SecretStore } from '../secrets.ts';
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
 * Adapter für die Anthropic Messages API (Pay-as-you-go per API-Key).
 *
 * - Websuche/-abruf über die serverseitigen Tools von Anthropic,
 * - Workspace-Werkzeuge als eigene Client-Tools (Tool-Loop hier im Adapter),
 * - strukturierte Ausgabe nativ über output_config.format, wenn der Job keine Werkzeuge nutzt,
 * - jeder einzelne API-Aufruf wird über onUsage ins Ledger gebucht.
 */

const MAX_ITERATIONS = 60;

/** Modelle mit den neueren Web-Tool-Varianten (dynamisches Filtern). */
const MODERN_WEB_TOOLS = /claude-(opus|sonnet)-(5|4-6|4-7|4-8)|claude-fable|claude-mythos/;
/** Modelle, die den serverseitigen Refusal-Fallback (`fallbacks: "default"`) unterstützen. */
const FALLBACK_MODELS = /^claude-(opus-5-5|opus-5|sonnet-5-5|fable-5-1)$/;

const WORKSPACE_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'list_files',
    description: 'Listet Dateien und Ordner im Projekt-Workspace (rekursiv). Pfade sind relativ zum Workspace.',
    input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Unterordner, Standard "."' } }, required: [] },
  },
  {
    name: 'read_file',
    description: 'Liest eine Textdatei aus dem Projekt-Workspace.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
];

const WRITE_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'write_file',
    description: 'Legt eine Datei im Projekt-Workspace an oder überschreibt sie vollständig.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string', description: 'Vollständiger Dateiinhalt' } },
      required: ['path', 'content'],
    },
  },
  {
    name: 'replace_in_file',
    description: 'Ersetzt einen eindeutigen Textausschnitt in einer Datei des Projekt-Workspace.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } },
      required: ['path', 'old_text', 'new_text'],
    },
  },
];

function addUsage(total: CallUsage, u: CallUsage): void {
  total.inputTokens += u.inputTokens;
  total.outputTokens += u.outputTokens;
  total.cacheReadTokens += u.cacheReadTokens;
  total.cacheWriteTokens += u.cacheWriteTokens;
  total.requests += u.requests;
  total.toolCalls += u.toolCalls;
  total.webSearches += u.webSearches;
}

export class AnthropicApiAdapter implements ProviderAdapter {
  constructor(
    private readonly provider: Provider,
    private readonly secrets: SecretStore,
  ) {}

  private client(): Anthropic {
    const cfg = this.provider.config ?? {};
    const envName = String(cfg.api_key_env ?? 'ANTHROPIC_API_KEY') || undefined;
    const { value } = this.secrets.resolve(this.provider.id, envName);
    if (!value) throw new ProviderError('auth', 'Kein API-Key hinterlegt (Provider-Einstellungen oder Umgebungsvariable).');
    const baseURL = String(cfg.base_url ?? '').trim() || undefined;
    return new Anthropic({ apiKey: value, baseURL, maxRetries: 2 });
  }

  async healthCheck(): Promise<{ ok: boolean; message: string }> {
    try {
      const page = await this.client().models.list({ limit: 20 });
      const ids = page.data.map((m) => m.id);
      return { ok: true, message: `API erreichbar – ${ids.length} Modelle sichtbar (${ids.slice(0, 4).join(', ')}${ids.length > 4 ? ', …' : ''})` };
    } catch (e) {
      const err = this.mapError(e, false);
      return { ok: false, message: err.message };
    }
  }

  async call(req: ModelCallRequest): Promise<ModelCallResult> {
    const client = this.client();
    const workspace = req.workspace ? new Workspace(req.workspace.dir, req.workspace.writable) : null;
    const modern = MODERN_WEB_TOOLS.test(req.model);

    const tools: Anthropic.Beta.BetaToolUnion[] = [];
    if (req.tools.includes('web_search')) {
      tools.push(
        modern
          ? { type: 'web_search_20260209', name: 'web_search', max_uses: Math.max(1, req.maxToolCalls) }
          : { type: 'web_search_20250305', name: 'web_search', max_uses: Math.max(1, req.maxToolCalls) },
      );
    }
    if (req.tools.includes('web_fetch')) {
      tools.push(
        modern
          ? { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: Math.max(1, req.maxToolCalls) }
          : { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: Math.max(1, req.maxToolCalls) },
      );
    }
    if (workspace && (req.tools.includes('workspace_read') || req.tools.includes('workspace_write'))) tools.push(...WORKSPACE_TOOLS);
    if (workspace?.writable && req.tools.includes('workspace_write')) tools.push(...WRITE_TOOLS);

    const cfg = this.provider.config ?? {};
    const useFallback = cfg.refusal_fallback !== false && cfg.refusal_fallback !== 'false' && FALLBACK_MODELS.test(req.model);
    const outputConfig: Anthropic.Beta.BetaOutputConfig = {};
    if (req.effort) outputConfig.effort = req.effort;
    // Native strukturierte Ausgabe nur ohne Werkzeuge (Web-Tools erzeugen Zitate, die sich damit nicht kombinieren lassen)
    const nativeFormat = !!req.outputSchema && tools.length === 0;
    if (nativeFormat) outputConfig.format = { type: 'json_schema', schema: req.outputSchema! };

    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: req.prompt }];
    const total = emptyUsage();
    total.billed = true;
    let clientToolCalls = 0;
    let lastModel = req.model;

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, req.timeoutMs);
    const onAbort = () => controller.abort();
    req.signal.addEventListener('abort', onAbort, { once: true });

    try {
      for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
        const params: Anthropic.Beta.MessageCreateParamsStreaming = {
          model: req.model,
          max_tokens: req.maxOutputTokens,
          system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
          messages,
          stream: true,
          ...(tools.length ? { tools } : {}),
          ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
          ...(useFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        };
        let msg: Anthropic.Beta.BetaMessage;
        try {
          msg = await client.beta.messages.stream(params, { signal: controller.signal }).finalMessage();
        } catch (e) {
          if (timedOut) throw new ProviderError('timeout', `Zeitlimit (${Math.round(req.timeoutMs / 1000)} s) überschritten`);
          throw this.mapError(e, req.signal.aborted);
        }

        lastModel = msg.model ?? req.model;
        const u = emptyUsage();
        u.inputTokens = msg.usage.input_tokens ?? 0;
        u.outputTokens = msg.usage.output_tokens ?? 0;
        u.cacheReadTokens = msg.usage.cache_read_input_tokens ?? 0;
        u.cacheWriteTokens = msg.usage.cache_creation_input_tokens ?? 0;
        u.webSearches = msg.usage.server_tool_use?.web_search_requests ?? 0;
        u.requests = 1;
        u.billed = true;
        const toolUses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
        u.toolCalls = toolUses.length + msg.content.filter((b) => b.type === 'server_tool_use').length;
        req.onUsage(u, lastModel);
        addUsage(total, u);
        req.guard?.(total);

        if (msg.stop_reason === 'refusal') {
          throw new ProviderError('refusal', `Modell hat die Anfrage abgelehnt (${msg.stop_details?.category ?? 'ohne Kategorie'})`);
        }
        if (msg.stop_reason === 'pause_turn') {
          messages.push({ role: 'assistant', content: msg.content });
          continue;
        }
        if (msg.stop_reason === 'tool_use' && toolUses.length) {
          messages.push({ role: 'assistant', content: msg.content });
          const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
          for (const call of toolUses) {
            clientToolCalls++;
            if (clientToolCalls > req.maxToolCalls) {
              results.push({
                type: 'tool_result',
                tool_use_id: call.id,
                is_error: true,
                content: 'Tool-Call-Limit erreicht. Bitte jetzt mit dem bisherigen Stand abschließen und das Ergebnis liefern.',
              });
              continue;
            }
            results.push(this.runWorkspaceTool(workspace, call, req));
          }
          if (clientToolCalls > req.maxToolCalls + 5) throw new ProviderError('limit', `Tool-Call-Limit (${req.maxToolCalls}) überschritten`);
          messages.push({ role: 'user', content: results });
          continue;
        }

        const text = msg.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();
        if (msg.stop_reason === 'max_tokens') req.log('Antwort wurde am Output-Limit abgeschnitten', 'warn');
        let structured: unknown;
        if (nativeFormat && text) {
          try {
            structured = JSON.parse(text);
          } catch {
            structured = undefined;
          }
        }
        return { text, structured, usage: total, model: lastModel, stopReason: msg.stop_reason ?? undefined };
      }
      throw new ProviderError('limit', 'Maximale Anzahl an Modellaufrufen erreicht, ohne Ergebnis');
    } finally {
      clearTimeout(timer);
      req.signal.removeEventListener('abort', onAbort);
    }
  }

  private runWorkspaceTool(
    workspace: Workspace | null,
    call: Anthropic.Beta.BetaToolUseBlock,
    req: ModelCallRequest,
  ): Anthropic.Beta.BetaToolResultBlockParam {
    const input = (call.input ?? {}) as Record<string, unknown>;
    const str = (k: string): string => (typeof input[k] === 'string' ? (input[k] as string) : '');
    try {
      if (!workspace) throw new Error('Kein Workspace für diesen Job');
      let content: string;
      switch (call.name) {
        case 'list_files':
          content = workspace.list(str('path') || '.');
          break;
        case 'read_file':
          content = workspace.read(str('path'));
          break;
        case 'write_file':
          if (!str('path')) throw new Error('path fehlt');
          workspace.write(str('path'), typeof input.content === 'string' ? input.content : '');
          req.log(`Datei geschrieben: ${str('path')}`);
          content = 'OK';
          break;
        case 'replace_in_file':
          workspace.replace(str('path'), str('old_text'), str('new_text'));
          req.log(`Datei geändert: ${str('path')}`);
          content = 'OK';
          break;
        default:
          throw new Error(`Unbekanntes Werkzeug ${call.name}`);
      }
      return { type: 'tool_result', tool_use_id: call.id, content };
    } catch (e) {
      return { type: 'tool_result', tool_use_id: call.id, is_error: true, content: e instanceof Error ? e.message : String(e) };
    }
  }

  private mapError(e: unknown, aborted: boolean): ProviderError {
    if (e instanceof ProviderError) return e;
    if (e instanceof Anthropic.APIUserAbortError || aborted) return new ProviderError('cancelled', 'Abgebrochen');
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      return new ProviderError('auth', `API-Key ungültig oder ohne Berechtigung (${e.status})`);
    }
    if (e instanceof Anthropic.RateLimitError) {
      const ra = Number(e.headers?.get('retry-after'));
      return new ProviderError('rate_limit', 'Rate Limit der API erreicht', { retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : 30_000 });
    }
    if (e instanceof Anthropic.NotFoundError) return new ProviderError('config', `Modell oder Endpunkt nicht gefunden: ${e.message.slice(0, 200)}`);
    if (e instanceof Anthropic.BadRequestError) {
      if (/credit balance|billing/i.test(e.message)) return new ProviderError('billing', 'API-Guthaben aufgebraucht oder Billing-Problem');
      return new ProviderError('invalid_request', `Ungültige Anfrage: ${e.message.slice(0, 300)}`);
    }
    if (e instanceof Anthropic.InternalServerError) return new ProviderError('transient', `API-Fehler ${e.status}`, { retryAfterMs: 30_000 });
    if (e instanceof Anthropic.APIError) {
      if (e.status === 402) return new ProviderError('billing', 'Billing-Problem beim API-Konto');
      if (e.status === 529) return new ProviderError('transient', 'API überlastet', { retryAfterMs: 60_000 });
      return new ProviderError('unknown', `API-Fehler ${e.status ?? ''}: ${e.message.slice(0, 300)}`);
    }
    if (e instanceof Anthropic.APIConnectionError) return new ProviderError('transient', `Verbindungsfehler: ${e.message.slice(0, 200)}`, { retryAfterMs: 15_000 });
    return new ProviderError('unknown', e instanceof Error ? e.message : String(e));
  }
}

export const anthropicApiType: ProviderTypeDef = {
  info: {
    type: 'anthropic_api',
    kind: 'llm',
    label: 'Anthropic API (API-Key)',
    description: 'Direkter Zugang zur Claude API mit API-Key. Abrechnung pro Token – Kostenlimit pro Monat empfohlen.',
    billing_mode_default: 'pay_as_you_go',
    supports_tools: ['web_search', 'web_fetch', 'workspace_read', 'workspace_write'],
    needs_secret: true,
    secret_label: 'API-Key',
    config_fields: [
      { key: 'api_key_env', label: 'Umgebungsvariable (Rückfall)', type: 'text', help: 'Wird genutzt, wenn kein Key gespeichert ist. Standard: ANTHROPIC_API_KEY' },
      { key: 'base_url', label: 'Basis-URL (optional)', type: 'text', help: 'Nur für Proxies/Gateways, sonst leer lassen.' },
    ],
  },
  create: (provider, ctx) => new AnthropicApiAdapter(provider, ctx.secrets),
};

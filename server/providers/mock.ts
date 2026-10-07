import { CRITERION_KEYS, type Provider } from '../../shared/domain.ts';
import { Workspace } from '../engine/workspace.ts';
import {
  emptyUsage,
  ProviderError,
  type JsonSchema,
  type ModelCallRequest,
  type ModelCallResult,
  type ProviderAdapter,
  type ProviderTypeDef,
} from './types.ts';

/**
 * Simulations-Provider: erzeugt schema-konforme Platzhalter-Ergebnisse ohne echte KI.
 * Gedacht zum Ausprobieren der Abläufe (Queue, Pipeline, Freigaben, Ledger, Kontingente) ohne Kosten.
 * Alle Texte sind deutlich als Simulation gekennzeichnet.
 */

interface SampleContext {
  ids: string[];
  seed: number;
}

function sample(schema: JsonSchema | undefined, ctx: SampleContext, key = '', depth = 0): unknown {
  if (!schema || depth > 8) return null;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if ('const' in schema) return schema.const;
  const anyOf = (schema.anyOf ?? schema.oneOf) as JsonSchema[] | undefined;
  if (Array.isArray(anyOf) && anyOf.length) {
    const nonNull = anyOf.find((s) => s.type !== 'null') ?? anyOf[0];
    return sample(nonNull, ctx, key, depth + 1);
  }
  const type = Array.isArray(schema.type) ? (schema.type as string[]).find((t) => t !== 'null') : (schema.type as string | undefined);
  switch (type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
      for (const [k, v] of Object.entries(props)) out[k] = sample(v, ctx, k, depth + 1);
      return out;
    }
    case 'array': {
      const items = schema.items as JsonSchema | undefined;
      const itemProps = (items?.properties ?? {}) as Record<string, JsonSchema>;
      // Listen mit "id" je übergebener Opportunity befüllen (z. B. Screening-Ergebnisse)
      if (items?.type === 'object' && ('id' in itemProps || 'opportunity_id' in itemProps) && ctx.ids.length) {
        return ctx.ids.map((id) => {
          const obj = sample(items, ctx, key, depth + 1) as Record<string, unknown>;
          if ('id' in itemProps) obj.id = id;
          if ('opportunity_id' in itemProps) obj.opportunity_id = id;
          return obj;
        });
      }
      if (/depends|blocked/i.test(key)) return [];
      const n = /sources|findings|risks|issues/i.test(key) ? 2 : /tasks|opportunities|plan|actions/i.test(key) ? 2 : 1;
      return Array.from({ length: n }, (_, i) => {
        const v = sample(items, ctx, key, depth + 1);
        if (v && typeof v === 'object' && 'key' in (v as object)) (v as Record<string, unknown>).key = `T${i + 1}`;
        if (v && typeof v === 'object' && 'title' in (v as object)) (v as Record<string, unknown>).title = `Simulation ${key} ${i + 1}`;
        return v;
      });
    }
    case 'integer':
    case 'number': {
      if ((CRITERION_KEYS as string[]).includes(key)) return 7;
      if (/^duration_days$/.test(key)) return 14;
      if (/^minutes$/.test(key)) return 30;
      if (/confidence/i.test(key)) return 0.7;
      if (/risk/i.test(key)) return 3;
      if (/_score$|^score$/i.test(key) && !/screening/i.test(key)) return 7;
      if (/screening_score|overall/i.test(key)) return 75;
      return type === 'integer' ? 1 : 1.5;
    }
    case 'boolean':
      return true;
    case 'string':
    default: {
      if (/url/i.test(key)) return `https://example.com/simulation/${ctx.seed}`;
      if (/markdown|report|spec|summary|briefing/i.test(key)) {
        return `# Simulation\n\nDies ist ein **simuliertes** Ergebnis (Feld \`${key}\`) – es wurde keine KI aufgerufen.`;
      }
      return `Simulation: ${key || 'Text'}`;
    }
  }
}

export class MockAdapter implements ProviderAdapter {
  constructor(private readonly provider: Provider) {}

  async healthCheck(): Promise<{ ok: boolean; message: string }> {
    return { ok: true, message: 'Simulation bereit (keine echten KI-Aufrufe)' };
  }

  async call(req: ModelCallRequest): Promise<ModelCallResult> {
    const latency = Number(this.provider.config?.latency_ms ?? 300);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, Math.max(0, latency));
      req.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          reject(new ProviderError('cancelled', 'Abgebrochen'));
        },
        { once: true },
      );
    });
    const ids = [...new Set(req.prompt.match(/OPP-\d{4}(?!-)/g) ?? [])];
    const ctx: SampleContext = { ids, seed: Math.floor(Math.random() * 1e6) };

    let toolCalls = 0;
    if (req.workspace?.writable && req.tools.includes('workspace_write')) {
      const ws = new Workspace(req.workspace.dir, true);
      const task = req.prompt.match(/OPP-\d{4}-(T\d+)/)?.[1] ?? 'task';
      ws.write(`simulation/${task}.md`, `# Simulation ${task}\n\nPlatzhalter-Implementierung aus dem Simulations-Provider.\n`);
      toolCalls = 1;
      req.log(`Datei geschrieben: simulation/${task}.md`);
    }

    const structured = req.outputSchema ? sample(req.outputSchema, ctx) : undefined;
    const text = structured !== undefined ? JSON.stringify(structured) : 'Simulation: keine echte Antwort.';
    const usage = emptyUsage();
    usage.inputTokens = Math.ceil((req.system.length + req.prompt.length) / 4);
    usage.outputTokens = Math.ceil(text.length / 4);
    usage.requests = 1;
    usage.toolCalls = toolCalls;
    usage.reportedCostUsd = 0;
    usage.billed = false;
    req.onUsage(usage, req.model);
    req.guard?.(usage);
    return { text, structured, usage, model: req.model, stopReason: 'end_turn' };
  }
}

export const mockType: ProviderTypeDef = {
  info: {
    type: 'mock',
    kind: 'llm',
    label: 'Simulation (ohne KI)',
    description: 'Erzeugt Platzhalter-Ergebnisse ohne echte Modellaufrufe – zum Testen der Abläufe ohne Kosten.',
    billing_mode_default: 'subscription',
    supports_tools: ['web_search', 'web_fetch', 'workspace_read', 'workspace_write'],
    needs_secret: false,
    secret_label: null,
    config_fields: [{ key: 'latency_ms', label: 'Simulierte Laufzeit (ms)', type: 'number' }],
  },
  create: (provider) => new MockAdapter(provider),
};

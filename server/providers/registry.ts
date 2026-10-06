import type { Provider, ProviderTypeInfo } from '../../shared/domain.ts';
import { anthropicApiType } from './anthropic-api.ts';
import { claudeCliType } from './claude-cli.ts';
import { mockType } from './mock.ts';
import type { AdapterContext, ProviderAdapter, ProviderTypeDef } from './types.ts';

/**
 * Register aller Provider-Typen. Ein neuer Anbieter (z. B. OpenAI/Codex-CLI, Gemini, OpenRouter, Ollama)
 * wird als weiterer ProviderTypeDef ergänzt – Agents, Router und Ledger bleiben unverändert.
 */
const TYPES = new Map<string, ProviderTypeDef>();

export function registerProviderType(def: ProviderTypeDef): void {
  TYPES.set(def.info.type, def);
}

registerProviderType(claudeCliType);
registerProviderType(anthropicApiType);
registerProviderType(mockType);

export function providerTypes(): ProviderTypeInfo[] {
  return [...TYPES.values()].map((t) => t.info);
}

export function providerTypeInfo(type: string): ProviderTypeInfo | undefined {
  return TYPES.get(type)?.info;
}

export function createAdapter(provider: Provider, ctx: AdapterContext): ProviderAdapter {
  const def = TYPES.get(provider.type);
  if (!def) throw new Error(`Unbekannter Provider-Typ: ${provider.type}`);
  return def.create(provider, ctx);
}

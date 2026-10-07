import type { Provider, ProviderKind, ProviderTypeInfo } from '../../shared/domain.ts';
import { anthropicApiType } from './anthropic-api.ts';
import { claudeCliType } from './claude-cli.ts';
import { codexCliType } from './codex-cli.ts';
import { mockImageType } from './mock-image.ts';
import { mockType } from './mock.ts';
import { openAiImagesType } from './openai-images.ts';
import { ProviderError, type AdapterContext, type ImageAdapter, type ProviderAdapter, type ProviderTypeDef } from './types.ts';

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
registerProviderType(codexCliType);
registerProviderType(openAiImagesType);
registerProviderType(mockImageType);

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

/** Art des Providers (Sprachmodell oder Bilder); unbekannte Typen gelten als Sprachmodell. */
export function providerKind(type: string): ProviderKind {
  return TYPES.get(type)?.info.kind ?? 'llm';
}

export function createImageAdapter(provider: Provider, ctx: AdapterContext): ImageAdapter {
  const def = TYPES.get(provider.type);
  if (!def?.createImage) throw new ProviderError('config', `${provider.name} kann keine Bilder erzeugen`);
  return def.createImage(provider, ctx);
}

import type { Provider } from '../../shared/domain.ts';
import type { SecretStore } from '../secrets.ts';
import { isPng } from './png.ts';
import {
  emptyUsage,
  imageOnlyAdapter,
  ProviderError,
  type AdapterContext,
  type ImageAdapter,
  type ImageCallRequest,
  type ImageCallResult,
  type ProviderTypeDef,
} from './types.ts';

/**
 * OpenAI-Bild-API (Pay-as-you-go, API-Key von platform.openai.com).
 * Abrechnung pro Token (Text-Input, Bild-Output); die Preise je Modell stehen in der Modell-Liste des Providers.
 * Hinweis: Ein ChatGPT-Abo enthält keinen API-Zugang – dafür gibt es den Provider-Typ "ChatGPT-Abo (Codex CLI)".
 */
export class OpenAiImagesAdapter implements ImageAdapter {
  constructor(
    private readonly provider: Provider,
    private readonly secrets: SecretStore,
  ) {}

  private get baseUrl(): string {
    return (String(this.provider.config?.base_url ?? '').trim() || 'https://api.openai.com/v1').replace(/\/+$/, '');
  }

  private apiKey(): string {
    const envName = String(this.provider.config?.api_key_env ?? 'OPENAI_API_KEY') || undefined;
    const { value } = this.secrets.resolve(this.provider.id, envName);
    if (!value) throw new ProviderError('auth', 'Kein OpenAI-API-Key hinterlegt (Provider-Einstellungen oder Umgebungsvariable).');
    return value;
  }

  async healthCheck(): Promise<{ ok: boolean; message: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, { headers: { Authorization: `Bearer ${this.apiKey()}` }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) return { ok: false, message: (await this.errorFrom(res)).message };
      const j = (await res.json()) as { data?: { id: string }[] };
      const images = (j.data ?? []).map((m) => m.id).filter((id) => /image/i.test(id));
      return { ok: true, message: `API-Key gültig${images.length ? ` – Bildmodelle: ${images.slice(0, 5).join(', ')}` : ''}` };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  async generate(req: ImageCallRequest): Promise<ImageCallResult> {
    const key = this.apiKey();
    const timeout = AbortSignal.timeout(req.timeoutMs);
    const body: Record<string, unknown> = { model: req.model, prompt: req.prompt, size: req.size, quality: req.quality, n: 1, output_format: 'png' };
    if (req.transparent) body.background = 'transparent';
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/images/generations`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.any([req.signal, timeout]),
      });
    } catch (e) {
      if (req.signal.aborted) throw new ProviderError('cancelled', 'Abgebrochen');
      if (timeout.aborted) throw new ProviderError('timeout', `Zeitlimit (${Math.round(req.timeoutMs / 1000)} s) überschritten`);
      throw new ProviderError('transient', `OpenAI nicht erreichbar: ${e instanceof Error ? e.message : String(e)}`, { retryAfterMs: 60_000 });
    }
    if (!res.ok) throw await this.errorFrom(res);
    const j = (await res.json()) as {
      data?: { b64_json?: string; revised_prompt?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const b64 = j.data?.[0]?.b64_json;
    if (!b64) throw new ProviderError('unknown', 'Antwort der OpenAI-API enthält kein Bild');
    const image = Buffer.from(b64, 'base64');
    if (!isPng(image)) throw new ProviderError('unknown', 'OpenAI hat kein gültiges PNG geliefert');
    const usage = emptyUsage();
    usage.requests = 1;
    usage.inputTokens = Number(j.usage?.input_tokens) || 0;
    usage.outputTokens = Number(j.usage?.output_tokens) || 0;
    usage.billed = true;
    req.log(`Bild erzeugt (${req.model}, ${req.size}, ${req.quality}${req.transparent ? ', transparent' : ''})`);
    return { image, revisedPrompt: j.data?.[0]?.revised_prompt ?? null, usage, model: req.model };
  }

  private async errorFrom(res: Response): Promise<ProviderError> {
    let message = `${res.status} ${res.statusText}`;
    let code = '';
    try {
      const j = (await res.json()) as { error?: { message?: string; code?: string; type?: string } };
      message = j.error?.message || message;
      code = `${j.error?.code ?? ''} ${j.error?.type ?? ''}`;
    } catch {
      /* kein JSON */
    }
    const text = `OpenAI: ${message}`.slice(0, 400);
    if (res.status === 401) return new ProviderError('auth', `${text} – API-Key prüfen`);
    if (res.status === 403) return new ProviderError('config', `${text} (ggf. muss die Organisation bei OpenAI verifiziert werden)`);
    if (res.status === 404) return new ProviderError('config', `${text} – Modell nicht verfügbar`);
    if (res.status === 429) {
      if (/insufficient_quota|billing|credit/i.test(`${code} ${message}`)) return new ProviderError('billing', `${text} – Guthaben/Billing bei OpenAI prüfen`);
      const retry = Number(res.headers.get('retry-after'));
      return new ProviderError('rate_limit', text, { retryAfterMs: Number.isFinite(retry) && retry > 0 ? retry * 1000 : 60_000 });
    }
    if (res.status === 400 && /moderation|safety|content_policy/i.test(`${code} ${message}`)) return new ProviderError('refusal', `${text} (Inhaltsrichtlinie)`);
    if (res.status >= 500) return new ProviderError('transient', text, { retryAfterMs: 60_000 });
    return new ProviderError('invalid_request', text);
  }
}

export const openAiImagesType: ProviderTypeDef = {
  info: {
    type: 'openai_images',
    kind: 'image',
    label: 'OpenAI Bild-API (API-Key)',
    description:
      'Erzeugt Bilder über die OpenAI-API (gpt-image-Modelle) mit eigenem API-Key und Abrechnung pro Bild. ' +
      'Ein ChatGPT-Abo enthält keinen API-Zugang – für das Abo den Typ "ChatGPT-Abo (Codex CLI)" nutzen.',
    billing_mode_default: 'pay_as_you_go',
    supports_tools: [],
    needs_secret: true,
    secret_label: 'OpenAI API-Key',
    config_fields: [
      { key: 'api_key_env', label: 'Umgebungsvariable (Rückfall)', type: 'text', help: 'Wird genutzt, wenn kein Key gespeichert ist. Standard: OPENAI_API_KEY' },
      { key: 'base_url', label: 'Basis-URL (optional)', type: 'text', help: 'Standard: https://api.openai.com/v1' },
    ],
  },
  create: (provider, ctx: AdapterContext) => imageOnlyAdapter(new OpenAiImagesAdapter(provider, ctx.secrets), 'Die OpenAI-Bild-API'),
  createImage: (provider, ctx: AdapterContext) => new OpenAiImagesAdapter(provider, ctx.secrets),
};

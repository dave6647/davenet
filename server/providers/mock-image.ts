import { createHash } from 'node:crypto';
import type { Provider } from '../../shared/domain.ts';
import { encodePng } from './png.ts';
import { emptyUsage, imageOnlyAdapter, ProviderError, type ImageAdapter, type ImageCallRequest, type ImageCallResult, type ProviderTypeDef } from './types.ts';

/**
 * Bild-Simulation: erzeugt ein kleines Farbverlaufs-PNG ohne KI und ohne Kosten –
 * zum Ausprobieren der Bild-Abläufe (Jobs, Ablage, Ledger, Vorschau).
 */
export class MockImageAdapter implements ImageAdapter {
  constructor(private readonly provider: Provider) {}

  async healthCheck(): Promise<{ ok: boolean; message: string }> {
    return { ok: true, message: 'Bild-Simulation bereit (keine echten Bilder, keine Kosten)' };
  }

  async generate(req: ImageCallRequest): Promise<ImageCallResult> {
    const latency = Number(this.provider.config?.latency_ms ?? 200);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, Math.max(0, latency));
      req.signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new ProviderError('cancelled', 'Abgebrochen'));
      }, { once: true });
    });
    const [w, h] = req.size === '1536x1024' ? [96, 64] : req.size === '1024x1536' ? [64, 96] : [64, 64];
    const seed = createHash('sha256').update(req.prompt).digest();
    const image = encodePng(w, h, (x, y) => [
      (seed[0] + Math.round((x / w) * 160)) % 256,
      (seed[1] + Math.round((y / h) * 160)) % 256,
      seed[2],
    ]);
    req.log(`Simuliertes Bild erzeugt (${w}×${h} px)`);
    const usage = emptyUsage();
    usage.requests = 1;
    usage.reportedCostUsd = 0;
    usage.billed = false;
    return { image, revisedPrompt: null, usage, model: req.model };
  }
}

export const mockImageType: ProviderTypeDef = {
  info: {
    type: 'mock_image',
    kind: 'image',
    label: 'Bild-Simulation (ohne KI)',
    description: 'Erzeugt kleine Platzhalter-Bilder ohne echte Bildgenerierung – zum Testen der Abläufe ohne Kosten.',
    billing_mode_default: 'subscription',
    supports_tools: [],
    needs_secret: false,
    secret_label: null,
    config_fields: [{ key: 'latency_ms', label: 'Simulierte Laufzeit (ms)', type: 'number' }],
  },
  create: (provider) => imageOnlyAdapter(new MockImageAdapter(provider), 'Die Bild-Simulation'),
  createImage: (provider) => new MockImageAdapter(provider),
};

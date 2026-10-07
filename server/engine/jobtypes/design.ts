import { z } from 'zod';
import type { ImageSize } from '../../providers/types.ts';
import type { JobTypeDef } from './types.ts';

/** Bilder über einen Bild-Provider (ChatGPT-Abo per Codex CLI, OpenAI-Bild-API, Simulation) – ohne Sprachmodell. */

const SIZE: Record<string, ImageSize> = { square: '1024x1024', landscape: '1536x1024', portrait: '1024x1536' };

const ImageOutput = z.object({
  file: z.string(),
  workspace_file: z.string().nullable(),
  bytes: z.number(),
  model: z.string(),
  revised_prompt: z.string().nullable(),
});

export const imageGeneration: JobTypeDef<z.infer<typeof ImageOutput>> = {
  key: 'image_generation',
  label: 'Bild erzeugen',
  description: 'Erzeugt ein Bild über den Bild-Provider (z. B. dein ChatGPT-Abo). Mit Opportunity landet es zusätzlich im Projekt-Workspace unter assets/.',
  departmentHint: 'Design',
  defaultAgent: 'DESIGNER',
  tools: [],
  manual: true,
  providerKind: 'image',
  inputFields: [
    { key: 'prompt', label: 'Bildbeschreibung', type: 'textarea', required: true },
    { key: 'file_name', label: 'Dateiname (optional, ohne Endung)', type: 'text' },
    {
      key: 'aspect',
      label: 'Format',
      type: 'select',
      options: [
        { value: 'square', label: 'quadratisch (1024×1024)' },
        { value: 'landscape', label: 'quer (1536×1024)' },
        { value: 'portrait', label: 'hoch (1024×1536)' },
      ],
    },
    {
      key: 'quality',
      label: 'Qualität (nur Bild-API)',
      type: 'select',
      options: [
        { value: 'medium', label: 'mittel' },
        { value: 'low', label: 'niedrig (günstig)' },
        { value: 'high', label: 'hoch' },
      ],
    },
    { key: 'transparent', label: 'Transparenter Hintergrund', type: 'checkbox' },
  ],
  output: ImageOutput,
  title: (input) => `Bild: ${String(input.file_name || input.prompt || '').slice(0, 60)}`,
  // Bild-Jobs laufen ohne Sprachmodell – Prompt und Ergebnis kommen über die image-Hooks
  buildPrompt: () => ({ task: '', sections: [] }),
  complete: () => undefined,
  image: {
    request: ({ job }) => ({
      prompt: String(job.input.prompt ?? '').trim(),
      size: SIZE[String(job.input.aspect)] ?? '1024x1024',
      quality: (['low', 'medium', 'high'] as const).find((q) => q === job.input.quality) ?? 'medium',
      transparent: job.input.transparent === true || job.input.transparent === 'true',
    }),
    complete: (ctx, result) => ctx.orch.saveGeneratedImage(ctx, result),
  },
};

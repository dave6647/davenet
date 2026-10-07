import { z } from 'zod';
import { CRITERIA, type CriterionKey } from '../../../shared/domain.ts';

/** Gemeinsame Ergebnis-Bausteine der Job-Typen (Bewertung, Testplan, Bildanfragen). */

/** Alle 13 Kriterien nur als Zahl (Screening). */
export const criteriaNumbers = () =>
  z.object(
    Object.fromEntries(CRITERIA.map((c) => [c.key, z.number().describe(`0–10, 10 = am besten: ${c.question}`)])) as Record<CriterionKey, z.ZodNumber>,
  );

/** Alle 13 Kriterien mit kurzer Begründung (Bewertung). */
export const criteriaWithNotes = () =>
  z.object(
    Object.fromEntries(
      CRITERIA.map((c) => [
        c.key,
        z
          .object({
            score: z.number().describe('0–10, 10 = am besten'),
            note: z.string().describe('Begründung, max. 25 Wörter'),
          })
          .describe(`${c.label}: ${c.question}`),
      ]),
    ) as Record<CriterionKey, z.ZodObject<{ score: z.ZodNumber; note: z.ZodString }>>,
  );

export const TestPlanSchema = z.object({
  hypothesis: z.string().describe('welche Nachfrage der Test nachweisen soll, max. 40 Wörter'),
  channel: z.string().describe('Testkanal, z. B. Listing, Landingpage, Vorverkauf, Community-Beitrag'),
  budget_eur: z.number().describe('externe Kosten in € (Domain, Gebühren, Werbung …); KI-Nutzung zählt nicht'),
  owner_hours: z.number().describe('Zeit, die der Owner selbst investieren muss, in Stunden'),
  duration_days: z.number().describe('Laufzeit in Tagen'),
  metric: z.string().describe('Messgröße, z. B. Verkäufe, Anfragen, Anmeldungen'),
  success_criterion: z.string().describe('ab wann der Test als bestanden gilt, messbar'),
  owner_steps: z.array(z.string()).describe('was der Owner selbst tun muss (Account, Veröffentlichung, Zahlung …)'),
  materials: z.array(z.string()).describe('was Davenet vorbereitet (Texte, Landingpage, Designs …)'),
});

export const ImageRequestSchema = z.object({
  file_name: z.string().describe('Dateiname ohne Endung, z. B. motiv-1'),
  prompt: z.string().describe('präzise Bildbeschreibung: Motiv, Stil, Farben, Komposition, ggf. Text im Bild'),
  aspect: z.enum(['square', 'landscape', 'portrait']).describe('Seitenverhältnis'),
  transparent: z.boolean().describe('transparenter Hintergrund, z. B. für Druckmotive'),
  purpose: z.string().describe('wofür das Bild gebraucht wird'),
});
export type ImageRequest = z.infer<typeof ImageRequestSchema>;

export const imageRequestsField = () =>
  z
    .array(ImageRequestSchema)
    .describe(
      'nur wenn Rasterbilder nötig sind (Fotos, Illustrationen, Motive); Logos, Icons und Schrift-Designs selbst als SVG erstellen. Höchstens 4.',
    )
    .optional();

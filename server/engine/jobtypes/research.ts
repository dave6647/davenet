import { z } from 'zod';
import type { Settings } from '../../../shared/domain.ts';
import type { JobTypeDef } from './types.ts';
import { artifactSection, knowledgeSection, knownOpportunitiesSection, opportunityJson, opportunitySection, strategySection } from './common.ts';
import { criteriaNumbers, criteriaWithNotes, TestPlanSchema } from './schemas.ts';

const SourceSchema = z.object({
  title: z.string().describe('Titel der Quelle'),
  url: z.string().describe('URL'),
  note: z.string().optional().describe('wofür die Quelle relevant ist'),
});

// ---------------------------------------------------------------- Opportunity-Scan (Scout)

const ScanOutput = z.object({
  summary: z.string().describe('Kurzfazit des Scans, max. 120 Wörter'),
  opportunities: z
    .array(
      z.object({
        title: z.string().describe('prägnanter Arbeitstitel'),
        problem: z.string().describe('konkretes Problem, max. 80 Wörter'),
        target_customer: z.string().describe('Zielkunden, so konkret wie möglich'),
        proposed_solution: z.string().describe('Lösungsidee, max. 80 Wörter'),
        revenue_model: z.string().describe('wie Geld verdient wird'),
        rationale: z.string().describe('warum das zur Strategie passt, max. 60 Wörter'),
        sources: z.array(SourceSchema).describe('Belege für Problem/Nachfrage'),
      }),
    )
    .describe('neue, noch nicht bekannte Kandidaten'),
});

export const opportunityScan: JobTypeDef<z.infer<typeof ScanOutput>> = {
  key: 'opportunity_scan',
  label: 'Opportunity-Scan',
  description: 'Sucht neue Geschäftsmöglichkeiten passend zur Strategie (Research-Zyklus).',
  departmentHint: 'Research / R&D',
  defaultAgent: 'OPPORTUNITY_SCOUT',
  tools: ['web_search', 'web_fetch'],
  manual: true,
  inputFields: [
    { key: 'focus', label: 'Fokus / Thema (optional)', type: 'textarea' },
    { key: 'count', label: 'Anzahl Kandidaten', type: 'number' },
  ],
  output: ScanOutput,
  title: (input) => `Opportunity-Scan${input.focus ? `: ${String(input.focus).slice(0, 60)}` : ''}`,
  buildPrompt: ({ orch, job, settings }) => {
    const count = Math.min(10, Math.max(1, Number(job.input.count) || settings.scan_default_count));
    const focus = String(job.input.focus ?? '').trim();
    return {
      task: [
        `Finde bis zu ${count} neue, vielversprechende Geschäftsmöglichkeiten für das Unternehmen.`,
        focus ? `Fokus dieses Scans: ${focus}` : 'Orientiere dich an den Suchfeldern der Strategie.',
        'Prüfe per Websuche kurz, ob Problem und Zahlungsbereitschaft real sind, und belege das mit Quellen.',
        'Liefere nur Kandidaten, die nicht in der Liste bekannter Opportunities stehen. Lieber wenige gute als viele schwache.',
      ].join('\n'),
      sections: [strategySection(orch, 10), knownOpportunitiesSection(orch, 6), knowledgeSection(orch, 3)],
    };
  },
  complete: (ctx, out) => ctx.orch.applyScan(ctx, out),
};

// ---------------------------------------------------------------- Screening (Vorfilter)

const CRITERIA_HINT =
  'Kriterien je 0–10, 10 ist immer am besten – auch bei Aufwand, Konkurrenz und Risiko (10 = kaum Aufwand, gut positionierbar, ' +
  'kaum Risiko). Sei nüchtern: Die meisten Ideen sind mittelmäßig.';

const ScreeningOutput = z.object({
  results: z.array(
    z.object({
      id: z.string().describe('Opportunity-ID, z. B. OPP-0001'),
      decision: z.enum(['PASS', 'REJECT']).describe('PASS = lohnt eine Tiefenrecherche'),
      criteria: criteriaNumbers().describe('vorläufige Bewertung der 13 Kriterien'),
      legal_flag: z
        .enum(['ok', 'check', 'red'])
        .describe('ok = keine erkennbaren rechtlichen Hürden, check = rechtliche Schritte nötig, red = offensichtlich unzulässig oder sehr riskant'),
      legal_note: z.string().describe('kurze Begründung bei check/red, sonst leer'),
      reason: z.string().describe('Begründung, max. 50 Wörter'),
    }),
  ),
});

export const screening: JobTypeDef<z.infer<typeof ScreeningOutput>> = {
  key: 'screening',
  label: 'Screening',
  description: 'Schnelle Vorbewertung neuer Kandidaten nach den 13 Kriterien, inkl. rechtlicher K.-o.-Punkte (Vorfilter vor der Tiefenrecherche).',
  departmentHint: 'Research / R&D',
  defaultAgent: 'OPPORTUNITY_SCOUT',
  tools: [],
  manual: false,
  inputFields: [],
  output: ScreeningOutput,
  title: (input) => `Screening von ${Array.isArray(input.opportunity_ids) ? input.opportunity_ids.length : 0} Kandidat(en)`,
  buildPrompt: ({ orch, job }) => {
    const ids = (Array.isArray(job.input.opportunity_ids) ? job.input.opportunity_ids : []) as string[];
    const opps = ids.map((id) => orch.store.opportunities.get(id)).filter((o): o is NonNullable<typeof o> => !!o);
    return {
      task: [
        'Bewerte die folgenden Kandidaten im Schnellverfahren gegen die Unternehmensstrategie.',
        'Entscheide je Kandidat PASS (lohnt eine gründliche Recherche) oder REJECT (passt nicht, zu riskant, zu schwach).',
        `Vergib vorläufige Werte für alle 13 Kriterien. ${CRITERIA_HINT}`,
        'Markiere offensichtliche rechtliche K.-o.-Punkte (z. B. fremde Marken oder Assets, verbotene Automatisierung, regulierte Beratung) mit legal_flag.',
        `Gib für jeden der ${opps.length} Kandidaten genau ein Ergebnis mit seiner ID zurück.`,
      ].join('\n'),
      sections: [
        strategySection(orch, 9),
        { title: 'Kandidaten', body: opps.map((o) => opportunityJson(o)).join('\n\n'), priority: 10, maxChars: 20000 },
      ],
    };
  },
  complete: (ctx, out) => ctx.orch.applyScreening(ctx, out),
  failed: (ctx, reason) => ctx.orch.onScreeningFailed(ctx, reason),
};

// ---------------------------------------------------------------- Deep Research (Analyst)

const LegalSchema = z.object({
  status: z.enum(['green', 'yellow', 'red']).describe('green = keine besonderen Schritte, yellow = machbar mit Schritten, red = nicht oder nur mit hohem Risiko'),
  how_possible: z.string().describe('ob und wie das Vorhaben rechtlich und nach den Plattformregeln umsetzbar ist, max. 100 Wörter'),
  effort_one_time_hours: z.number().describe('einmaliger Aufwand des Owners in Stunden'),
  effort_one_time_eur: z.number().describe('einmalige Kosten in €'),
  effort_ongoing_hours_month: z.number().describe('laufender Aufwand in Stunden pro Monat'),
  effort_ongoing_eur_month: z.number().describe('laufende Kosten in € pro Monat'),
  steps: z.array(z.object({ step: z.string(), details: z.string() })).describe('nötige Schritte in sinnvoller Reihenfolge'),
  open_questions: z.array(z.string()).describe('Punkte, die der Owner oder eine Fachperson klären sollte'),
});

const ResearchOutput = z.object({
  report_markdown: z.string().describe('Recherchebericht in Markdown, max. 1200 Wörter, mit Quellenverweisen'),
  problem: z.string().describe('präzisierte Problembeschreibung'),
  target_customer: z.string(),
  proposed_solution: z.string(),
  competition_summary: z.string().describe('wichtigste Wettbewerber/Alternativen und Lücke, max. 120 Wörter'),
  revenue_model: z.string(),
  market_notes: z.string().describe('Marktgröße/Nachfrage-Indikatoren mit Einordnung, max. 100 Wörter'),
  key_risks: z.array(z.string()).describe('wichtigste Risiken'),
  legal: LegalSchema.describe('rechtliche und Plattform-Prüfung'),
  sources: z.array(SourceSchema),
});

export const LEGAL_CHECKLIST = [
  'Gewerbe und Steuern (z. B. Gewerbeanmeldung, Kleinunternehmerregelung, Umsatzsteuer bei digitalen Leistungen an Privatkunden in der EU)',
  'Impressum, Datenschutzerklärung, AGB, Widerrufsbelehrung (Besonderheiten bei digitalen Inhalten)',
  'Marken-, Urheber- und Lizenzrechte: keine fremden Marken, Figuren oder Assets; Lizenzen von Schriften, Bildern und Bibliotheken; ' +
    'KI-erzeugte Inhalte sind oft nicht sicher geschützt – keine exklusiven Rechte zusichern',
  'Plattform-AGB und Richtlinien (KI-Inhalte, Automatisierung/Bots, Mehrfachkonten) sowie Monetarisierungsregeln von Spieleherstellern und Mod-Plattformen (z. B. FiveM)',
  'bei physischen Produkten (Print-on-Demand): Pflichten als Verkäufer wie Produktsicherheit und Verpackungsregistrierung',
  'Datenschutz bei Kundendaten; KI-gestützte Kommunikation und KI-Support für Kunden erkennbar machen',
];

export const deepResearch: JobTypeDef<z.infer<typeof ResearchOutput>> = {
  key: 'deep_research',
  label: 'Deep Research',
  description: 'Gründliche, quellenbasierte Prüfung einer vorgefilterten Opportunity inklusive rechtlicher und Plattform-Prüfung.',
  departmentHint: 'Research / R&D',
  defaultAgent: 'RESEARCH_ANALYST',
  tools: ['web_search', 'web_fetch'],
  requiresOpportunity: true,
  manual: true,
  inputFields: [{ key: 'focus', label: 'Zusätzliche Fragen (optional)', type: 'textarea' }],
  output: ResearchOutput,
  title: (_input, ctx) => `Deep Research: ${ctx.opportunityTitle ?? ''}`.trim(),
  buildPrompt: ({ orch, opportunity, job }) => {
    const o = opportunity!;
    const focus = String(job.input.focus ?? '').trim();
    return {
      task: [
        `Recherchiere die Opportunity ${o.id} gründlich: Problemvalidierung, Zielkunden und Zahlungsbereitschaft,`,
        'Wettbewerb und Alternativen, Marktgröße/Nachfrage-Indikatoren, mögliche Umsatzmodelle, technische Machbarkeit und Risiken.',
        'Arbeite quellenbasiert und kennzeichne Annahmen. Verdichte die Ergebnisse – der Bericht ersetzt das Rechercheprotokoll.',
        '',
        'Pflichtteil Rechtliche und Plattform-Prüfung (Feld "legal"): Kläre, ob und wie das Vorhaben möglich ist, wie viel Aufwand es',
        'einmalig und laufend verursacht (Stunden und €) und welche Schritte vorher nötig sind – in sinnvoller Reihenfolge. Prüfe insbesondere:',
        ...LEGAL_CHECKLIST.map((c) => `- ${c}`),
        'Das ist keine Rechtsberatung: Unsicherheiten gehören in open_questions.',
        focus ? `\nZusätzliche Fragen des Owners: ${focus}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      sections: [opportunitySection(o, 10), artifactSection(orch, o.id, 'screening_note', 'Screening-Ergebnis', 7, 1500), strategySection(orch, 8)],
    };
  },
  complete: (ctx, out) => ctx.orch.applyResearch(ctx, out),
};

// ---------------------------------------------------------------- Bewertung (Evaluation)

const EvaluationOutput = z.object({
  criteria: criteriaWithNotes().describe('Bewertung aller 13 Kriterien'),
  confidence: z.number().describe('0.0–1.0: Sicherheit der Bewertung'),
  recommendation: z.enum(['GO', 'NO_GO']),
  rationale: z.string().describe('Begründung, max. 150 Wörter'),
  test_plan: TestPlanSchema.describe('kleinster sinnvoller Nachfragetest vor dem Bau'),
  mvp_outline: z.string().describe('Skizze eines minimalen MVP für den Fall eines erfolgreichen Tests, max. 150 Wörter'),
  estimated_effort: z.string().describe('grobe Aufwandsschätzung für das MVP'),
});

export const guardrailText = (s: Settings): string =>
  `Leitplanken: Testbudget höchstens ${s.guard_test_budget_eur} € externe Kosten und ${s.guard_test_owner_hours} Std. Owner-Zeit je Test; ` +
  `laufende Fixkosten je Produkt höchstens ${s.guard_fixed_costs_eur_month} €/Monat, solange nicht durch Erträge gedeckt; ` +
  `höchstens ${s.guard_max_parallel} Tests/Projekte gleichzeitig; Owner-Zeit insgesamt höchstens ${s.guard_owner_hours_week} Std./Woche.`;

export const evaluation: JobTypeDef<z.infer<typeof EvaluationOutput>> = {
  key: 'evaluation',
  label: 'Bewertung',
  description: 'Bewertet eine recherchierte Opportunity nach den 13 Kriterien (mit K.-o.-Logik) und plant den kleinsten Nachfragetest.',
  departmentHint: 'Research / R&D',
  defaultAgent: 'RESEARCH_ANALYST',
  tools: [],
  requiresOpportunity: true,
  manual: true,
  inputFields: [],
  output: EvaluationOutput,
  title: (_input, ctx) => `Bewertung: ${ctx.opportunityTitle ?? ''}`.trim(),
  buildPrompt: ({ orch, opportunity, settings }) => {
    const o = opportunity!;
    return {
      task: [
        `Bewerte die Opportunity ${o.id} auf Basis des Rechercheberichts als Entscheidungsvorlage für den Owner.`,
        `Bewerte alle 13 Kriterien mit kurzer Begründung. ${CRITERIA_HINT}`,
        'Der Gesamt-Score wird multiplikativ berechnet: Ein sehr schwacher Wert zieht ihn stark nach unten. K.-o.-Kriterien sind',
        `fehlende Nachfrage (unter ${settings.ko_min_demand}/10), eine rote Rechtsprüfung und ein Test außerhalb der Leitplanken.`,
        'Plane den kleinsten sinnvollen Nachfragetest vor dem Bau (Listing, Landingpage, Vorverkauf, Community-Beitrag …) mit messbarem',
        `Erfolgskriterium. Bevorzuge Tests für nahezu 0 €. ${guardrailText(settings)}`,
        'Was Davenet nicht selbst kann (Accounts, Veröffentlichung, Zahlungen), gehört in owner_steps und zählt auf die Owner-Zeit.',
        'confidence 0–1 = wie belastbar die Datenlage ist. Empfiehl GO nur, wenn der Test realistisch Nachfrage belegen kann.',
      ].join('\n'),
      sections: [
        opportunitySection(o, 10),
        artifactSection(orch, o.id, 'research_report', 'Recherchebericht', 9, 9000),
        strategySection(orch, 8),
      ],
    };
  },
  complete: (ctx, out) => ctx.orch.applyEvaluation(ctx, out),
};

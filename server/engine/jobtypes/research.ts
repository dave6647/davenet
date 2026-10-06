import { z } from 'zod';
import type { JobTypeDef } from './types.ts';
import { artifactSection, knowledgeSection, knownOpportunitiesSection, opportunityJson, opportunitySection, strategySection } from './common.ts';

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

const ScreeningOutput = z.object({
  results: z.array(
    z.object({
      id: z.string().describe('Opportunity-ID, z. B. OPP-0001'),
      decision: z.enum(['PASS', 'REJECT']).describe('PASS = lohnt eine Tiefenrecherche'),
      market_score: z.number().describe('0–10: Attraktivität von Markt und Nachfrage'),
      technical_score: z.number().describe('0–10: Umsetzbarkeit mit kleinen Ressourcen'),
      risk_score: z.number().describe('0–10: Risiko (10 = sehr riskant)'),
      reason: z.string().describe('Begründung, max. 50 Wörter'),
    }),
  ),
});

export const screening: JobTypeDef<z.infer<typeof ScreeningOutput>> = {
  key: 'screening',
  label: 'Screening',
  description: 'Schnelle Vorbewertung neuer Kandidaten gegen die Strategie (Vorfilter vor der Tiefenrecherche).',
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
        'Vergib vorläufige Scores von 0 bis 10 (risk_score: 10 = sehr riskant). Sei nüchtern – die meisten Ideen sind mittelmäßig.',
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

const ResearchOutput = z.object({
  report_markdown: z.string().describe('Recherchebericht in Markdown, max. 1200 Wörter, mit Quellenverweisen'),
  problem: z.string().describe('präzisierte Problembeschreibung'),
  target_customer: z.string(),
  proposed_solution: z.string(),
  competition_summary: z.string().describe('wichtigste Wettbewerber/Alternativen und Lücke, max. 120 Wörter'),
  revenue_model: z.string(),
  market_notes: z.string().describe('Marktgröße/Nachfrage-Indikatoren mit Einordnung, max. 100 Wörter'),
  key_risks: z.array(z.string()).describe('wichtigste Risiken'),
  sources: z.array(SourceSchema),
});

export const deepResearch: JobTypeDef<z.infer<typeof ResearchOutput>> = {
  key: 'deep_research',
  label: 'Deep Research',
  description: 'Gründliche, quellenbasierte Prüfung einer vorgefilterten Opportunity.',
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
        focus ? `Zusätzliche Fragen des Owners: ${focus}` : '',
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
  market_score: z.number().describe('0–10'),
  technical_score: z.number().describe('0–10'),
  risk_score: z.number().describe('0–10 (10 = sehr riskant)'),
  confidence: z.number().describe('0.0–1.0: Sicherheit der Bewertung'),
  recommendation: z.enum(['GO', 'NO_GO']),
  rationale: z.string().describe('Begründung, max. 150 Wörter'),
  mvp_outline: z.string().describe('Skizze eines minimalen MVP, max. 150 Wörter'),
  estimated_effort: z.string().describe('grobe Aufwandsschätzung für das MVP'),
});

export const evaluation: JobTypeDef<z.infer<typeof EvaluationOutput>> = {
  key: 'evaluation',
  label: 'Bewertung',
  description: 'Bewertet eine recherchierte Opportunity (Scores, Empfehlung) als Grundlage für die Owner-Freigabe.',
  departmentHint: 'Research / R&D',
  defaultAgent: 'RESEARCH_ANALYST',
  tools: [],
  requiresOpportunity: true,
  manual: true,
  inputFields: [],
  output: EvaluationOutput,
  title: (_input, ctx) => `Bewertung: ${ctx.opportunityTitle ?? ''}`.trim(),
  buildPrompt: ({ orch, opportunity }) => {
    const o = opportunity!;
    return {
      task: [
        `Bewerte die Opportunity ${o.id} auf Basis des Rechercheberichts als Entscheidungsvorlage für den Owner.`,
        'Scores 0–10: market_score (Markt/Nachfrage/Zahlungsbereitschaft), technical_score (Umsetzbarkeit mit kleinen Ressourcen),',
        'risk_score (rechtliche, wirtschaftliche, technische Risiken; 10 = sehr riskant). confidence 0–1 = wie belastbar die Datenlage ist.',
        'Empfiehl GO nur, wenn ein kleines MVP realistisch zu erstem Umsatz oder klarer Validierung führen kann.',
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

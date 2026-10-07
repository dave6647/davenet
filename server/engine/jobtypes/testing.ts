import { z } from 'zod';
import { FINANCE_KIND_LABELS } from '../../../shared/domain.ts';
import type { JobContext, JobTypeDef } from './types.ts';
import { artifactSection, opportunitySection, strategySection } from './common.ts';
import { guardrailText } from './research.ts';
import { imageRequestsField, TestPlanSchema } from './schemas.ts';

/** Nachfragetest vor dem Bau (Strategie §8): vorbereiten, durchführen (Owner), auswerten. */

function planText(ctx: JobContext): string {
  const t = ctx.opportunity?.test;
  if (!t) return '(kein Testplan)';
  const p = t.plan;
  return [
    `Versuch ${t.attempt} – Status ${t.status}`,
    `Hypothese: ${p.hypothesis}`,
    `Kanal: ${p.channel}`,
    `Budget: ${p.budget_eur} € extern, ${p.owner_hours} Std. Owner-Zeit, Laufzeit ${p.duration_days} Tage`,
    `Messgröße: ${p.metric}`,
    `Erfolgskriterium: ${p.success_criterion}`,
    `Schritte des Owners:\n${p.owner_steps.map((s) => `- ${s}`).join('\n') || '- keine'}`,
    `Von Davenet vorzubereiten:\n${p.materials.map((s) => `- ${s}`).join('\n') || '- nichts'}`,
    t.started_at ? `Gestartet: ${t.started_at.slice(0, 10)}${t.ends_at ? `, geplantes Ende ${t.ends_at.slice(0, 10)}` : ''}` : 'Noch nicht gestartet',
  ].join('\n');
}

// ---------------------------------------------------------------- Testpaket vorbereiten

const PreparationOutput = z.object({
  summary: z.string().describe('was vorbereitet wurde, max. 120 Wörter'),
  files: z.array(z.string()).describe('angelegte Dateien (relativ zum Workspace)'),
  owner_checklist: z
    .array(z.object({ step: z.string().describe('konkreter Schritt für den Owner'), minutes: z.number().describe('geschätzte Minuten') }))
    .describe('Schritte, die nur der Owner erledigen kann (Account, Veröffentlichung, Zahlung …), in Reihenfolge'),
  measurement: z.string().describe('wie das Ergebnis gemessen und erfasst wird, max. 60 Wörter'),
  image_requests: imageRequestsField(),
});

export const testPreparation: JobTypeDef<z.infer<typeof PreparationOutput>> = {
  key: 'test_preparation',
  label: 'Nachfragetest vorbereiten',
  description: 'Erstellt nach der Freigabe alle Materialien des Nachfragetests im Workspace (Texte, Landingpage, Designs) und eine Checkliste für den Owner.',
  departmentHint: 'Development',
  defaultAgent: 'IMPLEMENTATION',
  tools: ['workspace_read', 'workspace_write'],
  requiresOpportunity: true,
  manual: true,
  inputFields: [{ key: 'notes', label: 'Vorgaben des Owners (optional)', type: 'textarea' }],
  workspace: 'write',
  output: PreparationOutput,
  title: (_input, ctx) => `Testpaket: ${ctx.opportunityTitle ?? ''}`.trim(),
  buildPrompt: (ctx) => {
    const o = ctx.opportunity!;
    const notes = String(ctx.job.input.notes ?? '').trim();
    return {
      task: [
        `Der Owner hat den Nachfragetest für ${o.id} freigegeben. Bereite alle Materialien vor, die Davenet selbst erstellen kann,`,
        'als Dateien im Projekt-Workspace unter test/ – z. B. Listing- und Angebotstexte in der Sprache des Zielmarkts, eine Landingpage',
        '(HTML/CSS), FAQ, Vektor-Designs als SVG. Keine Veröffentlichung, keine Accounts, keine Zahlungen: Diese Schritte gehören',
        'mit Zeitschätzung in owner_checklist. Die Summe der Minuten muss in die geplante Owner-Zeit passen.',
        'Rasterbilder (Fotos, Illustrationen) nur über image_requests anfordern – höchstens 4.',
        guardrailText(ctx.settings),
        notes ? `Vorgaben des Owners: ${notes}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      sections: [
        { title: 'Testplan', body: planText(ctx), priority: 10 },
        opportunitySection(o, 9),
        artifactSection(ctx.orch, o.id, 'evaluation', 'Bewertung', 6, 3000),
        strategySection(ctx.orch, 7),
      ],
    };
  },
  complete: (ctx, out, info) => ctx.orch.applyTestPreparation(ctx, out, info),
  failed: (ctx, reason) => ctx.orch.onTestPreparationFailed(ctx, reason),
};

// ---------------------------------------------------------------- Test auswerten

const EvaluationOutput = z.object({
  verdict: z.enum(['BUILD', 'ADJUST', 'STOP']).describe('BUILD = Nachfrage belegt, bauen; ADJUST = einmal angepasst erneut testen; STOP = beenden'),
  success_criterion_met: z.boolean(),
  summary: z.string().describe('Ergebnis in 2–3 Sätzen mit Zahlen'),
  reasoning: z.string().describe('Begründung inkl. Aufwand und Kosten im Verhältnis zum Ertrag, max. 120 Wörter'),
  adjusted_plan: TestPlanSchema.optional().describe('nur bei ADJUST: angepasster Testplan'),
  next_steps: z.array(z.string()).describe('konkrete nächste Schritte'),
});

function testFacts(ctx: JobContext): string {
  const o = ctx.opportunity!;
  const t = o.test;
  const since = t?.started_at?.slice(0, 10);
  const totals = ctx.orch.store.finance.totals({ opportunity_id: o.id, from: since });
  const entries = ctx.orch.store.finance.list({ opportunity_id: o.id, from: since, limit: 40 });
  const days = t?.started_at ? Math.max(0, Math.round((Date.now() - new Date(t.started_at).getTime()) / 86400_000)) : null;
  return [
    planText(ctx),
    '',
    `Laufzeit bisher: ${days ?? '?'} Tage`,
    `Ergebnis laut Owner: ${t?.result?.notes ?? '(keine Angabe)'}`,
    `Erfasst seit Teststart: Einnahmen ${totals.revenue_eur.toFixed(2)} €, Ausgaben ${totals.expense_eur.toFixed(2)} €, Owner-Zeit ${totals.hours} Std.`,
    ...entries.map((e) => `- ${e.date} ${FINANCE_KIND_LABELS[e.kind]}: ${e.kind === 'time' ? `${e.hours} Std.` : `${e.amount_eur} €`}${e.note ? ` – ${e.note}` : ''}`),
  ].join('\n');
}

export const testEvaluation: JobTypeDef<z.infer<typeof EvaluationOutput>> = {
  key: 'test_evaluation',
  label: 'Nachfragetest auswerten',
  description: 'Vergleicht das Testergebnis mit dem Erfolgskriterium und empfiehlt bauen, anpassen oder beenden.',
  departmentHint: 'Research / R&D',
  defaultAgent: 'RESEARCH_ANALYST',
  tools: [],
  requiresOpportunity: true,
  manual: true,
  inputFields: [],
  output: EvaluationOutput,
  title: (_input, ctx) => `Testauswertung: ${ctx.opportunityTitle ?? ''}`.trim(),
  buildPrompt: (ctx) => ({
    task: [
      `Werte den Nachfragetest von ${ctx.opportunity!.id} aus. Vergleiche das Ergebnis mit dem vorab festgelegten Erfolgskriterium.`,
      'BUILD nur, wenn Nachfrage belegt ist. ADJUST, wenn ein klar benennbarer Fehler im Test lag und ein angepasster Test',
      `realistisch Erfolg verspricht – höchstens ein Wiederholungstest (aktuell Versuch ${ctx.opportunity!.test?.attempt ?? 1}). STOP, wenn Aufwand`,
      'oder Kosten den Ertrag stark übersteigen und keine realistische Besserung absehbar ist. Rechne nur mit den gelieferten Zahlen.',
      guardrailText(ctx.settings),
    ].join('\n'),
    sections: [
      { title: 'Test und Ergebnis', body: testFacts(ctx), priority: 10, maxChars: 8000 },
      opportunitySection(ctx.opportunity!, 8),
      artifactSection(ctx.orch, ctx.opportunity!.id, 'test_kit', 'Testpaket', 5, 2500),
      strategySection(ctx.orch, 6),
    ],
  }),
  complete: (ctx, out) => ctx.orch.applyTestEvaluation(ctx, out),
  failed: (ctx, reason) => ctx.orch.onTestEvaluationFailed(ctx, reason),
};

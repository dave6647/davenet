import { z } from 'zod';
import { APPROVAL_TYPE_LABELS, JOB_STATUS_LABELS, OPPORTUNITY_STATUS_LABELS } from '../../../shared/domain.ts';
import type { Orchestrator } from '../orchestrator.ts';
import type { JobTypeDef } from './types.ts';
import { knownOpportunitiesSection, strategySection } from './common.ts';

function companySnapshot(orch: Orchestrator): string {
  const lines: string[] = [];
  const oppCounts = orch.store.opportunities.countByStatus();
  lines.push(
    '### Pipeline',
    Object.entries(oppCounts)
      .map(([s, n]) => `- ${OPPORTUNITY_STATUS_LABELS[s as keyof typeof OPPORTUNITY_STATUS_LABELS] ?? s}: ${n}`)
      .join('\n') || '(leer)',
  );
  const top = orch.store.opportunities
    .list()
    .filter((o) => o.score != null && !['REJECTED', 'DEPLOYED'].includes(o.status))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 8);
  lines.push('### Beste offene Opportunities', top.map((o) => `- ${o.id} ${o.title} – Score ${o.score} [${o.status}]`).join('\n') || '(keine)');
  const pending = orch.store.approvals.list({ status: 'PENDING' });
  lines.push('### Offene Freigaben', pending.map((a) => `- #${a.id} ${APPROVAL_TYPE_LABELS[a.type]}: ${a.title}`).join('\n') || '(keine)');
  const jobCounts = orch.store.jobs.countByStatus();
  lines.push(
    '### Jobs',
    Object.entries(jobCounts)
      .map(([s, n]) => `- ${JOB_STATUS_LABELS[s as keyof typeof JOB_STATUS_LABELS] ?? s}: ${n}`)
      .join('\n') || '(keine)',
  );
  const budget = orch.systemBudget();
  lines.push('### Budget', `Ausgaben Monat: $${budget.spent.toFixed(2)}${budget.limit != null ? ` von $${budget.limit}` : ''}`);
  lines.push(
    '### Provider',
    orch
      .providerViews()
      .filter((p) => p.enabled)
      .map((p) => `- ${p.name}: ${p.quota.exhausted ? `erschöpft bis ${p.quota.exhausted_until ?? '?'}` : 'verfügbar'}`)
      .join('\n') || '(keine aktiven)',
  );
  const recent = orch.store.artifacts.list({ limit: 10 });
  lines.push('### Neueste Ergebnisse', recent.map((a) => `- ${a.created_at.slice(0, 10)} ${a.title}${a.summary ? `: ${a.summary.slice(0, 160)}` : ''}`).join('\n') || '(keine)');
  return lines.join('\n');
}

const BriefingOutput = z.object({
  briefing_markdown: z.string().describe('Executive Briefing für den Owner in Markdown, max. 400 Wörter'),
  priorities: z.array(z.string()).describe('die wichtigsten Prioritäten der nächsten Woche'),
  suggested_directives: z.array(z.string()).describe('vorgeschlagene Aufträge, die der Owner erteilen könnte'),
});

export const executiveBriefing: JobTypeDef<z.infer<typeof BriefingOutput>> = {
  key: 'executive_briefing',
  label: 'Executive Briefing',
  description: 'Lagebericht der Leitung: Pipeline, Freigaben, Budget, Prioritäten.',
  departmentHint: 'Unternehmensleitung',
  defaultAgent: 'EXECUTIVE_ORCHESTRATOR',
  tools: [],
  manual: true,
  inputFields: [],
  output: BriefingOutput,
  title: () => `Executive Briefing ${new Date().toISOString().slice(0, 10)}`,
  buildPrompt: ({ orch }) => ({
    task: [
      'Erstelle ein kurzes, entscheidungsorientiertes Lagebild für den Owner: Was ist der Stand, was braucht eine Entscheidung,',
      'wo gibt es Engpässe (Kontingente, Budget, Fehler), was sind die Prioritäten der nächsten Woche?',
    ].join('\n'),
    sections: [{ title: 'Unternehmenslage', body: companySnapshot(orch), priority: 10, maxChars: 12000 }, strategySection(orch, 7)],
  }),
  complete: (ctx, out) => ctx.orch.saveReport(ctx, 'decisions', 'briefing', `Executive Briefing ${new Date().toISOString().slice(0, 10)}`, out),
};

const DirectiveOutput = z.object({
  understanding: z.string().describe('wie der Auftrag verstanden wurde, max. 80 Wörter'),
  actions: z
    .array(
      z.object({
        type: z.enum(['opportunity_scan', 'deep_research', 'custom']).describe('Art des Folge-Jobs'),
        agent_id: z.string().optional().describe('bei custom: ID des zuständigen Agents'),
        opportunity_id: z.string().optional().describe('bei deep_research: Opportunity-ID'),
        instructions: z.string().describe('konkreter Arbeitsauftrag'),
        priority: z.enum(['low', 'normal', 'high']),
      }),
    )
    .describe('höchstens 5 Folge-Jobs'),
  notes: z.string().describe('Hinweise an den Owner, z. B. was eine Freigabe braucht'),
});

export const ownerDirective: JobTypeDef<z.infer<typeof DirectiveOutput>> = {
  key: 'owner_directive',
  label: 'Owner-Auftrag',
  description: 'Die Leitung übersetzt einen frei formulierten Auftrag des Owners in konkrete Jobs für die Abteilungen.',
  departmentHint: 'Unternehmensleitung',
  defaultAgent: 'EXECUTIVE_ORCHESTRATOR',
  tools: [],
  manual: true,
  inputFields: [{ key: 'directive', label: 'Auftrag', type: 'textarea', required: true }],
  output: DirectiveOutput,
  title: (input) => `Owner-Auftrag: ${String(input.directive ?? '').slice(0, 70)}`,
  buildPrompt: ({ orch, job }) => {
    const agents = orch.store.agents
      .list()
      .filter((a) => a.enabled)
      .map((a) => `- ${a.id} (${a.name}): ${a.description}`)
      .join('\n');
    return {
      task: [
        'Übersetze den folgenden Auftrag des Owners in höchstens 5 konkrete, klar begrenzte Folge-Jobs.',
        'Erlaubte Job-Arten: opportunity_scan (neue Kandidaten suchen; instructions = Fokus), deep_research (bestehende Opportunity',
        'gründlich prüfen; opportunity_id angeben), custom (freier Arbeitsauftrag an einen Agent; agent_id angeben).',
        'Alles ab Freigabe-Level 2 (Projektstart, Veröffentlichung, Zahlungen, Verträge) gehört in "notes" an den Owner, nicht in actions.',
        '',
        `Auftrag des Owners:\n"""\n${String(job.input.directive ?? '').trim()}\n"""`,
      ].join('\n'),
      sections: [
        { title: 'Verfügbare Agents', body: agents, priority: 10 },
        knownOpportunitiesSection(orch, 7),
        strategySection(orch, 8),
      ],
    };
  },
  complete: (ctx, out) => ctx.orch.applyDirective(ctx, out),
};

// ---------------------------------------------------------------- Freier Auftrag an einen Agent

const CustomOutput = z.object({
  summary: z.string().describe('Kernaussage in max. 60 Wörtern'),
  result_markdown: z.string().describe('Ergebnis in Markdown, max. 1200 Wörter'),
});

export const customJob: JobTypeDef<z.infer<typeof CustomOutput>> = {
  key: 'custom',
  label: 'Freier Auftrag',
  description: 'Freier Arbeitsauftrag an einen beliebigen Agent (Ergebnis landet im Unternehmensgedächtnis).',
  departmentHint: 'beliebig',
  defaultAgent: 'EXECUTIVE_ORCHESTRATOR',
  tools: ['web_search', 'web_fetch', 'workspace_read', 'workspace_write'],
  manual: true,
  inputFields: [{ key: 'instructions', label: 'Arbeitsauftrag', type: 'textarea', required: true }],
  // Workspace nur, wenn eine Opportunity angegeben ist und der Agent Workspace-Werkzeuge besitzt
  workspace: 'write',
  output: CustomOutput,
  title: (input) => `Auftrag: ${String(input.instructions ?? '').slice(0, 70)}`,
  buildPrompt: ({ orch, job, opportunity }) => ({
    task: String(job.input.instructions ?? '').trim() || 'Kein Auftragstext angegeben.',
    sections: [
      ...(opportunity
        ? [
            { title: `Opportunity ${opportunity.id}`, body: JSON.stringify({ id: opportunity.id, title: opportunity.title, status: opportunity.status, problem: opportunity.problem }, null, 1), priority: 9 },
          ]
        : []),
      strategySection(orch, 6),
    ],
  }),
  complete: (ctx, out) =>
    ctx.orch.saveReport(ctx, ctx.opportunity ? 'research' : 'knowledge', 'custom_result', `Ergebnis: ${ctx.job.title.replace(/^Auftrag: /, '')}`, out),
};

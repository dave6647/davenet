import { z } from 'zod';
import { TASK_STATUS_LABELS } from '../../../shared/domain.ts';
import { Workspace } from '../workspace.ts';
import type { JobContext, JobTypeDef } from './types.ts';
import { artifactSection, opportunitySection, strategySection } from './common.ts';
import { imageRequestsField } from './schemas.ts';

// ---------------------------------------------------------------- Technische Planung

const PlanningOutput = z.object({
  spec_markdown: z.string().describe('MVP-Spezifikation in Markdown (Ziel, Umfang, Nicht-Ziele, Architektur, Datenmodell), max. 1200 Wörter'),
  tech_stack: z.string().describe('gewählte Technologien, kurz begründet'),
  tasks: z
    .array(
      z.object({
        key: z.string().describe('T1, T2, …'),
        title: z.string(),
        description: z.string().describe('was genau umzusetzen ist, max. 120 Wörter'),
        acceptance_criteria: z.array(z.string()).describe('überprüfbare Kriterien'),
        depends_on: z.array(z.string()).describe('keys der Voraussetzungen, z. B. ["T1"]'),
      }),
    )
    .describe('kleine, einzeln umsetzbare und prüfbare Tasks'),
});

export const technicalPlanning: JobTypeDef<z.infer<typeof PlanningOutput>> = {
  key: 'technical_planning',
  label: 'Technische Planung',
  description: 'Erstellt nach Owner-Freigabe die MVP-Spezifikation und zerlegt sie in Tasks.',
  departmentHint: 'Development',
  defaultAgent: 'TECHNICAL_PLANNER',
  tools: [],
  requiresOpportunity: true,
  manual: true,
  inputFields: [{ key: 'notes', label: 'Vorgaben des Owners (optional)', type: 'textarea' }],
  output: PlanningOutput,
  title: (_input, ctx) => `MVP-Planung: ${ctx.opportunityTitle ?? ''}`.trim(),
  buildPrompt: ({ orch, opportunity, settings, job }) => {
    const o = opportunity!;
    const notes = String(job.input.notes ?? '').trim();
    return {
      task: [
        `Die Opportunity ${o.id} wurde vom Owner freigegeben. Erstelle eine schlanke MVP-Spezifikation und zerlege die Umsetzung`,
        `in höchstens ${settings.max_tasks_per_project} kleine Tasks. Jede Task muss in einem einzelnen Implementierungs-Job umsetzbar`,
        'und anhand ihrer Akzeptanzkriterien prüfbar sein. Die Umsetzung erfolgt ausschließlich über Dateien in einem Projekt-Workspace',
        '(keine Shell, keine Installation, kein Deployment) – plane entsprechend: Code, Konfiguration, Dokumentation, Tests als Dateien.',
        'Abhängigkeiten über die keys angeben. Bevorzuge einfache, bewährte Technologien.',
        notes ? `Vorgaben des Owners: ${notes}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      sections: [
        opportunitySection(o, 10),
        artifactSection(orch, o.id, 'evaluation', 'Bewertung (inkl. MVP-Skizze)', 9, 4000),
        artifactSection(orch, o.id, 'research_report', 'Recherchebericht (Auszug)', 6, 5000),
        strategySection(orch, 7),
      ],
    };
  },
  complete: (ctx, out) => ctx.orch.applyPlanning(ctx, out),
};

// ---------------------------------------------------------------- Implementierung

const ImplementationOutput = z.object({
  summary: z.string().describe('was umgesetzt wurde, max. 120 Wörter'),
  files_changed: z.array(z.string()).describe('angelegte/geänderte Dateien (relativ zum Workspace)'),
  notes_for_reviewer: z.string().describe('Hinweise für das Review'),
  open_issues: z.array(z.string()).describe('bekannte offene Punkte'),
  image_requests: imageRequestsField(),
});

function workspaceListing(ctx: JobContext): string {
  try {
    return new Workspace(ctx.orch.memory.workspaceDir(ctx.opportunity!.id), false).list('.', 300);
  } catch {
    return '(leer)';
  }
}

function taskDetails(ctx: JobContext): string {
  const t = ctx.task!;
  return [
    `${t.id} – ${t.title}`,
    t.description,
    t.acceptance_criteria.length ? `Akzeptanzkriterien:\n${t.acceptance_criteria.map((c) => `- ${c}`).join('\n')}` : '',
    t.depends_on.length ? `Baut auf: ${t.depends_on.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function otherTasks(ctx: JobContext): string {
  return ctx.orch.store.tasks
    .listForOpportunity(ctx.opportunity!.id)
    .filter((t) => t.id !== ctx.task!.id)
    .map((t) => `- ${t.key}: ${t.title} [${TASK_STATUS_LABELS[t.status]}]`)
    .join('\n');
}

export const implementation: JobTypeDef<z.infer<typeof ImplementationOutput>> = {
  key: 'implementation',
  label: 'Implementierung',
  description: 'Setzt genau eine Task im Projekt-Workspace um (Approval-Level 1: autonom mit Audit-Log).',
  departmentHint: 'Development',
  defaultAgent: 'IMPLEMENTATION',
  tools: ['workspace_read', 'workspace_write'],
  requiresOpportunity: true,
  requiresTask: true,
  manual: true,
  inputFields: [{ key: 'rework_feedback', label: 'Zusätzliche Hinweise (optional)', type: 'textarea' }],
  workspace: 'write',
  output: ImplementationOutput,
  title: (_input, ctx) => `Umsetzung: ${ctx.taskTitle ?? ''}`.trim(),
  buildPrompt: (ctx) => {
    const t = ctx.task!;
    const feedback = String(ctx.job.input.rework_feedback ?? '').trim();
    return {
      task: [
        `Setze die Task ${t.key} der Opportunity ${ctx.opportunity!.id} um. Dein Arbeitsverzeichnis ist der Projekt-Workspace;`,
        'lege Dateien mit relativen Pfaden an. Halte dich an Spezifikation und Akzeptanzkriterien und ändere nur, was für diese Task nötig ist.',
        'Pflege eine knappe README.md im Workspace (Zweck, Aufbau, Start). Keine Zugangsdaten oder Geheimnisse in Dateien.',
        'Es gibt keine Shell: Nichts installieren oder ausführen – schreibe lauffähigen Code und dokumentiere die nötigen Schritte.',
        'Grafiken wie Logos, Icons und Schrift-Designs erstellst du selbst als SVG. Rasterbilder (Fotos, Illustrationen) forderst du',
        'über image_requests an; sie landen später unter assets/ im Workspace.',
        feedback ? 'Dies ist eine Nacharbeit: Behebe die Findings aus dem Review vollständig.' : '',
      ]
        .filter(Boolean)
        .join('\n'),
      sections: [
        { title: 'Task', body: taskDetails(ctx), priority: 10 },
        ...(feedback ? [{ title: 'Review-Feedback / Hinweise', body: feedback, priority: 10 }] : []),
        artifactSection(ctx.orch, ctx.opportunity!.id, 'spec', 'MVP-Spezifikation', 8, 9000),
        { title: 'Aktueller Inhalt des Workspace', body: workspaceListing(ctx), priority: 6, maxChars: 6000 },
        { title: 'Weitere Tasks des Projekts', body: otherTasks(ctx), priority: 3 },
      ],
    };
  },
  complete: (ctx, out, info) => ctx.orch.applyImplementation(ctx, out, info),
  failed: (ctx, reason) => ctx.orch.onTaskJobFailed(ctx, reason),
};

// ---------------------------------------------------------------- Review

const ReviewOutput = z.object({
  verdict: z.enum(['PASS', 'REWORK']),
  summary: z.string().describe('Gesamteinschätzung, max. 100 Wörter'),
  findings: z.array(
    z.object({
      severity: z.enum(['critical', 'major', 'minor']),
      file: z.string().optional(),
      description: z.string().describe('konkret und umsetzbar'),
    }),
  ),
});

export const review: JobTypeDef<z.infer<typeof ReviewOutput>> = {
  key: 'review',
  label: 'Review',
  description: 'Prüft die Umsetzung einer Task unabhängig gegen Spezifikation und Akzeptanzkriterien (PASS/REWORK).',
  departmentHint: 'Development',
  defaultAgent: 'REVIEW',
  tools: ['workspace_read'],
  requiresOpportunity: true,
  requiresTask: true,
  manual: true,
  inputFields: [],
  workspace: 'read',
  output: ReviewOutput,
  title: (_input, ctx) => `Review: ${ctx.taskTitle ?? ''}`.trim(),
  buildPrompt: (ctx) => {
    const t = ctx.task!;
    const impl = ctx.orch.store.artifacts.list({ task_id: t.id, kind: 'implementation_report', limit: 1 })[0];
    return {
      task: [
        `Prüfe die Umsetzung der Task ${t.key} im Projekt-Workspace. Lies die relevanten Dateien selbst.`,
        'Maßstab sind die Akzeptanzkriterien und die Spezifikation: Korrektheit, Vollständigkeit, Sicherheit, Wartbarkeit.',
        'Verlange REWORK nur bei critical/major Findings, die Kriterien verletzen oder echte Fehler sind. Kleinigkeiten als minor melden und PASS geben.',
      ].join('\n'),
      sections: [
        { title: 'Task', body: taskDetails(ctx), priority: 10 },
        { title: 'Bericht der Implementierung', body: impl ? ctx.orch.memory.readArtifact(impl) : '', priority: 9, maxChars: 4000 },
        artifactSection(ctx.orch, ctx.opportunity!.id, 'spec', 'MVP-Spezifikation', 7, 7000),
        { title: 'Inhalt des Workspace', body: workspaceListing(ctx), priority: 6, maxChars: 6000 },
      ],
    };
  },
  complete: (ctx, out) => ctx.orch.applyReview(ctx, out),
  failed: (ctx, reason) => ctx.orch.onTaskJobFailed(ctx, reason),
};

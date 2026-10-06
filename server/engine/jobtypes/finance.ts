import { z } from 'zod';
import { JOB_STATUS_LABELS } from '../../../shared/domain.ts';
import type { Orchestrator } from '../orchestrator.ts';
import { monthStart } from '../quota.ts';
import type { JobTypeDef } from './types.ts';

const usd = (v: number) => `$${v.toFixed(4)}`;

/** Deterministische Kennzahlen aus dem Ledger – das Modell rechnet nicht selbst. */
function ledgerFacts(orch: Orchestrator): string {
  const now = new Date();
  const since = monthStart(now).toISOString();
  const prevSince = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
  const lines: string[] = [];
  const table = (title: string, rows: { key: string | null; requests: number; input_tokens: number; output_tokens: number; monetary_cost_usd: number; equivalent_cost_usd: number }[]) => {
    lines.push(`### ${title}`);
    if (!rows.length) {
      lines.push('(keine Daten)');
      return;
    }
    lines.push('| Schlüssel | Aufrufe | Input-Tokens | Output-Tokens | Kosten (real) | Gegenwert (Listenpreis) |', '|---|---|---|---|---|---|');
    for (const r of rows.slice(0, 25)) {
      lines.push(`| ${r.key ?? '–'} | ${r.requests} | ${r.input_tokens} | ${r.output_tokens} | ${usd(r.monetary_cost_usd)} | ${usd(r.equivalent_cost_usd)} |`);
    }
  };
  const total = orch.store.ledger.totals({ since });
  const prev = orch.store.ledger.totals({ since: prevSince, until: since });
  lines.push(
    `Aktueller Monat: ${total.requests} Aufrufe, ${total.input_tokens + total.output_tokens} Tokens, Kosten ${usd(total.monetary_cost_usd)}, Gegenwert ${usd(total.equivalent_cost_usd)}`,
    `Vormonat: ${prev.requests} Aufrufe, ${prev.input_tokens + prev.output_tokens} Tokens, Kosten ${usd(prev.monetary_cost_usd)}, Gegenwert ${usd(prev.equivalent_cost_usd)}`,
  );
  table('Nach Agent (Monat)', orch.store.ledger.grouped('agent_id', { since }));
  table('Nach Provider (Monat)', orch.store.ledger.grouped('provider_id', { since }));
  table('Nach Job-Typ (Monat)', orch.store.ledger.grouped('job_type', { since }));
  table('Nach Opportunity (Monat)', orch.store.ledger.grouped('opportunity_id', { since }));
  lines.push('### Provider-Kontingente');
  for (const p of orch.providerViews()) {
    const q = p.quota;
    lines.push(
      `- ${p.name} (${p.billing_mode}, ${p.enabled ? 'aktiv' : 'inaktiv'}): genutzt ${q.used}${q.limit != null ? ` von ${q.limit}` : ''} ${q.unit}, ` +
        `Periode ${q.period_key}, ${q.exhausted ? `ERSCHÖPFT bis ${q.exhausted_until ?? 'unbekannt'}` : 'verfügbar'}; ` +
        `Kosten Monat ${usd(q.month_cost_usd)}${p.monthly_cost_limit_usd != null ? ` / Limit $${p.monthly_cost_limit_usd}` : ''}`,
    );
  }
  const budget = orch.systemBudget();
  lines.push(`### Systembudget\nAusgaben ${usd(budget.spent)}${budget.limit != null ? ` von $${budget.limit} (${(budget.pct ?? 0).toFixed(1)} %)` : ' (kein Limit)'}`);
  return lines.join('\n');
}

const CostReportOutput = z.object({
  summary_markdown: z.string().describe('Kostenbericht in Markdown, max. 500 Wörter'),
  findings: z.array(z.string()).describe('Auffälligkeiten/Ausreißer'),
  recommendations: z.array(z.string()).describe('konkrete Steuerungs- und Sparempfehlungen'),
});

export const costReport: JobTypeDef<z.infer<typeof CostReportOutput>> = {
  key: 'cost_report',
  label: 'Kostenbericht',
  description: 'Analysiert Kosten, Tokenverbrauch und Kontingente aus dem Ledger und gibt Empfehlungen.',
  departmentHint: 'Finance / Controlling',
  defaultAgent: 'COST_CONTROLLER',
  tools: [],
  manual: true,
  inputFields: [],
  output: CostReportOutput,
  title: () => `Kostenbericht ${new Date().toISOString().slice(0, 7)}`,
  buildPrompt: ({ orch }) => ({
    task: [
      'Erstelle einen kompakten Kostenbericht für den Owner auf Basis der gelieferten Ledger-Kennzahlen.',
      'Rechne ausschließlich mit den gelieferten Zahlen. "Kosten (real)" sind tatsächliche Ausgaben, "Gegenwert" ist der Listenpreis',
      '(bei Abo-Nutzung entstehen keine Zusatzkosten, der Gegenwert zeigt aber die Auslastung).',
      'Benenne Ausreißer (z. B. teure Agents/Job-Typen, viele Fehlversuche) und gib konkrete Empfehlungen (Capability-Klassen, Limits, Policies).',
    ].join('\n'),
    sections: [{ title: 'Ledger-Kennzahlen', body: ledgerFacts(orch), priority: 10, maxChars: 14000 }],
  }),
  complete: (ctx, out) => ctx.orch.saveReport(ctx, 'finance', 'cost_report', `Kostenbericht ${new Date().toISOString().slice(0, 7)}`, out),
};

const AuditOutput = z.object({
  summary_markdown: z.string().describe('Audit-Bericht in Markdown, max. 500 Wörter'),
  issues: z.array(
    z.object({
      severity: z.enum(['high', 'medium', 'low']),
      description: z.string(),
      reference: z.string().describe('betroffene Einträge, Jobs oder Freigaben'),
    }),
  ),
  recommendations: z.array(z.string()),
});

function auditFacts(orch: Orchestrator): string {
  const since = new Date(Date.now() - 7 * 86400_000).toISOString();
  const entries = orch.store.audit.list({ since, limit: 200 }).items;
  const lines = entries.map(
    (e) => `${e.ts.slice(0, 16)} L${e.level} ${e.actor} ${e.action} ${e.entity_type ?? ''}:${e.entity_id ?? ''} ${JSON.stringify(e.details).slice(0, 160)}`,
  );
  const failed = orch.store.jobs.list({ status: ['FAILED', 'BLOCKED'], limit: 30 }).items.map(
    (j) => `#${j.id} ${j.type} [${JOB_STATUS_LABELS[j.status]}] Versuche ${j.attempts}: ${(j.error ?? j.wait_reason ?? '').slice(0, 160)}`,
  );
  const approvals = orch.store.approvals.list({ limit: 30 }).map(
    (a) => `#${a.id} ${a.type} L${a.level} ${a.status} ${a.title}${a.decision_note ? ` – Notiz: ${a.decision_note.slice(0, 120)}` : ''}`,
  );
  return [
    '### Audit-Log (letzte 7 Tage, neueste zuerst)',
    lines.join('\n') || '(leer)',
    '### Fehlgeschlagene/blockierte Jobs',
    failed.join('\n') || '(keine)',
    '### Freigaben',
    approvals.join('\n') || '(keine)',
  ].join('\n');
}

export const auditReview: JobTypeDef<z.infer<typeof AuditOutput>> = {
  key: 'audit_review',
  label: 'Audit-Prüfung',
  description: 'Prüft Audit-Log, Freigaben und Fehler auf Regelverstöße und Risiken.',
  departmentHint: 'Finance / Controlling',
  defaultAgent: 'AUDITOR',
  tools: [],
  manual: true,
  inputFields: [],
  output: AuditOutput,
  title: () => `Audit-Prüfung ${new Date().toISOString().slice(0, 10)}`,
  buildPrompt: ({ orch }) => ({
    task: [
      'Prüfe die gelieferten Audit-Daten auf Regelverstöße und Risiken: Aktionen ab Level 2 ohne Owner-Freigabe,',
      'ungewöhnliche Kosten oder Wiederholungen, gehäufte Fehler, blockierte Abläufe. Belege jedes Issue mit Referenzen.',
      'Wenn alles unauffällig ist, sage das klar.',
    ].join('\n'),
    sections: [{ title: 'Audit-Daten', body: auditFacts(orch), priority: 10, maxChars: 20000 }],
  }),
  complete: (ctx, out) => ctx.orch.saveReport(ctx, 'audit', 'audit_report', `Audit-Prüfung ${new Date().toISOString().slice(0, 10)}`, out),
};

import { OPPORTUNITY_STATUS_LABELS, type Opportunity } from '../../../shared/domain.ts';
import type { Orchestrator } from '../orchestrator.ts';
import { compactJson, type ContextSection } from '../prompt.ts';

/** Gemeinsame Kontextbausteine für die Job-Typen (Konzept §11: nur relevante Artefakte laden). */

export function strategySection(orch: Orchestrator, priority = 9): ContextSection {
  return { title: 'Unternehmensstrategie (vom Owner gepflegt)', body: orch.memory.strategy() || '(noch keine Strategie hinterlegt)', priority, maxChars: 5000 };
}

export function knowledgeSection(orch: Orchestrator, priority = 3): ContextSection {
  return { title: 'Unternehmenswissen (Auszug)', body: orch.memory.knowledgeDigest(4000), priority, maxChars: 4000 };
}

export function opportunityJson(o: Opportunity): string {
  return compactJson({
    id: o.id,
    title: o.title,
    problem: o.problem,
    target_customer: o.target_customer,
    proposed_solution: o.proposed_solution,
    competition_summary: o.competition_summary,
    revenue_model: o.revenue_model,
    market_score: o.market_score,
    technical_score: o.technical_score,
    risk_score: o.risk_score,
    confidence: o.confidence,
    score: o.score,
    status: o.status,
    notes: o.notes,
    sources: o.sources.slice(0, 8),
  });
}

export function opportunitySection(o: Opportunity, priority = 10): ContextSection {
  return { title: `Opportunity ${o.id}`, body: opportunityJson(o), priority, maxChars: 6000 };
}

/** Letztes Artefakt einer Art zu einer Opportunity als Kontextbaustein. */
export function artifactSection(orch: Orchestrator, oppId: string, kind: string, title: string, priority: number, maxChars?: number): ContextSection {
  const a = orch.store.artifacts.latest(oppId, kind);
  return { title, body: a ? orch.memory.readArtifact(a) : '', priority, maxChars };
}

export function knownOpportunitiesSection(orch: Orchestrator, priority = 6): ContextSection {
  const list = orch.store.opportunities.titles(150);
  const body = list.length
    ? list.map((o) => `- ${o.id}: ${o.title} [${OPPORTUNITY_STATUS_LABELS[o.status as keyof typeof OPPORTUNITY_STATUS_LABELS] ?? o.status}]`).join('\n')
    : '(noch keine)';
  return { title: 'Bereits bekannte Opportunities (keine Duplikate liefern)', body, priority, maxChars: 8000 };
}

export const clamp = (v: unknown, min: number, max: number): number | null => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
};

export const normalizeTitle = (t: string): string =>
  t
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9äöüß]+/g, ' ')
    .trim();

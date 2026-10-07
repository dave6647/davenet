import { CRITERION_KEYS, KO_SCORE_CAP, type CriteriaScores, type CriterionKey, type LegalCheck, type Settings, type TestPlan } from '../../shared/domain.ts';

/**
 * Altes Schema: Gesamt-Score 0–100 aus Markt-, Technik- und Risiko-Score (je 0–10, Risiko invertiert).
 * Gilt nur noch für Opportunities, die vor der Bewertung nach 13 Kriterien entstanden sind.
 */
export function computeScore(settings: Settings, market: number | null, technical: number | null, risk: number | null): number | null {
  if (market == null || technical == null || risk == null) return null;
  const wm = Math.max(0, settings.score_weight_market);
  const wt = Math.max(0, settings.score_weight_technical);
  const wr = Math.max(0, settings.score_weight_risk);
  const sum = wm + wt + wr || 1;
  const value = (wm * market + wt * technical + wr * (10 - risk)) / sum;
  return Math.round(Math.min(10, Math.max(0, value)) * 10);
}

type CriteriaInput = CriteriaScores | Partial<Record<CriterionKey, number>>;

/** Wert eines Kriteriums (0–10) – egal ob nur als Zahl oder mit Begründung geliefert. */
export function criterionValue(c: CriteriaInput | null | undefined, key: CriterionKey): number | null {
  const raw = c?.[key] as number | { score: number } | undefined;
  const v = typeof raw === 'number' ? raw : raw?.score;
  return v == null || !Number.isFinite(Number(v)) ? null : Math.min(10, Math.max(0, Number(v)));
}

/**
 * Gesamt-Score 0–100 aus den 13 Kriterien als gewichtetes geometrisches Mittel.
 * Die Faktoren werden multipliziert (Strategie: "Gewinn × Erfolgswahrscheinlichkeit × …") – ein sehr schwacher
 * Wert lässt sich nicht durch gute Werte an anderer Stelle ausgleichen. Fehlende Kriterien zählen nicht mit.
 */
export function criteriaScore(c: CriteriaInput | null | undefined, weights: Record<CriterionKey, number>): number | null {
  let weightSum = 0;
  let logSum = 0;
  for (const key of CRITERION_KEYS) {
    const v = criterionValue(c, key);
    const w = Math.max(0, Number(weights[key]) || 0);
    if (v == null || !w) continue;
    weightSum += w;
    logSum += w * Math.log(Math.max(0.5, v) / 10); // 0 würde das Produkt auslöschen – K.-o. regelt harte Fälle
  }
  if (!weightSum) return null;
  return Math.round(Math.exp(logSum / weightSum) * 100);
}

/** Verstöße eines Testplans gegen die Leitplanken (Testbudget und Owner-Zeit je Test). */
export function guardrailIssues(plan: Pick<TestPlan, 'budget_eur' | 'owner_hours'> | null | undefined, s: Settings): string[] {
  if (!plan) return [];
  const out: string[] = [];
  const fmt = (v: number) => v.toLocaleString('de-DE', { maximumFractionDigits: 2 });
  if (Number(plan.budget_eur) > s.guard_test_budget_eur) out.push(`Testbudget ${fmt(plan.budget_eur)} € über ${fmt(s.guard_test_budget_eur)} €`);
  if (Number(plan.owner_hours) > s.guard_test_owner_hours) out.push(`Owner-Zeit ${fmt(plan.owner_hours)} Std. über ${fmt(s.guard_test_owner_hours)} Std.`);
  return out;
}

/**
 * K.-o.-Kriterien (Strategie §15): fehlende Nachfrage, rote Rechtsprüfung, Test außerhalb der Leitplanken.
 * Jedes davon deckelt den Score – gute Werte bei anderen Kriterien gleichen das nicht aus.
 */
export function knockouts(c: CriteriaInput | null | undefined, legal: Pick<LegalCheck, 'status'> | null | undefined, plan: TestPlan | null | undefined, s: Settings): string[] {
  const out: string[] = [];
  const demand = criterionValue(c, 'demand');
  if (demand != null && demand < s.ko_min_demand) out.push(`keine ausreichende Nachfrage (${demand}/10)`);
  const legalValue = criterionValue(c, 'legal');
  if (legal?.status === 'red') out.push('Rechtsprüfung rot');
  else if (legalValue != null && legalValue < 2) out.push(`rechtlicher Aufwand/Risiko sehr hoch (${legalValue}/10)`);
  const issues = guardrailIssues(plan, s);
  if (issues.length) out.push(`Test nicht innerhalb der Leitplanken (${issues.join(', ')})`);
  return out;
}

/** Score nach Anwendung der K.-o.-Kriterien. */
export function cappedScore(base: number | null, ko: string[]): number | null {
  if (base == null) return null;
  return ko.length ? Math.min(base, KO_SCORE_CAP) : base;
}

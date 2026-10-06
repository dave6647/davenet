import type { Settings } from '../../shared/domain.ts';

/**
 * Gesamt-Score 0–100 aus Markt-, Technik- und Risiko-Score (je 0–10, Risiko invertiert).
 * Gewichte sind in den Einstellungen änderbar.
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

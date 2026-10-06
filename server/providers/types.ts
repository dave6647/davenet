import type { Effort, Provider, ProviderTypeInfo, ToolKey } from '../../shared/domain.ts';
import type { SecretStore } from '../secrets.ts';

/** JSON-Schema (Teilmenge), wie es aus den Zod-Schemas der Job-Typen erzeugt wird. */
export type JsonSchema = Record<string, unknown>;

export interface CallUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  requests: number;
  toolCalls: number;
  webSearches: number;
  /** Vom Provider gemeldete Kosten zum Listenpreis (z. B. total_cost_usd der CLI); null = selbst berechnen. */
  reportedCostUsd: number | null;
  /** true = es entstehen echte Kosten (API-Key), false = über Abo abgedeckt, null = unbekannt (Provider-Einstellung gilt). */
  billed: boolean | null;
}

export const emptyUsage = (): CallUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  requests: 0,
  toolCalls: 0,
  webSearches: 0,
  reportedCostUsd: null,
  billed: null,
});

export interface ModelCallRequest {
  /** Modellname beim Provider (z. B. claude-sonnet-5-5). */
  model: string;
  system: string;
  prompt: string;
  maxOutputTokens: number;
  /** Effektiv erlaubte Werkzeuge (Agent ∩ Job-Typ). */
  tools: ToolKey[];
  maxToolCalls: number;
  effort?: Effort | null;
  /** Gewünschtes Ausgabeformat; Adapter nutzen native strukturierte Ausgabe, wenn möglich. */
  outputSchema?: JsonSchema;
  /** Projekt-Workspace für Datei-Werkzeuge. */
  workspace?: { dir: string; writable: boolean };
  timeoutMs: number;
  signal: AbortSignal;
  log: (msg: string, level?: 'info' | 'warn' | 'error') => void;
  /** Wird für jeden einzelnen Modellaufruf aufgerufen (Ledger: "Jeder Modellaufruf wird protokolliert"). */
  onUsage: (usage: CallUsage, actualModel: string) => void;
  /** Wird nach jedem Modellaufruf mit der aufgelaufenen Nutzung aufgerufen; wirft, wenn ein Job-Limit überschritten ist. */
  guard?: (total: CallUsage) => void;
}

export interface ModelCallResult {
  text: string;
  structured?: unknown;
  usage: CallUsage;
  model: string;
  stopReason?: string;
}

export type ProviderErrorKind =
  | 'quota' // Kontingent/Plan-Limit erschöpft -> warten bis Reset
  | 'billing' // Guthaben/Billing-Problem -> blockieren
  | 'rate_limit' // kurzfristig gedrosselt -> später erneut
  | 'auth' // nicht angemeldet / ungültiger Key -> blockieren
  | 'config' // falsch konfiguriert / nicht installiert -> blockieren
  | 'transient' // Überlastung, Netzwerk, 5xx -> Retry
  | 'invalid_request' // fehlerhafte Anfrage -> fehlgeschlagen
  | 'refusal' // Modell lehnt ab -> fehlgeschlagen
  | 'limit' // Job-Limit (Kosten/Tool-Calls) überschritten -> fehlgeschlagen
  | 'timeout'
  | 'cancelled'
  | 'unknown';

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryAfterMs: number | null;
  /** Bekannter oder geschätzter Reset-Zeitpunkt (ISO) bei 'quota'. */
  readonly resetAt: string | null;
  readonly resetEstimated: boolean;

  constructor(kind: ProviderErrorKind, message: string, opts: { retryAfterMs?: number | null; resetAt?: string | null; resetEstimated?: boolean } = {}) {
    super(message);
    this.kind = kind;
    this.retryAfterMs = opts.retryAfterMs ?? null;
    this.resetAt = opts.resetAt ?? null;
    this.resetEstimated = opts.resetEstimated ?? false;
  }
}

export interface ProviderAdapter {
  call(req: ModelCallRequest): Promise<ModelCallResult>;
  /** Kostenlose Prüfung (keine Modellnutzung), ob der Provider einsatzbereit ist. */
  healthCheck(): Promise<{ ok: boolean; message: string }>;
}

export interface AdapterContext {
  secrets: SecretStore;
  dataDir: string;
}

export interface ProviderTypeDef {
  info: ProviderTypeInfo;
  create(provider: Provider, ctx: AdapterContext): ProviderAdapter;
}

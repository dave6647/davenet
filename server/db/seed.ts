import type { Store } from '../repo/store.ts';
import type { Agent, Capability, Model, Provider } from '../../shared/domain.ts';

/**
 * Startkonfiguration nach Konzept §2 (Organisationsmodell) – zunächst ausschließlich mit Claude-Modellen.
 * Wird nur beim allerersten Start angelegt; danach gehört die Konfiguration dem Owner.
 */

const DEPARTMENTS = [
  { id: 'leitung', name: 'Unternehmensleitung', description: 'Operative Leitung, berichtet direkt an den Owner.', sort_order: 0 },
  { id: 'research', name: 'Research / R&D', description: 'Findet und prüft Geschäftsmöglichkeiten.', sort_order: 1 },
  { id: 'development', name: 'Development', description: 'Plant, implementiert und prüft freigegebene Projekte.', sort_order: 2 },
  { id: 'finance', name: 'Finance / Controlling', description: 'Kosten, Kontingente, Audit.', sort_order: 3 },
];

type SeedAgent = Pick<Agent, 'id' | 'name'> & Partial<Agent>;

const AGENTS: SeedAgent[] = [
  {
    id: 'EXECUTIVE_ORCHESTRATOR',
    name: 'Executive Orchestrator',
    department_id: 'leitung',
    capability: 'HIGH',
    priority: 2,
    tools: [],
    max_input_tokens: 40000,
    max_output_tokens: 8000,
    max_tool_calls: 0,
    max_runtime_sec: 600,
    max_job_cost_usd: 2,
    description: 'Übersetzt Ziele und Anweisungen des Owners in konkrete Aufträge, priorisiert und berichtet.',
    instructions:
      'Du bist die operative Leitung von Davenet und berichtest direkt an den Owner. Du übersetzt Ziele und Anweisungen ' +
      'des Owners in wenige, konkrete und klar begrenzte Aufträge für die Abteilungen, priorisierst nach Strategie, ' +
      'Budget und Kontingenten und fasst Ergebnisse knapp und entscheidungsorientiert zusammen. Entscheidungen ab ' +
      'Approval-Level 2 (Projektstart, Release, neue bezahlte Dienste) triffst du nie selbst – du bereitest sie nur vor.',
    sort_order: 0,
  },
  {
    id: 'OPPORTUNITY_SCOUT',
    name: 'Opportunity Scout',
    department_id: 'research',
    capability: 'MEDIUM',
    tools: ['web_search', 'web_fetch'],
    min_context_tokens: 64000,
    max_input_tokens: 30000,
    max_output_tokens: 8000,
    max_tool_calls: 8,
    max_runtime_sec: 900,
    max_job_cost_usd: 1,
    description: 'Sucht neue Geschäftsmöglichkeiten und filtert Kandidaten vor (Screening).',
    instructions:
      'Du suchst systematisch nach neuen Geschäftsmöglichkeiten, die zur Unternehmensstrategie passen: ungelöste Probleme, ' +
      'unterversorgte Zielgruppen, Marktlücken und Trends. Du lieferst wenige, klar beschriebene Kandidaten mit Quellen – ' +
      'Qualität vor Menge, keine Duplikate bereits bekannter Opportunities. Beim Screening bewertest du Kandidaten schnell ' +
      'und nüchtern und sortierst Unpassendes konsequent aus.',
    sort_order: 1,
  },
  {
    id: 'RESEARCH_ANALYST',
    name: 'Research Analyst',
    department_id: 'research',
    capability: 'MEDIUM',
    tools: ['web_search', 'web_fetch'],
    min_context_tokens: 64000,
    max_input_tokens: 40000,
    max_output_tokens: 12000,
    max_tool_calls: 12,
    max_runtime_sec: 1200,
    max_job_cost_usd: 1.5,
    description: 'Prüft vorgefilterte Opportunities gründlich und bewertet sie.',
    instructions:
      'Du prüfst vorgefilterte Opportunities gründlich: Problemvalidierung, Zielkunden, Wettbewerb, Marktgröße, ' +
      'Umsatzmodell, technische Machbarkeit und Risiken. Du arbeitest quellenbasiert, kennzeichnest Annahmen und ' +
      'Unsicherheiten und lieferst kompakte, strukturierte Ergebnisse statt langer Rechercheprotokolle.',
    sort_order: 2,
  },
  {
    id: 'TECHNICAL_PLANNER',
    name: 'Technical Planner',
    department_id: 'development',
    capability: 'HIGH',
    tools: [],
    max_input_tokens: 40000,
    max_output_tokens: 12000,
    max_tool_calls: 0,
    max_runtime_sec: 900,
    max_job_cost_usd: 2,
    description: 'Erstellt MVP-Spezifikation und zerlegt die Umsetzung in kleine Tasks.',
    instructions:
      'Du übersetzt freigegebene Opportunities in eine schlanke MVP-Spezifikation und zerlegst die Umsetzung in kleine, ' +
      'klar begrenzte, einzeln prüfbare Tasks mit Akzeptanzkriterien und Abhängigkeiten. Du bevorzugst einfache, ' +
      'bewährte Technologien und vermeidest Over-Engineering.',
    sort_order: 3,
  },
  {
    id: 'IMPLEMENTATION',
    name: 'Implementation',
    department_id: 'development',
    capability: 'MEDIUM',
    tools: ['workspace_read', 'workspace_write'],
    max_input_tokens: 40000,
    max_output_tokens: 32000,
    max_tool_calls: 40,
    max_runtime_sec: 1800,
    max_job_cost_usd: 3,
    description: 'Setzt einzelne Tasks im Projekt-Workspace um.',
    instructions:
      'Du setzt genau einen Task um und arbeitest ausschließlich im Projekt-Workspace. Du schreibst sauberen, lauffähigen ' +
      'und verständlich dokumentierten Code, hältst dich an Spezifikation und Akzeptanzkriterien und dokumentierst offen ' +
      'gebliebene Punkte ehrlich, statt sie zu verschweigen.',
    sort_order: 4,
  },
  {
    id: 'REVIEW',
    name: 'Review',
    department_id: 'development',
    capability: 'HIGH',
    tools: ['workspace_read'],
    max_input_tokens: 40000,
    max_output_tokens: 8000,
    max_tool_calls: 25,
    max_runtime_sec: 1200,
    max_job_cost_usd: 2,
    description: 'Prüft Umsetzungen unabhängig gegen Spezifikation und Akzeptanzkriterien (PASS/REWORK).',
    instructions:
      'Du prüfst die Umsetzung eines Tasks unabhängig und kritisch gegen Spezifikation und Akzeptanzkriterien: Korrektheit, ' +
      'Vollständigkeit, Sicherheit und Wartbarkeit. Du verlangst REWORK nur mit konkreten, umsetzbaren Findings und gibst ' +
      'PASS, sobald die Kriterien erfüllt sind.',
    sort_order: 5,
  },
  {
    id: 'COST_CONTROLLER',
    name: 'Cost Controller',
    department_id: 'finance',
    capability: 'LOW',
    tools: [],
    max_input_tokens: 20000,
    max_output_tokens: 4000,
    max_tool_calls: 0,
    max_runtime_sec: 600,
    max_job_cost_usd: 0.5,
    description: 'Analysiert Kosten, Tokenverbrauch und Kontingente und empfiehlt Steuerungsmaßnahmen.',
    instructions:
      'Du analysierst Kosten, Token-Verbrauch und Kontingentnutzung anhand der gelieferten Ledger-Daten, erkennst Ausreißer ' +
      'und ineffiziente Muster und gibst konkrete Spar- und Steuerungsempfehlungen. Du rechnest ausschließlich mit den ' +
      'gelieferten Zahlen und erfindest keine Werte.',
    sort_order: 6,
  },
  {
    id: 'AUDITOR',
    name: 'Auditor',
    department_id: 'finance',
    capability: 'MEDIUM',
    tools: [],
    max_input_tokens: 30000,
    max_output_tokens: 6000,
    max_tool_calls: 0,
    max_runtime_sec: 600,
    max_job_cost_usd: 1,
    description: 'Prüft Audit-Log, Freigaben und Job-Ergebnisse auf Regelverstöße und Risiken.',
    instructions:
      'Du prüfst Audit-Log, Freigaben und Job-Ergebnisse auf Regelverstöße, Auffälligkeiten und Risiken (z. B. Aktionen ohne ' +
      'nötige Freigabe, ungewöhnliche Kosten, wiederholte Fehler) und berichtest sachlich mit Belegen aus den gelieferten Daten.',
    sort_order: 7,
  },
];

type SeedProvider = Pick<Provider, 'id' | 'name' | 'type'> & Partial<Provider>;

const PROVIDERS: SeedProvider[] = [
  {
    id: 'claude_abo',
    name: 'Claude-Abo (Claude Code CLI)',
    type: 'claude_cli',
    enabled: true,
    priority: 10,
    billing_mode: 'subscription',
    config: { cli_path: 'claude', config_dir: '' },
    quota_unit: 'none',
    quota_limit: null,
    quota_period: 'rolling',
    quota_period_hours: 5,
    policy_on_exhaustion: 'WAIT',
    max_concurrent: 2,
    notes:
      'Nutzt deinen Claude-Plan (Pro/Max) über die lokal angemeldete Claude Code CLI. Das Restkontingent meldet Anthropic ' +
      'nicht vorab – Davenet erkennt erreichte Limits an der Meldung der CLI und lässt Jobs bis zum Reset warten.',
  },
  {
    id: 'anthropic_api',
    name: 'Anthropic API (Pay-as-you-go)',
    type: 'anthropic_api',
    enabled: false,
    priority: 20,
    billing_mode: 'pay_as_you_go',
    config: { api_key_env: 'ANTHROPIC_API_KEY', base_url: '' },
    quota_unit: 'none',
    quota_period: 'monthly',
    policy_on_exhaustion: 'BLOCK',
    monthly_cost_limit_usd: 25,
    max_concurrent: 2,
    notes: 'Direkter API-Zugang mit API-Key, Abrechnung pro Token. Standardmäßig deaktiviert und mit Kostenlimit.',
  },
  {
    id: 'simulation',
    name: 'Simulation (Testbetrieb ohne KI)',
    type: 'mock',
    enabled: false,
    priority: 90,
    billing_mode: 'subscription',
    config: { latency_ms: 400 },
    quota_unit: 'requests',
    quota_limit: 200,
    quota_period: 'daily',
    policy_on_exhaustion: 'WAIT',
    max_concurrent: 4,
    notes: 'Liefert Platzhalter-Ergebnisse ohne echte KI-Aufrufe – zum Ausprobieren der Abläufe. Ergebnisse sind nicht echt.',
  },
];

type SeedModel = Pick<Model, 'provider_id' | 'model_name' | 'tier' | 'label'> & Partial<Model>;

const claudeModels = (providerId: string, cli: boolean): SeedModel[] => [
  {
    provider_id: providerId,
    model_name: cli ? 'claude-haiku-4-5-20251001' : 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    tier: 'LOW',
    context_window: 200000,
    max_output_tokens: 64000,
    input_price_per_mtok: 1,
    output_price_per_mtok: 5,
    supports_effort: false,
    sort_order: 0,
  },
  {
    provider_id: providerId,
    model_name: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    tier: 'MEDIUM',
    context_window: cli ? 200000 : 1000000,
    max_output_tokens: 128000,
    input_price_per_mtok: 2,
    output_price_per_mtok: 10,
    supports_effort: true,
    sort_order: 1,
  },
  {
    provider_id: providerId,
    model_name: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    tier: 'HIGH',
    context_window: cli ? 200000 : 1000000,
    max_output_tokens: 128000,
    input_price_per_mtok: 4,
    output_price_per_mtok: 20,
    supports_effort: true,
    sort_order: 2,
  },
];

const MODELS: SeedModel[] = [
  ...claudeModels('claude_abo', true),
  ...claudeModels('anthropic_api', false),
  { provider_id: 'simulation', model_name: 'sim-low', label: 'Simulation LOW', tier: 'LOW', context_window: 200000, sort_order: 0 },
  { provider_id: 'simulation', model_name: 'sim-medium', label: 'Simulation MEDIUM', tier: 'MEDIUM', context_window: 200000, sort_order: 1 },
  { provider_id: 'simulation', model_name: 'sim-high', label: 'Simulation HIGH', tier: 'HIGH', context_window: 200000, sort_order: 2 },
];

/** Zuständigkeiten: welcher Agent welchen Job-Typ übernimmt (im UI änderbar). */
export const DEFAULT_ROUTES: { job_type: string; agent_id: string; capability_override?: Capability }[] = [
  { job_type: 'owner_directive', agent_id: 'EXECUTIVE_ORCHESTRATOR' },
  { job_type: 'executive_briefing', agent_id: 'EXECUTIVE_ORCHESTRATOR' },
  { job_type: 'opportunity_scan', agent_id: 'OPPORTUNITY_SCOUT' },
  { job_type: 'screening', agent_id: 'OPPORTUNITY_SCOUT', capability_override: 'LOW' },
  { job_type: 'deep_research', agent_id: 'RESEARCH_ANALYST' },
  { job_type: 'evaluation', agent_id: 'RESEARCH_ANALYST' },
  { job_type: 'technical_planning', agent_id: 'TECHNICAL_PLANNER' },
  { job_type: 'implementation', agent_id: 'IMPLEMENTATION' },
  { job_type: 'review', agent_id: 'REVIEW' },
  { job_type: 'cost_report', agent_id: 'COST_CONTROLLER' },
  { job_type: 'audit_review', agent_id: 'AUDITOR' },
];

const SCHEDULES = [
  { name: 'Research-Zyklus (wöchentlich)', job_type: 'opportunity_scan', input: { count: 5 }, kind: 'weekly', weekday: 1, time_of_day: '08:00' },
  { name: 'Executive Briefing (wöchentlich)', job_type: 'executive_briefing', input: {}, kind: 'weekly', weekday: 1, time_of_day: '07:30' },
  { name: 'Kostenbericht (monatlich)', job_type: 'cost_report', input: {}, kind: 'monthly', day_of_month: 1, time_of_day: '09:00' },
  { name: 'Audit-Prüfung (wöchentlich)', job_type: 'audit_review', input: {}, kind: 'weekly', weekday: 5, time_of_day: '17:00' },
] as const;

export function seedDefaults(store: Store): boolean {
  const seeded = store.db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'seeded'");
  if (seeded) {
    ensureRoutes(store);
    return false;
  }
  store.tx(() => {
    for (const d of DEPARTMENTS) store.departments.create(d);
    for (const a of AGENTS) store.agents.create(a);
    for (const p of PROVIDERS) store.providers.create(p);
    for (const m of MODELS) store.models.create(m);
    for (const s of SCHEDULES) {
      store.schedules.create({
        name: s.name,
        job_type: s.job_type,
        agent_id: null,
        input: { ...s.input },
        priority: 1,
        kind: s.kind,
        interval_minutes: null,
        time_of_day: s.time_of_day,
        weekday: 'weekday' in s ? s.weekday : null,
        day_of_month: 'day_of_month' in s ? s.day_of_month : null,
        enabled: false,
        next_run_at: null,
      });
    }
    ensureRoutes(store);
    store.db.run("INSERT INTO meta (key, value) VALUES ('seeded', ?)", new Date().toISOString());
    store.audit.add({ actor: 'system', action: 'system.seeded', details: { departments: DEPARTMENTS.length, agents: AGENTS.length } });
  });
  return true;
}

/** Ergänzt fehlende Zuständigkeiten (z. B. für neue Job-Typen nach einem Update), ohne Owner-Änderungen zu überschreiben. */
export function ensureRoutes(store: Store): void {
  for (const r of DEFAULT_ROUTES) {
    if (store.routes.get(r.job_type)) continue;
    const agentExists = !!store.agents.get(r.agent_id);
    store.routes.upsert({
      job_type: r.job_type,
      agent_id: agentExists ? r.agent_id : null,
      capability_override: r.capability_override ?? null,
      enabled: true,
    });
  }
}

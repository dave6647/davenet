import { CAPABILITIES, capabilityRank, type Agent, type Capability, type Job, type Model, type Provider, type ProviderPolicy, type Settings } from '../../shared/domain.ts';
import type { Store } from '../repo/store.ts';
import { agentMonthSpend, computeQuota, systemBudget } from './quota.ts';

/**
 * Model-/Provider-Router (Konzept §4–§7).
 *
 * Reihenfolge der Provider: die im Agent hinterlegte Liste erlaubter Provider (in dieser Reihenfolge),
 * sonst alle aktiven Provider nach Priorität. Der erste passende Provider ist der "vorgesehene" (primäre).
 * Ist er erschöpft, entscheidet die Provider-Policy des Agents (bzw. des Jobs) – ein Wechsel ist immer explizit.
 */

export interface Candidate {
  provider: Provider;
  model: Model;
}

export type RouteDecision =
  | { kind: 'run'; candidate: Candidate; note?: string }
  | { kind: 'defer'; reason: string } // Provider ausgelastet (max. parallele Jobs) – später erneut versuchen
  | { kind: 'wait'; providerId: string; until: string | null; reason: string }
  | { kind: 'block'; providerId: string | null; reason: string }
  | { kind: 'approval'; primary: Candidate; alternative: Candidate; reason: string };

type Availability =
  | { ok: true }
  | { ok: false; busy: true; reason: string }
  | { ok: false; busy: false; kind: 'quota' | 'cost'; until: string | null; reason: string };

export interface RouteInput {
  job: Job;
  agent: Agent;
  capability: Capability;
  settings: Settings;
  now: Date;
  runningByProvider: Record<string, number>;
}

export class Router {
  constructor(private readonly store: Store) {}

  /** Alle Kandidaten in Präferenzreihenfolge (je Provider die passenden Modelle). */
  candidates(agent: Agent): { provider: Provider; models: Model[] }[] {
    const all = this.store.providers.list().filter((p) => p.enabled);
    const ordered = agent.allowed_providers.length
      ? agent.allowed_providers.map((id) => all.find((p) => p.id === id)).filter((p): p is Provider => !!p)
      : all; // bereits nach Priorität sortiert
    return ordered.map((provider) => ({
      provider,
      models: this.store.models
        .list(provider.id)
        .filter((m) => m.enabled && m.context_window >= (agent.min_context_tokens || 0)),
    }));
  }

  route(input: RouteInput): RouteDecision {
    const { job, agent, capability } = input;
    const providers = this.candidates(agent);

    // Vom Owner (per Freigabe) festgelegter Provider/Modell hat Vorrang – ohne weiteren Fallback.
    if (job.forced_provider_id) {
      const entry = providers.find((c) => c.provider.id === job.forced_provider_id) ?? this.forcedEntry(job.forced_provider_id);
      const model = entry?.models.find((m) => m.id === job.forced_model_id) ?? entry?.models.find((m) => m.tier === capability);
      if (!entry || !model) return { kind: 'block', providerId: job.forced_provider_id, reason: 'Freigegebener Provider/Modell ist nicht mehr verfügbar' };
      const c = { provider: entry.provider, model };
      const a = this.availability(c, input);
      if (a.ok) return { kind: 'run', candidate: c, note: 'per Owner-Freigabe festgelegt' };
      if (a.busy) return { kind: 'defer', reason: a.reason };
      return this.exhaustedDecision(c, a);
    }

    const sameTier: Candidate[] = [];
    for (const { provider, models } of providers) {
      const m = models.find((x) => x.tier === capability);
      if (m) sameTier.push({ provider, model: m });
    }
    const anyTier: Candidate[] = [...sameTier];
    // weitere Klassen: zuerst höhere (bessere Qualität), dann niedrigere
    const order = [...CAPABILITIES].sort((a, b) => {
      const da = capabilityRank(a) - capabilityRank(capability);
      const db = capabilityRank(b) - capabilityRank(capability);
      const score = (d: number) => (d === 0 ? 0 : d > 0 ? d : 10 - d);
      return score(da) - score(db);
    });
    for (const tier of order) {
      if (tier === capability) continue;
      for (const { provider, models } of providers) {
        const m = models.find((x) => x.tier === tier);
        if (m) anyTier.push({ provider, model: m });
      }
    }

    const policy: ProviderPolicy = job.policy_override ?? agent.provider_policy;
    const primary = sameTier[0];
    if (!primary) {
      if (policy === 'FALLBACK_ANY_ALLOWED' && anyTier.length) {
        return this.firstAvailable(anyTier, input, `keine Modellklasse ${capability} verfügbar – Alternative`) ?? {
          kind: 'block',
          providerId: null,
          reason: `Kein verfügbarer Provider für Agent ${agent.id}`,
        };
      }
      return {
        kind: 'block',
        providerId: null,
        reason:
          `Kein aktiver Provider mit Modell der Klasse ${capability}` +
          (agent.min_context_tokens ? ` (Kontext ≥ ${agent.min_context_tokens.toLocaleString('de-DE')})` : '') +
          (agent.allowed_providers.length ? ` unter den erlaubten Providern (${agent.allowed_providers.join(', ')})` : ''),
      };
    }

    const a = this.availability(primary, input);
    if (a.ok) return { kind: 'run', candidate: primary };
    if (a.busy) return { kind: 'defer', reason: a.reason };

    // Kontingente und Kostenlimits gelten je Provider – Alternativen müssen also von einem anderen Provider kommen.
    const otherProvider = (c: Candidate) => c.provider.id !== primary.provider.id;
    switch (policy) {
      case 'FALLBACK_SAME_TIER': {
        const alt = this.firstAvailable(sameTier.filter(otherProvider), input, `Fallback (gleiche Klasse): ${a.reason}`);
        if (alt) return alt;
        break;
      }
      case 'FALLBACK_ANY_ALLOWED': {
        const alt = this.firstAvailable(anyTier.filter(otherProvider), input, `Fallback: ${a.reason}`);
        if (alt) return alt;
        break;
      }
      case 'OWNER_APPROVAL': {
        const alt = anyTier.find((c) => otherProvider(c) && this.availability(c, input).ok);
        if (alt) return { kind: 'approval', primary, alternative: alt, reason: a.reason };
        break;
      }
      default:
        break;
    }
    return this.exhaustedDecision(primary, a);
  }

  private forcedEntry(providerId: string): { provider: Provider; models: Model[] } | undefined {
    const provider = this.store.providers.get(providerId);
    if (!provider || !provider.enabled) return undefined;
    return { provider, models: this.store.models.list(providerId).filter((m) => m.enabled) };
  }

  private firstAvailable(list: Candidate[], input: RouteInput, note: string): RouteDecision | null {
    let busy: string | null = null;
    for (const c of list) {
      const a = this.availability(c, input);
      if (a.ok) return { kind: 'run', candidate: c, note };
      if (a.busy) busy = a.reason;
    }
    return busy ? { kind: 'defer', reason: busy } : null;
  }

  private exhaustedDecision(c: Candidate, a: Extract<Availability, { busy: false }>): RouteDecision {
    if (a.kind === 'quota' && c.provider.policy_on_exhaustion === 'WAIT') {
      return { kind: 'wait', providerId: c.provider.id, until: a.until, reason: a.reason };
    }
    return { kind: 'block', providerId: c.provider.id, reason: a.reason };
  }

  availability(c: Candidate, input: RouteInput): Availability {
    const { provider } = c;
    const running = input.runningByProvider[provider.id] ?? 0;
    const quota = computeQuota(this.store, provider, input.now, running);
    if (quota.exhausted) {
      return { ok: false, busy: false, kind: 'quota', until: quota.exhausted_until, reason: `${provider.name}: ${quota.reason ?? 'Kontingent erschöpft'}` };
    }
    if (quota.limit != null && provider.quota_unit === 'requests' && quota.used + running >= quota.limit) {
      // Laufende Jobs verbrauchen das Restkontingent mindestens zum Teil – erst deren Ende abwarten
      return { ok: false, busy: true, reason: `${provider.name}: Restkontingent durch laufende Jobs belegt` };
    }
    if (quota.cost_limit_reached) {
      return {
        ok: false,
        busy: false,
        kind: 'cost',
        until: null,
        reason: `${provider.name}: monatliches Kostenlimit ($${provider.monthly_cost_limit_usd}) erreicht`,
      };
    }
    if (provider.billing_mode === 'pay_as_you_go') {
      const budget = systemBudget(this.store, input.settings, input.now);
      if (budget.exceeded) {
        return { ok: false, busy: false, kind: 'cost', until: null, reason: `Systembudget ($${budget.limit}) für diesen Monat ausgeschöpft` };
      }
      if (budget.warning && input.job.priority < 2) {
        return {
          ok: false,
          busy: false,
          kind: 'cost',
          until: null,
          reason: `Budget-Schwelle (${input.settings.budget_warning_pct} %) erreicht – nur noch Jobs mit hoher Priorität auf kostenpflichtigen Providern`,
        };
      }
      if (input.agent.monthly_budget_usd != null && agentMonthSpend(this.store, input.agent.id, input.now) >= input.agent.monthly_budget_usd) {
        return { ok: false, busy: false, kind: 'cost', until: null, reason: `Monatsbudget von ${input.agent.name} ($${input.agent.monthly_budget_usd}) erreicht` };
      }
    }
    if (running >= Math.max(1, provider.max_concurrent)) {
      return { ok: false, busy: true, reason: `${provider.name} ist ausgelastet (${running}/${provider.max_concurrent} parallele Jobs)` };
    }
    return { ok: true };
  }
}

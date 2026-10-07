import type { z } from 'zod';
import type { Agent, Job, JobTypeInfo, Opportunity, ProviderKind, Settings, Task, ToolKey } from '../../../shared/domain.ts';
import type { ImageCallRequest, ImageCallResult } from '../../providers/types.ts';
import type { Orchestrator } from '../orchestrator.ts';
import type { ContextSection } from '../prompt.ts';

export interface JobContext {
  orch: Orchestrator;
  job: Job;
  agent: Agent;
  settings: Settings;
  opportunity?: Opportunity;
  task?: Task;
}

export interface CompletionInfo {
  providerId: string;
  modelName: string;
  filesChanged: string[];
}

/** Bild-Job: wird ohne Sprachmodell direkt von einem Bild-Provider ausgeführt. */
export interface ImageJobHooks {
  request(ctx: JobContext): Pick<ImageCallRequest, 'prompt' | 'size' | 'quality' | 'transparent'>;
  /** Speichert das Bild und liefert die Job-Ausgabe. */
  complete(ctx: JobContext, result: ImageCallResult, info: { providerId: string }): Record<string, unknown> | Promise<Record<string, unknown>>;
}

/** Definition eines Job-Typs: Zweck, erlaubte Werkzeuge, Prompt-Aufbau, Ergebnis-Schema und Folgeaktionen. */
export interface JobTypeDef<O = any> {
  key: string;
  label: string;
  description: string;
  departmentHint: string;
  defaultAgent: string;
  tools: ToolKey[];
  requiresOpportunity?: boolean;
  requiresTask?: boolean;
  /** Darf der Owner diesen Job manuell anlegen? */
  manual: boolean;
  /** Art des Providers, der den Job ausführt (Standard: Sprachmodell). */
  providerKind?: ProviderKind;
  /** Nur bei providerKind 'image'. */
  image?: ImageJobHooks;
  inputFields: JobTypeInfo['input_fields'];
  /** Projekt-Workspace bereitstellen (nur mit Opportunity). */
  workspace?: 'read' | 'write';
  output: z.ZodType<O>;
  outputHint?: string;
  title(input: Record<string, unknown>, ctx: Omit<JobContext, 'job' | 'agent'> & { opportunityTitle?: string; taskTitle?: string }): string;
  buildPrompt(ctx: JobContext): { task: string; sections: ContextSection[] };
  complete(ctx: JobContext, output: O, info: CompletionInfo): void | Promise<void>;
  /** Aufräumen, wenn der Job endgültig scheitert oder abgebrochen wird. */
  failed?(ctx: JobContext, reason: string): void;
}

export function toInfo(def: JobTypeDef): JobTypeInfo {
  return {
    key: def.key,
    label: def.label,
    description: def.description,
    department_hint: def.departmentHint,
    default_agent: def.defaultAgent,
    tools: def.tools,
    requires_opportunity: !!def.requiresOpportunity,
    requires_task: !!def.requiresTask,
    manual: def.manual,
    provider_kind: def.providerKind ?? 'llm',
    input_fields: def.inputFields,
  };
}

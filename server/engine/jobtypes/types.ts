import type { z } from 'zod';
import type { Agent, Job, JobTypeInfo, Opportunity, Settings, Task, ToolKey } from '../../../shared/domain.ts';
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
    input_fields: def.inputFields,
  };
}

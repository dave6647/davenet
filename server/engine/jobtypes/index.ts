import type { JobTypeInfo } from '../../../shared/domain.ts';
import { implementation, review, technicalPlanning } from './development.ts';
import { customJob, executiveBriefing, ownerDirective } from './executive.ts';
import { auditReview, costReport } from './finance.ts';
import { deepResearch, evaluation, opportunityScan, screening } from './research.ts';
import { toInfo, type JobTypeDef } from './types.ts';

/** Alle Job-Typen in der Reihenfolge der Pipeline (Konzept §8, §10, §15). */
export const JOB_TYPES: JobTypeDef[] = [
  ownerDirective,
  executiveBriefing,
  opportunityScan,
  screening,
  deepResearch,
  evaluation,
  technicalPlanning,
  implementation,
  review,
  costReport,
  auditReview,
  customJob,
];

const BY_KEY = new Map(JOB_TYPES.map((t) => [t.key, t]));

export function jobType(key: string): JobTypeDef | undefined {
  return BY_KEY.get(key);
}

export function jobTypeInfos(): JobTypeInfo[] {
  return JOB_TYPES.map(toInfo);
}

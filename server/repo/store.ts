import type { Db } from '../db/database.ts';
import { AgentRepo, DepartmentRepo, RouteRepo } from './organisation.ts';
import { ModelRepo, ProviderRepo } from './providers.ts';
import { JobRepo } from './jobs.ts';
import { OpportunityRepo, TaskRepo } from './opportunities.ts';
import { ApprovalRepo } from './approvals.ts';
import { ArtifactRepo, AuditRepo } from './records.ts';
import { LedgerRepo } from './ledger.ts';
import { ScheduleRepo, SettingsRepo } from './schedules.ts';

/** Bündelt alle Repositories über einer Datenbank-Verbindung. */
export class Store {
  readonly departments: DepartmentRepo;
  readonly agents: AgentRepo;
  readonly routes: RouteRepo;
  readonly providers: ProviderRepo;
  readonly models: ModelRepo;
  readonly jobs: JobRepo;
  readonly opportunities: OpportunityRepo;
  readonly tasks: TaskRepo;
  readonly approvals: ApprovalRepo;
  readonly artifacts: ArtifactRepo;
  readonly audit: AuditRepo;
  readonly ledger: LedgerRepo;
  readonly schedules: ScheduleRepo;
  readonly settings: SettingsRepo;

  constructor(readonly db: Db) {
    this.departments = new DepartmentRepo(db);
    this.agents = new AgentRepo(db);
    this.routes = new RouteRepo(db);
    this.providers = new ProviderRepo(db);
    this.models = new ModelRepo(db);
    this.jobs = new JobRepo(db);
    this.opportunities = new OpportunityRepo(db);
    this.tasks = new TaskRepo(db);
    this.approvals = new ApprovalRepo(db);
    this.artifacts = new ArtifactRepo(db);
    this.audit = new AuditRepo(db);
    this.ledger = new LedgerRepo(db);
    this.schedules = new ScheduleRepo(db);
    this.settings = new SettingsRepo(db);
  }

  tx<T>(fn: () => T): T {
    return this.db.tx(fn);
  }
}

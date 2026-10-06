import path from 'node:path';
import { Db } from './db/database.ts';
import { seedDefaults } from './db/seed.ts';
import { CompanyMemory } from './engine/memory.ts';
import { Orchestrator } from './engine/orchestrator.ts';
import { Scheduler } from './engine/scheduler.ts';
import { EventBus } from './events.ts';
import { Store } from './repo/store.ts';
import { SecretStore } from './secrets.ts';

export interface AppOptions {
  dataDir: string;
  /** Intervall der Scheduler-Schleife in ms. */
  schedulerIntervalMs?: number;
  startScheduler?: boolean;
}

export interface App {
  dataDir: string;
  db: Db;
  store: Store;
  bus: EventBus;
  memory: CompanyMemory;
  secrets: SecretStore;
  orch: Orchestrator;
  scheduler: Scheduler;
  close(): Promise<void>;
}

/** Baut die komplette Davenet-Laufzeit auf (ohne HTTP), z. B. für Server und Tests. */
export function createApp(opts: AppOptions): App {
  const dataDir = path.resolve(opts.dataDir);
  const db = new Db(path.join(dataDir, 'davenet.db'));
  db.migrate();
  const store = new Store(db);
  const bus = new EventBus();
  const memory = new CompanyMemory(dataDir);
  memory.init();
  const secrets = new SecretStore(path.join(dataDir, 'secrets.json'));
  seedDefaults(store);
  const orch = new Orchestrator(store, bus, memory, secrets, dataDir);
  const scheduler = new Scheduler(orch, opts.schedulerIntervalMs ?? 2000);
  if (opts.startScheduler !== false) scheduler.start();

  return {
    dataDir,
    db,
    store,
    bus,
    memory,
    secrets,
    orch,
    scheduler,
    async close() {
      await scheduler.stop();
      db.close();
    },
  };
}

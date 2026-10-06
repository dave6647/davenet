import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, type App } from '../server/app.ts';

/** Testumgebung: eigenes Datenverzeichnis, nur der Simulations-Provider aktiv, Scheduler manuell getaktet. */
export function testApp(opts: { simulationOnly?: boolean } = {}): App & { tmp: string; drain(maxTicks?: number): Promise<void> } {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'davenet-test-'));
  const app = createApp({ dataDir: tmp, startScheduler: false });
  if (opts.simulationOnly !== false) {
    app.store.providers.update('claude_abo', { enabled: false });
    app.store.providers.update('anthropic_api', { enabled: false });
    app.store.providers.update('simulation', { enabled: true, config: { latency_ms: 0 }, quota_limit: 10000, max_concurrent: 10 });
  }
  app.store.settings.update({ max_concurrent_jobs: 10 });
  const drain = async (maxTicks = 200) => {
    for (let i = 0; i < maxTicks; i++) {
      await app.scheduler.tick();
      await app.scheduler.idle();
      const runnable = app.store.jobs.runnable(new Date().toISOString());
      if (!runnable.length && !app.scheduler.runner.runningCount) return;
    }
    throw new Error('Queue wurde nicht leer');
  };
  return Object.assign(app, {
    tmp,
    drain,
    async close() {
      await app.scheduler.stop();
      app.db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  });
}

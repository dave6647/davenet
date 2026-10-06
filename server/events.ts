import { EventEmitter } from 'node:events';

/** Ereignis, das an die Oberfläche (SSE) und interne Trigger verteilt wird. */
export interface BusEvent {
  type: string; // z. B. 'job.updated', 'opportunity.updated', 'provider.quota_reset'
  entity?: string; // z. B. 'job', 'opportunity'
  id?: string | number;
  data?: Record<string, unknown>;
  ts: string;
}

export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emit(type: string, entity?: string, id?: string | number, data?: Record<string, unknown>): void {
    const ev: BusEvent = { type, entity, id, data, ts: new Date().toISOString() };
    this.emitter.emit('event', ev);
  }

  on(listener: (ev: BusEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
}

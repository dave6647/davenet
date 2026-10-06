import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.ts';

/** Server-Sent Events: eine Verbindung für die ganze App, Komponenten abonnieren Entitäten. */
type Listener = (ev: { type: string; entity?: string; id?: string | number }) => void;
const listeners = new Set<Listener>();
let source: EventSource | null = null;
let connected = false;
const statusListeners = new Set<(c: boolean) => void>();

function ensureSource(): void {
  if (source) return;
  source = new EventSource('/api/events');
  source.onopen = () => {
    connected = true;
    statusListeners.forEach((l) => l(true));
  };
  source.onerror = () => {
    connected = false;
    statusListeners.forEach((l) => l(false));
  };
  source.onmessage = (msg) => {
    try {
      const ev = JSON.parse(msg.data);
      listeners.forEach((l) => l(ev));
    } catch {
      /* ignorieren */
    }
  };
}

export function useLiveStatus(): boolean {
  const [c, setC] = useState(connected);
  useEffect(() => {
    ensureSource();
    statusListeners.add(setC);
    return () => {
      statusListeners.delete(setC);
    };
  }, []);
  return c;
}

/** Ruft `onChange` (entprellt) auf, wenn sich eine der Entitäten ändert. */
export function useLive(entities: string[], onChange: () => void): void {
  const cb = useRef(onChange);
  cb.current = onChange;
  const key = entities.join(',');
  useEffect(() => {
    ensureSource();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const wanted = new Set(key.split(',').filter(Boolean));
    const l: Listener = (ev) => {
      const entity = ev.entity ?? ev.type.split('.')[0];
      if (!wanted.has('*') && !wanted.has(entity)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => cb.current(), 250);
    };
    listeners.add(l);
    return () => {
      listeners.delete(l);
      if (timer) clearTimeout(timer);
    };
  }, [key]);
}

export interface Loaded<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Lädt Daten von der API und hält sie bei relevanten Änderungen aktuell. */
export function useApi<T>(path: string | null, live: string[] = []): Loaded<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const seq = useRef(0);

  const load = useCallback(() => {
    if (!path) return;
    const n = ++seq.current;
    setLoading(true);
    api
      .get<T>(path)
      .then((d) => {
        if (n !== seq.current) return;
        setData(d);
        setError(null);
      })
      .catch((e: Error) => {
        if (n === seq.current) setError(e.message);
      })
      .finally(() => {
        if (n === seq.current) setLoading(false);
      });
  }, [path]);

  useEffect(() => {
    load();
  }, [load]);
  useLive(live, load);
  return { data, error, loading, reload: load };
}

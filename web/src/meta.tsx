import { createContext, useContext, type ReactNode } from 'react';
import type { JobTypeInfo, ProviderTypeInfo } from '../../shared/domain.ts';
import { useApi } from './live.ts';

export interface Meta {
  version: string;
  job_types: JobTypeInfo[];
  provider_types: ProviderTypeInfo[];
  memory_areas: string[];
  owner_editable_areas: string[];
  data_dir: string;
}

const MetaCtx = createContext<Meta | null>(null);

export function MetaProvider({ children }: { children: ReactNode }) {
  const { data, error } = useApi<Meta>('/api/meta');
  if (error) return <div className="empty">Server nicht erreichbar: {error}</div>;
  if (!data) return <div className="empty">Lädt …</div>;
  return <MetaCtx.Provider value={data}>{children}</MetaCtx.Provider>;
}

export function useMeta(): Meta {
  const m = useContext(MetaCtx);
  if (!m) throw new Error('Meta fehlt');
  return m;
}

export function useJobTypeLabel(): (key: string) => string {
  const meta = useMeta();
  return (key) => meta.job_types.find((t) => t.key === key)?.label ?? key;
}

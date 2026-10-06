import { useEffect, useState } from 'react';

/** Minimaler Hash-Router: #/pfad/teil?x=1 */
export interface Route {
  path: string;
  parts: string[];
  query: URLSearchParams;
}

function parse(): Route {
  const raw = window.location.hash.replace(/^#/, '') || '/';
  const [p, q = ''] = raw.split('?');
  const path = p.startsWith('/') ? p : `/${p}`;
  return { path, parts: path.split('/').filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(q) };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parse);
  useEffect(() => {
    const onChange = () => setRoute(parse());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function navigate(to: string): void {
  window.location.hash = to.startsWith('#') ? to : `#${to}`;
}

/** Query-Parameter im Hash setzen, ohne den Pfad zu ändern. */
export function setQuery(params: Record<string, string | null | undefined>): void {
  const r = parse();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') r.query.delete(k);
    else r.query.set(k, v);
  }
  const q = r.query.toString();
  window.location.hash = `#${r.path}${q ? `?${q}` : ''}`;
}

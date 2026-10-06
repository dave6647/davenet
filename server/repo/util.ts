export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export const toBool = (v: unknown): boolean => v === 1 || v === true || v === '1';

export const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** Baut ein UPDATE-Statement aus einem Patch, beschränkt auf erlaubte Spalten. */
export function buildUpdate(
  table: string,
  idColumn: string,
  id: string | number,
  patch: Record<string, unknown>,
  allowed: readonly string[],
  jsonColumns: readonly string[] = [],
): { sql: string; params: (string | number | null | boolean)[] } | null {
  const sets: string[] = [];
  const params: (string | number | null | boolean)[] = [];
  for (const key of allowed) {
    if (!(key in patch)) continue;
    let value = patch[key];
    if (value === undefined) continue;
    if (jsonColumns.includes(key)) value = JSON.stringify(value ?? null);
    sets.push(`${key} = ?`);
    params.push(value as string | number | null | boolean);
  }
  if (!sets.length) return null;
  sets.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(id);
  return { sql: `UPDATE ${table} SET ${sets.join(', ')} WHERE ${idColumn} = ?`, params };
}

export class NotFoundError extends Error {
  readonly statusCode = 404;
  constructor(what: string) {
    super(`${what} nicht gefunden`);
  }
}

export class ConflictError extends Error {
  readonly statusCode = 409;
}

export class ValidationError extends Error {
  readonly statusCode = 400;
}

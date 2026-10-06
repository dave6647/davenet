import { z } from 'zod';
import type { JsonSchema } from '../providers/types.ts';

const UNSUPPORTED = [
  '$schema',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'uniqueItems',
  'default',
];

/**
 * Erzeugt aus einem Zod-Schema ein JSON-Schema, das von strukturierten Ausgaben (Claude API, Claude Code CLI)
 * akzeptiert wird: keine numerischen/Längen-Constraints, additionalProperties=false für alle Objekte.
 * Die strengere Validierung erfolgt anschließend clientseitig mit Zod.
 */
export function toJsonSchema(schema: z.ZodType): JsonSchema {
  return sanitize(z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }) as JsonSchema);
}

function sanitize(node: unknown): JsonSchema {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return node as JsonSchema;
  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (UNSUPPORTED.includes(k)) continue;
    if (k === 'properties' && v && typeof v === 'object') {
      out.properties = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, sanitize(pv)]));
    } else if (k === 'items') {
      out.items = sanitize(v);
    } else if ((k === 'anyOf' || k === 'oneOf' || k === 'allOf') && Array.isArray(v)) {
      out[k === 'oneOf' ? 'anyOf' : k] = v.map(sanitize);
    } else if ((k === '$defs' || k === 'definitions') && v && typeof v === 'object') {
      out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([dk, dv]) => [dk, sanitize(dv)]));
    } else {
      out[k] = v;
    }
  }
  if (Array.isArray(out.type)) {
    // ["string","null"] -> anyOf
    const types = out.type as string[];
    delete out.type;
    const rest = { ...out };
    for (const key of Object.keys(out)) delete out[key];
    out.anyOf = types.map((t) => (t === 'null' ? { type: 'null' } : { ...rest, type: t }));
  }
  if (out.type === 'object') {
    out.additionalProperties = false;
    if (!out.properties) out.properties = {};
  }
  return out as JsonSchema;
}

/** Kompakte Fehlerbeschreibung für Reparatur-Prompts und Job-Logs. */
export function describeZodError(error: z.ZodError): string {
  return z.prettifyError(error).slice(0, 1500);
}

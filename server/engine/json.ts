/**
 * Robustes Herauslösen eines JSON-Objekts aus Modellantworten
 * (für Provider ohne native strukturierte Ausgabe oder als Rückfallebene).
 */
export function extractJson(text: string): unknown | undefined {
  const t = (text ?? '').trim();
  if (!t) return undefined;
  const direct = tryParse(t);
  if (direct !== undefined) return direct;

  // ```json … ``` – letzter passender Block gewinnt (Modelle schreiben oft erst Erläuterungen)
  const fences = [...t.matchAll(/```(?:json|JSON)?\s*\n([\s\S]*?)```/g)];
  for (let i = fences.length - 1; i >= 0; i--) {
    const parsed = tryParse(fences[i][1].trim());
    if (parsed !== undefined) return parsed;
  }

  // Erstes ausgeglichenes {...} bzw. [...] (String-bewusst)
  for (const open of ['{', '[']) {
    let start = t.indexOf(open);
    while (start >= 0) {
      const end = matchClose(t, start);
      if (end > start) {
        const parsed = tryParse(t.slice(start, end + 1));
        if (parsed !== undefined) return parsed;
      }
      start = t.indexOf(open, start + 1);
    }
  }
  return undefined;
}

function tryParse(s: string): unknown | undefined {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function matchClose(s: string, start: number): number {
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

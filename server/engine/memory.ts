import fs from 'node:fs';
import path from 'node:path';
import type { Artifact } from '../../shared/domain.ts';
import type { Store } from '../repo/store.ts';
import { ValidationError } from '../repo/util.ts';

/** Bereiche des Unternehmensgedächtnisses (Konzept §13). */
export const MEMORY_AREAS = ['strategy', 'opportunities', 'projects', 'research', 'finance', 'decisions', 'knowledge', 'audit'] as const;
export type MemoryArea = (typeof MEMORY_AREAS)[number];

/** Bereiche, die der Owner in der Oberfläche direkt bearbeiten darf. */
export const OWNER_EDITABLE_AREAS: MemoryArea[] = ['strategy', 'knowledge', 'decisions'];

const STRATEGY_FILE = 'strategy/strategie.md';

const STRATEGY_TEMPLATE = `# Unternehmensstrategie

> Diese Datei wird den Agents (gekürzt) als Kontext mitgegeben. Je konkreter sie ist,
> desto passender werden Opportunities, Bewertungen und Pläne. Bitte an deine Ziele anpassen.

## Ausrichtung
- Welche Art von Geschäft soll Davenet aufbauen? (z. B. kleine, profitable Software-Produkte / SaaS)
- Zielmärkte und Sprachen (z. B. DACH, englischsprachig, B2B/B2C)

## Suchfelder für Opportunities
- Themen, Branchen oder Problemfelder, die bevorzugt untersucht werden sollen

## Ausschlusskriterien
- z. B. keine Geschäftsmodelle mit hohen Vorabinvestitionen, keine regulierten Bereiche (Medizin, Finanzberatung)

## Ressourcen & Rahmenbedingungen
- Budget für Umsetzung und Betrieb
- Technische Präferenzen (z. B. TypeScript/Node, einfache Deployments)
- Verfügbare Zeit des Owners für Betrieb/Support

## Bewertungsmaßstab
- Was macht eine Opportunity attraktiv? (z. B. schneller Weg zum ersten Umsatz, geringe Konkurrenz, automatisierbar)
`;

export class CompanyMemory {
  readonly root: string;
  readonly workspacesRoot: string;

  constructor(dataDir: string) {
    this.root = path.join(dataDir, 'company');
    this.workspacesRoot = path.join(dataDir, 'workspaces');
  }

  init(): void {
    for (const area of MEMORY_AREAS) fs.mkdirSync(path.join(this.root, area), { recursive: true });
    fs.mkdirSync(this.workspacesRoot, { recursive: true });
    const strategy = path.join(this.root, STRATEGY_FILE);
    if (!fs.existsSync(strategy)) fs.writeFileSync(strategy, STRATEGY_TEMPLATE, 'utf8');
  }

  /** Absoluter Pfad innerhalb des Gedächtnisses (verhindert Ausbrüche aus dem Verzeichnis). */
  resolve(rel: string): string {
    const target = path.resolve(this.root, String(rel).replace(/^[/\\]+/, ''));
    const relative = path.relative(this.root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new ValidationError('Pfad außerhalb des Unternehmensgedächtnisses');
    return target;
  }

  readFile(rel: string): string {
    return fs.readFileSync(this.resolve(rel), 'utf8');
  }

  writeFile(rel: string, content: string): void {
    const file = this.resolve(rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
  }

  ownerWrite(rel: string, content: string): void {
    const area = rel.replace(/^[/\\]+/, '').split(/[/\\]/)[0] as MemoryArea;
    if (!OWNER_EDITABLE_AREAS.includes(area)) throw new ValidationError(`Bereich "${area}" ist nur lesbar`);
    if (!/\.(md|txt|json)$/i.test(rel)) throw new ValidationError('Nur .md-, .txt- oder .json-Dateien');
    this.writeFile(rel, content);
  }

  ownerDelete(rel: string): void {
    const area = rel.replace(/^[/\\]+/, '').split(/[/\\]/)[0] as MemoryArea;
    if (!OWNER_EDITABLE_AREAS.includes(area)) throw new ValidationError(`Bereich "${area}" ist nur lesbar`);
    fs.rmSync(this.resolve(rel), { force: true });
  }

  strategy(): string {
    try {
      return this.readFile(STRATEGY_FILE);
    } catch {
      return '';
    }
  }

  /** Kurzfassung des Wissensbereichs (Dateinamen + Anfang) für Prompts. */
  knowledgeDigest(maxChars: number): string {
    const dir = path.join(this.root, 'knowledge');
    if (!fs.existsSync(dir)) return '';
    const parts: string[] = [];
    let used = 0;
    for (const name of fs.readdirSync(dir).filter((n) => /\.(md|txt)$/i.test(n)).sort()) {
      const text = fs.readFileSync(path.join(dir, name), 'utf8').trim();
      const chunk = `### ${name}\n${text.slice(0, 1500)}`;
      if (used + chunk.length > maxChars) break;
      parts.push(chunk);
      used += chunk.length;
    }
    return parts.join('\n\n');
  }

  tree(): { path: string; size: number; modified: string }[] {
    const out: { path: string; size: number; modified: string }[] = [];
    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else {
          const st = fs.statSync(full);
          out.push({ path: path.relative(this.root, full).split(path.sep).join('/'), size: st.size, modified: st.mtime.toISOString() });
        }
      }
    };
    walk(this.root);
    return out;
  }

  workspaceDir(opportunityId: string): string {
    if (!/^OPP-\d{4,}$/.test(opportunityId)) throw new ValidationError('Ungültige Opportunity-ID');
    return path.join(this.workspacesRoot, opportunityId);
  }

  /** Legt ein Artefakt als Datei ab und registriert es in der Datenbank. */
  saveArtifact(
    store: Store,
    a: {
      area: MemoryArea;
      kind: string;
      title: string;
      content: string | object;
      summary?: string;
      job_id?: number | null;
      agent_id?: string | null;
      opportunity_id?: string | null;
      task_id?: string | null;
      fileName?: string;
    },
  ): Artifact {
    const format: 'md' | 'json' = typeof a.content === 'string' ? 'md' : 'json';
    const body = typeof a.content === 'string' ? a.content : JSON.stringify(a.content, null, 2);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const sub = a.opportunity_id && (a.area === 'opportunities' || a.area === 'projects' || a.area === 'research') ? `${a.opportunity_id}/` : '';
    const name = a.fileName ?? `${stamp}-${a.kind}${a.task_id ? `-${a.task_id.split('-').pop()}` : ''}${a.job_id ? `-job${a.job_id}` : ''}.${format}`;
    const rel = `${a.area}/${sub}${name}`;
    this.writeFile(rel, body);
    return store.artifacts.create({
      kind: a.kind,
      title: a.title,
      path: rel,
      format,
      size: Buffer.byteLength(body, 'utf8'),
      summary: (a.summary ?? '').slice(0, 500),
      job_id: a.job_id ?? null,
      agent_id: a.agent_id ?? null,
      opportunity_id: a.opportunity_id ?? null,
      task_id: a.task_id ?? null,
    });
  }

  readArtifact(a: Artifact): string {
    try {
      return this.readFile(a.path);
    } catch {
      return '';
    }
  }
}

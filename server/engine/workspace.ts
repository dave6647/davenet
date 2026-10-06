import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', '__pycache__', 'dist', 'build', '.next']);
const MAX_READ_BYTES = 200_000;
const MAX_WRITE_BYTES = 1_000_000;

/**
 * Projekt-Workspace für Implementierungs- und Review-Jobs (Tool Gateway, Approval-Level 1).
 * Alle Pfade werden auf das Workspace-Verzeichnis begrenzt.
 */
export class Workspace {
  readonly dir: string;

  constructor(dir: string, readonly writable: boolean) {
    this.dir = path.resolve(dir);
    fs.mkdirSync(this.dir, { recursive: true });
  }

  resolve(rel: string): string {
    const cleaned = String(rel ?? '').replace(/^[/\\]+/, '') || '.';
    const target = path.resolve(this.dir, cleaned);
    const relative = path.relative(this.dir, target);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Pfad liegt außerhalb des Workspace: ${rel}`);
    }
    // Symlinks dürfen nicht aus dem Workspace herausführen
    if (fs.existsSync(target)) {
      const real = fs.realpathSync(target);
      const realRoot = fs.realpathSync(this.dir);
      const realRel = path.relative(realRoot, real);
      if (realRel.startsWith('..') || path.isAbsolute(realRel)) throw new Error(`Pfad liegt außerhalb des Workspace: ${rel}`);
    }
    return target;
  }

  list(rel = '.', maxEntries = 400): string {
    const root = this.resolve(rel);
    if (!fs.existsSync(root)) return '(leer)';
    const lines: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (lines.length >= maxEntries) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (lines.length >= maxEntries) {
          lines.push('… (gekürzt)');
          return;
        }
        if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
        const full = path.join(dir, e.name);
        const relPath = path.relative(this.dir, full).split(path.sep).join('/');
        if (e.isDirectory()) {
          lines.push(`${relPath}/`);
          if (depth < 8) walk(full, depth + 1);
        } else {
          lines.push(`${relPath} (${fs.statSync(full).size} B)`);
        }
      }
    };
    walk(root, 0);
    return lines.length ? lines.join('\n') : '(leer)';
  }

  read(rel: string): string {
    const file = this.resolve(rel);
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error(`Keine Datei: ${rel}`);
    const buf = fs.readFileSync(file);
    const text = buf.subarray(0, MAX_READ_BYTES).toString('utf8');
    return stat.size > MAX_READ_BYTES ? `${text}\n… (gekürzt, ${stat.size} B gesamt)` : text;
  }

  write(rel: string, content: string): void {
    if (!this.writable) throw new Error('Workspace ist schreibgeschützt');
    if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) throw new Error('Datei zu groß (max. 1 MB)');
    const file = this.resolve(rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
  }

  replace(rel: string, oldText: string, newText: string): void {
    if (!this.writable) throw new Error('Workspace ist schreibgeschützt');
    const file = this.resolve(rel);
    const content = fs.readFileSync(file, 'utf8');
    const count = content.split(oldText).length - 1;
    if (count === 0) throw new Error('Text nicht gefunden');
    if (count > 1) throw new Error(`Text kommt ${count}-mal vor – bitte eindeutigeren Ausschnitt angeben`);
    fs.writeFileSync(file, content.replace(oldText, () => newText), 'utf8');
  }

  /** Momentaufnahme (Pfad -> Größe/mtime), um geänderte Dateien nach einem Lauf zu ermitteln. */
  snapshot(): Map<string, string> {
    const snap = new Map<string, string>();
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile()) {
          const st = fs.statSync(full);
          snap.set(path.relative(this.dir, full).split(path.sep).join('/'), `${st.size}:${st.mtimeMs}`);
        }
      }
    };
    if (fs.existsSync(this.dir)) walk(this.dir);
    return snap;
  }

  static diff(before: Map<string, string>, after: Map<string, string>): string[] {
    const changed: string[] = [];
    for (const [p, sig] of after) if (before.get(p) !== sig) changed.push(p);
    for (const p of before.keys()) if (!after.has(p)) changed.push(`${p} (gelöscht)`);
    return changed.sort();
  }
}

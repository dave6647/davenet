import fs from 'node:fs';
import path from 'node:path';

type SecretFile = Record<string, Record<string, string>>;

/**
 * Lokale Ablage für Zugangsdaten (Konzept §16 "Secrets Management").
 * Secrets liegen getrennt von der Datenbank in data/secrets.json (Dateirechte 0600) und
 * verlassen den Server nie – die Oberfläche sieht nur, ob ein Wert gesetzt ist (plus die letzten 4 Zeichen).
 */
export class SecretStore {
  constructor(private readonly file: string) {}

  private read(): SecretFile {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) as SecretFile;
    } catch {
      return {};
    }
  }

  private write(data: SecretFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* Windows: Dateirechte werden über das Benutzerprofil geregelt */
    }
  }

  get(scope: string, key = 'api_key'): string | null {
    const v = this.read()[scope]?.[key];
    return typeof v === 'string' && v.length ? v : null;
  }

  set(scope: string, key: string, value: string | null): void {
    const data = this.read();
    if (value) {
      data[scope] = { ...(data[scope] ?? {}), [key]: value };
    } else if (data[scope]) {
      delete data[scope][key];
      if (!Object.keys(data[scope]).length) delete data[scope];
    }
    this.write(data);
  }

  deleteScope(scope: string): void {
    const data = this.read();
    if (data[scope]) {
      delete data[scope];
      this.write(data);
    }
  }

  /** Gespeicherter Wert oder – als Rückfall – eine Umgebungsvariable. */
  resolve(scope: string, envName?: string, key = 'api_key'): { value: string | null; source: 'stored' | 'env' | null } {
    const stored = this.get(scope, key);
    if (stored) return { value: stored, source: 'stored' };
    const env = envName ? process.env[envName] : undefined;
    if (env && env.trim()) return { value: env.trim(), source: 'env' };
    return { value: null, source: null };
  }

  describe(scope: string, envName?: string, key = 'api_key'): { has_secret: boolean; hint: string | null; source: 'stored' | 'env' | null } {
    const { value, source } = this.resolve(scope, envName, key);
    return { has_secret: !!value, hint: value ? `…${value.slice(-4)}` : null, source };
  }
}

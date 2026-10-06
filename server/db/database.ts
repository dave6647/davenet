import { DatabaseSync, type StatementSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS } from './schema.ts';

export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlParam = SqlValue | boolean | undefined;

/** Kleine, synchrone Hülle um node:sqlite mit Statement-Cache und verschachtelbaren Transaktionen. */
export class Db {
  readonly raw: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();
  private txDepth = 0;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (file !== ':memory:') this.raw.exec('PRAGMA journal_mode = WAL;');
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  private static norm(params: SqlParam[]): SqlValue[] {
    return params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
  }

  all<T = Record<string, unknown>>(sql: string, ...params: SqlParam[]): T[] {
    return this.stmt(sql).all(...Db.norm(params)) as T[];
  }

  get<T = Record<string, unknown>>(sql: string, ...params: SqlParam[]): T | undefined {
    return this.stmt(sql).get(...Db.norm(params)) as T | undefined;
  }

  run(sql: string, ...params: SqlParam[]): { changes: number; lastInsertRowid: number } {
    const r = this.stmt(sql).run(...Db.norm(params));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /** Führt fn atomar aus. Verschachtelte Aufrufe nutzen Savepoints. */
  tx<T>(fn: () => T): T {
    const depth = this.txDepth;
    const sp = `sp_${depth}`;
    this.raw.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.txDepth++;
    try {
      const result = fn();
      this.txDepth--;
      this.raw.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
      return result;
    } catch (err) {
      this.txDepth--;
      this.raw.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw err;
    }
  }

  migrate(): number {
    this.raw.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const row = this.get<{ value: string }>("SELECT value FROM meta WHERE key = 'schema_version'");
    let version = row ? Number(row.value) : 0;
    for (let i = version; i < MIGRATIONS.length; i++) {
      this.tx(() => {
        this.raw.exec(MIGRATIONS[i]);
        this.run(
          "INSERT INTO meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          String(i + 1),
        );
      });
      version = i + 1;
    }
    return version;
  }

  close(): void {
    this.cache.clear();
    this.raw.close();
  }
}

export const nowIso = (): string => new Date().toISOString();

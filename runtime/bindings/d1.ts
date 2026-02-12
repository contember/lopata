import { Database, type SQLQueryBindings } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

interface D1Meta {
  duration: number;
  changes: number;
  last_row_id: number;
  served_by: string;
  rows_read: number;
  rows_written: number;
}

interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: D1Meta;
}

interface D1ExecResult {
  count: number;
  duration: number;
}

function buildMeta(db: Database, durationMs: number): D1Meta {
  return {
    duration: durationMs,
    changes: db.query<{ c: number }, []>("SELECT changes() as c").get()!.c,
    last_row_id: db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id,
    served_by: "bunflare-d1",
    rows_read: 0,
    rows_written: 0,
  };
}

export class LocalD1Database {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  prepare(sql: string): LocalD1PreparedStatement {
    return new LocalD1PreparedStatement(this.db, sql);
  }

  async batch<T = Record<string, unknown>>(statements: LocalD1PreparedStatement[]): Promise<D1Result<T>[]> {
    const results: D1Result<T>[] = [];
    this.db.run("BEGIN");
    try {
      for (const stmt of statements) {
        results.push(await stmt.all<T>());
      }
      this.db.run("COMMIT");
    } catch (e) {
      this.db.run("ROLLBACK");
      throw e;
    }
    return results;
  }

  async exec(sql: string): Promise<D1ExecResult> {
    const start = performance.now();
    let count = 0;
    const statements = sql.split(";").map(s => s.trim()).filter(s => s.length > 0);
    for (const stmt of statements) {
      this.db.run(stmt);
      count++;
    }
    return { count, duration: performance.now() - start };
  }

  withSession(_bookmark?: string): LocalD1Database {
    return this;
  }
}

export class LocalD1PreparedStatement {
  private db: Database;
  private sql: string;
  private params: SQLQueryBindings[];

  constructor(db: Database, sql: string) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }

  bind(...values: SQLQueryBindings[]): LocalD1PreparedStatement {
    const stmt = new LocalD1PreparedStatement(this.db, this.sql);
    stmt.params = values;
    return stmt;
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const start = performance.now();
    const row = this.db.query(this.sql).get(...this.params) as Record<string, unknown> | null;
    if (!row) return null;
    if (column) return (row[column] as T) ?? null;
    return row as T;
  }

  async run(): Promise<D1Result> {
    const start = performance.now();
    this.db.query(this.sql).run(...this.params);
    const duration = performance.now() - start;
    return {
      results: [],
      success: true,
      meta: buildMeta(this.db, duration),
    };
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const start = performance.now();
    const results = this.db.query(this.sql).all(...this.params) as T[];
    const duration = performance.now() - start;
    return {
      results,
      success: true,
      meta: buildMeta(this.db, duration),
    };
  }

  async raw<T extends unknown[] = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const query = this.db.query(this.sql);
    const columns = query.columnNames;
    const rows = query.values(...this.params) as T[];
    if (options?.columnNames) {
      return [columns as unknown as T, ...rows];
    }
    return rows;
  }
}

export function openD1Database(dataDir: string, databaseName: string): LocalD1Database {
  const d1Dir = join(dataDir, "d1");
  mkdirSync(d1Dir, { recursive: true });
  const dbPath = join(d1Dir, `${databaseName}.sqlite`);
  const db = new Database(dbPath, { create: true });
  db.run("PRAGMA journal_mode=WAL");
  return new LocalD1Database(db);
}

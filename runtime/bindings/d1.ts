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
  size_after: number;
  changed_db: boolean;
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

function buildMeta(db: Database, durationMs: number, rowsRead: number, rowsWritten: number): D1Meta {
  const changes = db.query<{ c: number }, []>("SELECT changes() as c").get()!.c;
  const { page_count } = db.query<{ page_count: number }, []>("PRAGMA page_count").get()!;
  const { page_size } = db.query<{ page_size: number }, []>("PRAGMA page_size").get()!;
  return {
    duration: durationMs,
    changes,
    last_row_id: db.query<{ id: number }, []>("SELECT last_insert_rowid() as id").get()!.id,
    served_by: "bunflare-d1",
    rows_read: rowsRead,
    rows_written: rowsWritten,
    size_after: page_count * page_size,
    changed_db: changes > 0,
  };
}

/**
 * Split SQL text into individual statements, respecting string literals
 * (single-quoted, double-quoted), line comments (--), and block comments.
 */
function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let i = 0;
  const len = sql.length;

  while (i < len) {
    const ch = sql[i]!;

    // Single-quoted string literal
    if (ch === "'") {
      current += ch;
      i++;
      while (i < len) {
        const c = sql[i]!;
        current += c;
        i++;
        if (c === "'" && i < len && sql[i] === "'") {
          // escaped quote ''
          current += sql[i]!;
          i++;
        } else if (c === "'") {
          break;
        }
      }
      continue;
    }

    // Double-quoted identifier
    if (ch === '"') {
      current += ch;
      i++;
      while (i < len) {
        const c = sql[i]!;
        current += c;
        i++;
        if (c === '"' && i < len && sql[i] === '"') {
          current += sql[i]!;
          i++;
        } else if (c === '"') {
          break;
        }
      }
      continue;
    }

    // Line comment --
    if (ch === "-" && i + 1 < len && sql[i + 1] === "-") {
      i += 2;
      while (i < len && sql[i] !== "\n") {
        i++;
      }
      if (i < len) i++; // skip \n
      current += " ";
      continue;
    }

    // Block comment /* ... */
    if (ch === "/" && i + 1 < len && sql[i + 1] === "*") {
      i += 2;
      while (i + 1 < len && !(sql[i] === "*" && sql[i + 1] === "/")) {
        i++;
      }
      if (i + 1 < len) i += 2; // skip */
      current += " ";
      continue;
    }

    // Statement separator
    if (ch === ";") {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        statements.push(trimmed);
      }
      current = "";
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  const trimmed = current.trim();
  if (trimmed.length > 0) {
    statements.push(trimmed);
  }

  return statements;
}

/** Convert bind parameters: boolean→int, undefined→error, ArrayBuffer→Uint8Array */
function convertBindParams(params: unknown[]): SQLQueryBindings[] {
  return params.map((v, idx) => {
    if (v === undefined) {
      throw new Error(`D1_TYPE_ERROR: Cannot bind undefined value at index ${idx}. Use null instead.`);
    }
    if (typeof v === "boolean") {
      return v ? 1 : 0;
    }
    if (v instanceof ArrayBuffer) {
      return new Uint8Array(v);
    }
    return v as SQLQueryBindings;
  });
}

/** Check if a SQL statement is a read query (returns rows) */
function isReadStatement(sql: string): boolean {
  const upper = sql.trimStart().toUpperCase();
  return upper.startsWith("SELECT") || upper.startsWith("WITH") || upper.startsWith("PRAGMA");
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
    const statements = splitStatements(sql);
    for (const stmt of statements) {
      try {
        this.db.run(stmt);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`D1_EXEC_ERROR: Error in SQL statement [${stmt}]: ${msg}`);
      }
      count++;
    }
    return { count, duration: performance.now() - start };
  }

  async dump(): Promise<ArrayBuffer> {
    return this.db.serialize().buffer as ArrayBuffer;
  }

  withSession(_bookmark?: string): LocalD1DatabaseSession {
    return new LocalD1DatabaseSession(this.db);
  }
}

export class LocalD1DatabaseSession {
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

  getBookmark(): string | null {
    return null;
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

  bind(...values: unknown[]): LocalD1PreparedStatement {
    const stmt = new LocalD1PreparedStatement(this.db, this.sql);
    stmt.params = convertBindParams(values);
    return stmt;
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const start = performance.now();
    const row = this.db.query(this.sql).get(...this.params) as Record<string, unknown> | null;
    if (!row) return null;
    if (column) {
      if (!(column in row)) {
        throw new Error(`D1_ERROR: Column '${column}' does not exist in the result set.`);
      }
      return (row[column] as T) ?? null;
    }
    return row as T;
  }

  async run(): Promise<D1Result> {
    const start = performance.now();
    this.db.query(this.sql).run(...this.params);
    const duration = performance.now() - start;
    const changes = this.db.query<{ c: number }, []>("SELECT changes() as c").get()!.c;
    return {
      results: [],
      success: true,
      meta: buildMeta(this.db, duration, 0, changes),
    };
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const start = performance.now();
    const results = this.db.query(this.sql).all(...this.params) as T[];
    const duration = performance.now() - start;
    const isRead = isReadStatement(this.sql);
    const changes = this.db.query<{ c: number }, []>("SELECT changes() as c").get()!.c;
    return {
      results,
      success: true,
      meta: buildMeta(this.db, duration, isRead ? results.length : 0, isRead ? 0 : changes),
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

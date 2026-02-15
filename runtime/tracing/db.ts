import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = join(process.cwd(), ".bunflare");
const DB_PATH = join(DATA_DIR, "traces.sqlite");

let instance: Database | null = null;

export function getTracingDatabase(): Database {
  if (instance) return instance;

  mkdirSync(DATA_DIR, { recursive: true });

  instance = new Database(DB_PATH, { create: true });
  instance.run("PRAGMA journal_mode=WAL");
  runTracingMigrations(instance);
  return instance;
}

export function runTracingMigrations(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS spans (
      span_id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      parent_span_id TEXT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'internal',
      status TEXT NOT NULL DEFAULT 'unset',
      status_message TEXT,
      start_time INTEGER NOT NULL,
      end_time INTEGER,
      duration_ms REAL,
      attributes TEXT,
      worker_name TEXT
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans(trace_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_spans_start ON spans(start_time DESC)");

  db.run(`
    CREATE TABLE IF NOT EXISTS span_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      span_id TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      name TEXT NOT NULL,
      level TEXT,
      message TEXT,
      attributes TEXT
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_events_span ON span_events(span_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_events_trace ON span_events(trace_id)");
}

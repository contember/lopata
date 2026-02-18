import type { D1Table, QueryResult } from "../rpc/types";

// ─── Schema types ────────────────────────────────────────────────────

export interface ForeignKeyInfo {
  targetTable: string;
  targetColumn: string;
}

export interface ColumnInfo {
  name: string;
  type: string;
  notNull: boolean;
  defaultValue: string | null;
  autoIncrement: boolean;
  foreignKey: ForeignKeyInfo | null;
}

export interface TableSchema {
  columns: ColumnInfo[];
  primaryKeys: string[];
}

// ─── Browser types ───────────────────────────────────────────────────

export interface SqlBrowserProps {
  tables?: D1Table[] | null;
  execQuery: (sql: string) => Promise<QueryResult>;
  basePath?: string;
  routeTab?: Tab;
  routeTable?: string | null;
  routeQuery?: URLSearchParams;
}

export type Tab = "data" | "schema" | "sql";

export type SortDir = "ASC" | "DESC";

export const PAGE_SIZE = 50;

export const TABS: { key: Tab; label: string }[] = [
  { key: "data", label: "Data Browser" },
  { key: "schema", label: "Schema" },
  { key: "sql", label: "SQL Console" },
];

// ─── History types ───────────────────────────────────────────────────

export interface HistoryEntry {
  sql: string;
  ts: number;
}

export interface BrowserHistoryEntry {
  table: string;
  filters: Record<string, string>;
  sortCol: string | null;
  sortDir: SortDir;
  ts: number;
}

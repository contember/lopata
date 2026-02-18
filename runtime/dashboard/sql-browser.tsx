import { useState, useEffect, useRef, useCallback } from "preact/hooks";
import type { D1Table, QueryResult } from "./rpc/types";

// ─── Schema parsing ──────────────────────────────────────────────────

interface ColumnInfo {
  name: string;
  type: string;
  notNull: boolean;
  defaultValue: string | null;
  autoIncrement: boolean;
}

interface TableSchema {
  columns: ColumnInfo[];
  primaryKeys: string[];
}

export function parseCreateTable(sql: string): TableSchema {
  const columns: ColumnInfo[] = [];
  const primaryKeys: string[] = [];

  // Extract the part between the outer parentheses
  const bodyMatch = sql.match(/\((.+)\)\s*$/s);
  if (!bodyMatch) return { columns, primaryKeys };

  // Split on commas that are not inside nested parens
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of bodyMatch[1]!) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());

  for (const part of parts) {
    // Table-level PRIMARY KEY(col1, col2)
    const pkMatch = part.match(/^PRIMARY\s+KEY\s*\((.+)\)/i);
    if (pkMatch) {
      for (const col of pkMatch[1]!.split(",")) {
        const name = col.trim().replace(/^["'`]|["'`]$/g, "");
        if (name && !primaryKeys.includes(name)) primaryKeys.push(name);
      }
      continue;
    }

    // Skip other constraints (UNIQUE, CHECK, FOREIGN KEY)
    if (/^(UNIQUE|CHECK|FOREIGN\s+KEY|CONSTRAINT)\s/i.test(part)) continue;

    // Column definition
    const colMatch = part.match(/^["'`]?(\w+)["'`]?\s+(.*)/s);
    if (!colMatch) continue;

    const name = colMatch[1]!;
    const rest = colMatch[2]!;
    const typePart = rest.match(/^(\w[\w\s()]*?)(?:\s+(?:NOT|NULL|DEFAULT|PRIMARY|UNIQUE|CHECK|REFERENCES|AUTOINCREMENT|AUTO_INCREMENT)|$)/i);
    const type = typePart ? typePart[1]!.trim() : rest.split(/\s/)[0] ?? "";
    const notNull = /\bNOT\s+NULL\b/i.test(rest);
    const autoIncrement = /\b(?:AUTOINCREMENT|AUTO_INCREMENT)\b/i.test(rest);
    const defaultMatch = rest.match(/\bDEFAULT\s+(\S+)/i);
    const defaultValue = defaultMatch ? defaultMatch[1]! : null;

    columns.push({ name, type, notNull, defaultValue, autoIncrement });

    if (/\bPRIMARY\s+KEY\b/i.test(rest)) {
      if (!primaryKeys.includes(name)) primaryKeys.push(name);
    }
  }

  return { columns, primaryKeys };
}

// ─── SQL helpers ─────────────────────────────────────────────────────

export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function quoteId(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function parseFilterExpr(col: string, expr: string): string | null {
  const trimmed = expr.trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();
  if (lower === "null") return `${quoteId(col)} IS NULL`;
  if (lower === "!null" || lower === "not null") return `${quoteId(col)} IS NOT NULL`;

  // Operators: >=, <=, !=, >, <, =
  const opMatch = trimmed.match(/^(>=|<=|!=|>|<|=)\s*(.+)$/);
  if (opMatch) {
    const [, op, val] = opMatch;
    return `${quoteId(col)} ${op} ${sqlLiteral(val!)}`;
  }

  // LIKE pattern (contains %)
  if (trimmed.includes("%")) {
    return `${quoteId(col)} LIKE ${sqlLiteral(trimmed)}`;
  }

  // Negation: !value
  if (trimmed.startsWith("!")) {
    return `${quoteId(col)} != ${sqlLiteral(trimmed.slice(1))}`;
  }

  // Default: contains
  return `${quoteId(col)} LIKE ${sqlLiteral("%" + trimmed + "%")}`;
}

function buildWhereClause(filters: Record<string, string>): string {
  const conditions: string[] = [];
  for (const [col, expr] of Object.entries(filters)) {
    const cond = parseFilterExpr(col, expr);
    if (cond) conditions.push(cond);
  }
  return conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
}

// ─── Query history (localStorage) ────────────────────────────────────

interface HistoryEntry {
  sql: string;
  ts: number;
}

const HISTORY_KEY = "bunflare-sql-history";
const HISTORY_MAX = 100;

function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveToHistory(sql: string): HistoryEntry[] {
  const trimmed = sql.trim();
  if (!trimmed) return loadHistory();
  const entries = loadHistory();
  // Deduplicate: remove existing entry with same SQL
  const filtered = entries.filter(e => e.sql !== trimmed);
  const next = [{ sql: trimmed, ts: Date.now() }, ...filtered].slice(0, HISTORY_MAX);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  return next;
}

function clearHistory(): HistoryEntry[] {
  localStorage.removeItem(HISTORY_KEY);
  return [];
}

function useHistory() {
  const [entries, setEntries] = useState<HistoryEntry[]>(() => loadHistory());
  const add = useCallback((sql: string) => {
    setEntries(saveToHistory(sql));
  }, []);
  const clear = useCallback(() => {
    setEntries(clearHistory());
  }, []);
  return { entries, add, clear };
}

// ─── Browser history (structured, localStorage) ─────────────────────

interface BrowserHistoryEntry {
  table: string;
  filters: Record<string, string>;
  sortCol: string | null;
  sortDir: SortDir;
  ts: number;
}

const BROWSER_HISTORY_KEY = "bunflare-browser-history";
const BROWSER_HISTORY_MAX = 50;

function loadBrowserHistory(): BrowserHistoryEntry[] {
  try {
    const raw = localStorage.getItem(BROWSER_HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveToBrowserHistory(entry: Omit<BrowserHistoryEntry, "ts">): BrowserHistoryEntry[] {
  const entries = loadBrowserHistory();
  // Deduplicate by same table + filters + sort
  const key = JSON.stringify({ t: entry.table, f: entry.filters, s: entry.sortCol, d: entry.sortDir });
  const filtered = entries.filter(e =>
    JSON.stringify({ t: e.table, f: e.filters, s: e.sortCol, d: e.sortDir }) !== key
  );
  const next = [{ ...entry, ts: Date.now() }, ...filtered].slice(0, BROWSER_HISTORY_MAX);
  localStorage.setItem(BROWSER_HISTORY_KEY, JSON.stringify(next));
  return next;
}

function clearBrowserHistory(): BrowserHistoryEntry[] {
  localStorage.removeItem(BROWSER_HISTORY_KEY);
  return [];
}

function useBrowserHistory() {
  const [entries, setEntries] = useState<BrowserHistoryEntry[]>(() => loadBrowserHistory());
  const add = useCallback((entry: Omit<BrowserHistoryEntry, "ts">) => {
    setEntries(saveToBrowserHistory(entry));
  }, []);
  const clear = useCallback(() => {
    setEntries(clearBrowserHistory());
  }, []);
  return { entries, add, clear };
}

// ─── Types ───────────────────────────────────────────────────────────

export interface SqlBrowserProps {
  tables?: D1Table[] | null;
  execQuery: (sql: string) => Promise<QueryResult>;
}

type SortDir = "ASC" | "DESC";

const PAGE_SIZE = 50;

// ─── SqlBrowser (main container) ─────────────────────────────────────

type Tab = "data" | "schema" | "sql";

const TABS: { key: Tab; label: string }[] = [
  { key: "data", label: "Data Browser" },
  { key: "schema", label: "Schema" },
  { key: "sql", label: "SQL Console" },
];

export function SqlBrowser({ tables, execQuery }: SqlBrowserProps) {
  const [tab, setTab] = useState<Tab>("data");
  const [consoleSql, setConsoleSql] = useState("");
  const history = useHistory();
  const browserHistory = useBrowserHistory();

  const openInConsole = (sql: string) => {
    setConsoleSql(sql);
    setTab("sql");
  };

  return (
    <div>
      {/* Tab bar */}
      <div class="flex gap-1 mb-5 border-b border-gray-200">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            class={`px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${
              tab === t.key
                ? "border-ink text-ink"
                : "border-transparent text-gray-400 hover:text-gray-600"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "data" && <DataBrowserTab tables={tables} execQuery={execQuery} onOpenInConsole={openInConsole} history={history} browserHistory={browserHistory} />}
      {tab === "schema" && <SchemaBrowserTab tables={tables} />}
      {tab === "sql" && <SqlConsoleTab execQuery={execQuery} initialSql={consoleSql} history={history} />}
    </div>
  );
}

// ─── SqlConsoleTab ───────────────────────────────────────────────────

function SqlConsoleTab({ execQuery, initialSql, history }: {
  execQuery: (sql: string) => Promise<QueryResult>;
  initialSql?: string;
  history: ReturnType<typeof useHistory>;
}) {
  const [sql, setSql] = useState(initialSql ?? "");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  // Update SQL when initialSql changes (e.g. from "open in console")
  useEffect(() => {
    if (initialSql) setSql(initialSql);
  }, [initialSql]);

  const run = async () => {
    if (!sql.trim() || loading) return;
    history.add(sql);
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await execQuery(sql);
      if (res.error) setError(res.error);
      else setResult(res);
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <div class="bg-white rounded-lg border border-gray-200 p-5 mb-6">
        <textarea
          value={sql}
          onInput={e => setSql((e.target as HTMLTextAreaElement).value)}
          onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run(); }}
          placeholder="SELECT * FROM ..."
          class="w-full bg-gray-50 border border-gray-200 rounded-lg px-4 py-3 font-mono text-sm outline-none min-h-[100px] resize-y focus:border-gray-300 focus:ring-1 focus:ring-gray-200 transition-all mb-4"
        />
        <div class="flex items-center gap-3">
          <button
            onClick={run}
            disabled={loading || !sql.trim()}
            class="rounded-md px-4 py-2 text-sm font-medium bg-ink text-white hover:bg-ink-muted disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            {loading ? "Running..." : "Run Query"}
          </button>
          <button
            onClick={() => setShowHistory(v => !v)}
            class={`rounded-md px-3 py-2 text-sm font-medium transition-all ${
              showHistory
                ? "bg-ink text-white"
                : "bg-white border border-gray-200 text-gray-500 hover:bg-gray-50"
            }`}
          >
            History{history.entries.length > 0 ? ` (${history.entries.length})` : ""}
          </button>
          <span class="text-xs text-gray-400">Ctrl+Enter to run</span>
        </div>
      </div>

      {showHistory && (
        <HistoryPanel
          entries={history.entries}
          onSelect={(entry) => { setSql(entry.sql); setShowHistory(false); }}
          onClear={history.clear}
        />
      )}

      {error ? (
        <div class="bg-red-50 text-red-600 p-4 rounded-lg text-sm font-medium">{error}</div>
      ) : result ? (
        <div>
          {result.message ? (
            <div class="bg-emerald-50 text-emerald-700 p-4 rounded-lg text-sm font-medium">{result.message}</div>
          ) : result.columns.length > 0 ? (
            <div>
              <div class="text-sm text-gray-400 mb-3 font-medium">{result.count} row(s)</div>
              <ResultTable columns={result.columns} rows={result.rows} />
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

// ─── ResultTable (read-only results) ─────────────────────────────────

function ResultTable({ columns, rows }: { columns: string[]; rows: Record<string, unknown>[] }) {
  return (
    <div class="bg-white rounded-lg border border-gray-200 overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-gray-100">
            {columns.map(col => (
              <th key={col} class="text-left px-4 py-2.5 font-medium text-xs text-gray-400 uppercase tracking-wider font-mono">{col}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} class="group border-b border-gray-50 last:border-0 hover:bg-gray-50/50 transition-colors">
              {columns.map(col => (
                <td key={col} class="px-4 py-2.5 font-mono text-xs">
                  {row[col] === null ? <span class="text-gray-300 italic">NULL</span> : String(row[col])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── SchemaBrowserTab ────────────────────────────────────────────────

function SchemaBrowserTab({ tables }: { tables?: D1Table[] | null }) {
  if (!tables?.length) {
    return <div class="text-center py-16 text-gray-400 text-sm font-medium">No tables found</div>;
  }

  return (
    <div class="space-y-4">
      {tables.map(t => {
        const schema = parseCreateTable(t.sql);
        return (
          <div key={t.name} class="bg-white rounded-lg border border-gray-200">
            <div class="flex items-center justify-between px-4 py-3 border-b border-gray-100">
              <div class="flex items-center gap-3">
                <span class="font-mono text-sm font-bold text-ink">{t.name}</span>
                <span class="text-xs text-gray-400 tabular-nums">{t.rows} row(s)</span>
              </div>
              {schema.primaryKeys.length > 0 && (
                <span class="text-xs text-gray-400">
                  PK: <span class="font-mono text-gray-500">{schema.primaryKeys.join(", ")}</span>
                </span>
              )}
            </div>
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-gray-50 text-xs text-gray-400 uppercase tracking-wider">
                  <th class="text-left px-4 py-2 font-medium">Column</th>
                  <th class="text-left px-4 py-2 font-medium">Type</th>
                  <th class="text-left px-4 py-2 font-medium">Nullable</th>
                  <th class="text-left px-4 py-2 font-medium">Default</th>
                </tr>
              </thead>
              <tbody>
                {schema.columns.map(col => (
                  <tr key={col.name} class="border-b border-gray-50 last:border-0">
                    <td class="px-4 py-2 font-mono text-xs font-medium text-ink">
                      {col.name}
                      {schema.primaryKeys.includes(col.name) && (
                        <span class="ml-1.5 text-[10px] font-semibold bg-gray-100 text-gray-500 px-1 py-0.5 rounded">PK</span>
                      )}
                      {col.autoIncrement && (
                        <span class="ml-1.5 text-[10px] font-semibold bg-amber-50 text-amber-600 px-1 py-0.5 rounded">AI</span>
                      )}
                    </td>
                    <td class="px-4 py-2 font-mono text-xs text-gray-500">{col.type || "—"}</td>
                    <td class="px-4 py-2 text-xs text-gray-400">{col.notNull ? "NOT NULL" : "NULL"}</td>
                    <td class="px-4 py-2 font-mono text-xs text-gray-400">{col.defaultValue ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div class="px-4 py-2.5 border-t border-gray-100 bg-gray-50/50">
              <pre class="text-xs text-gray-400 font-mono whitespace-pre-wrap">{t.sql}</pre>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── DataBrowserTab ──────────────────────────────────────────────────

interface RestoredState {
  filters: Record<string, string>;
  sortCol: string | null;
  sortDir: SortDir;
}

function DataBrowserTab({ tables, execQuery, onOpenInConsole, history, browserHistory }: {
  tables?: D1Table[] | null;
  execQuery: (sql: string) => Promise<QueryResult>;
  onOpenInConsole: (sql: string) => void;
  history: ReturnType<typeof useHistory>;
  browserHistory: ReturnType<typeof useBrowserHistory>;
}) {
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [restoredState, setRestoredState] = useState<RestoredState | null>(null);

  // Auto-select first table
  useEffect(() => {
    if (!selectedTable && tables?.length) {
      setSelectedTable(tables[0]!.name);
    }
  }, [tables]);

  const tableInfo = tables?.find(t => t.name === selectedTable) ?? null;

  const handleRestoreHistory = (entry: BrowserHistoryEntry) => {
    setSelectedTable(entry.table);
    setRestoredState({ filters: entry.filters, sortCol: entry.sortCol, sortDir: entry.sortDir });
  };

  // Clear restored state once it's been consumed (table changed by user)
  const handleTableSelect = (name: string) => {
    setSelectedTable(name);
    setRestoredState(null);
  };

  return (
    <div class="flex gap-5">
      <TableSidebar
        tables={tables}
        selected={selectedTable}
        onSelect={handleTableSelect}
      />
      <div class="flex-1 min-w-0">
        {tableInfo ? (
          <TableDataView
            key={restoredState ? JSON.stringify(restoredState) : tableInfo.name}
            table={tableInfo}
            execQuery={execQuery}
            onOpenInConsole={onOpenInConsole}
            history={history}
            browserHistory={browserHistory}
            onRestoreHistory={handleRestoreHistory}
            initialState={restoredState}
          />
        ) : (
          <div class="text-center py-16 text-gray-400 text-sm font-medium">
            {tables?.length ? "Select a table" : "No tables found"}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── TableSidebar ────────────────────────────────────────────────────

function TableSidebar({ tables, selected, onSelect }: {
  tables?: D1Table[] | null;
  selected: string | null;
  onSelect: (name: string) => void;
}) {
  if (!tables?.length) {
    return (
      <div class="w-52 flex-shrink-0">
        <div class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2 px-2">Tables</div>
        <div class="text-xs text-gray-400 px-2">No tables</div>
      </div>
    );
  }

  return (
    <div class="w-52 flex-shrink-0">
      <div class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2 px-2">Tables</div>
      <div class="space-y-0.5">
        {tables.map(t => (
          <button
            key={t.name}
            onClick={() => onSelect(t.name)}
            class={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors flex items-center justify-between ${
              selected === t.name
                ? "bg-ink text-white"
                : "text-gray-600 hover:bg-gray-100"
            }`}
          >
            <span class="font-mono text-xs truncate">{t.name}</span>
            <span class={`text-xs tabular-nums ${selected === t.name ? "text-gray-300" : "text-gray-400"}`}>{t.rows}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── TableDataView ───────────────────────────────────────────────────

function TableDataView({ table, execQuery, onOpenInConsole, history, browserHistory, onRestoreHistory, initialState }: {
  table: D1Table;
  execQuery: (sql: string) => Promise<QueryResult>;
  onOpenInConsole: (sql: string) => void;
  history: ReturnType<typeof useHistory>;
  browserHistory: ReturnType<typeof useBrowserHistory>;
  onRestoreHistory: (entry: BrowserHistoryEntry) => void;
  initialState: RestoredState | null;
}) {
  const schema = parseCreateTable(table.sql);
  const pkCols = schema.primaryKeys.length > 0 ? schema.primaryKeys : ["rowid"];
  const needsRowid = schema.primaryKeys.length === 0;

  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [totalCount, setTotalCount] = useState<number>(table.rows);
  const [offset, setOffset] = useState(0);
  const [sortCol, setSortCol] = useState<string | null>(initialState?.sortCol ?? null);
  const [sortDir, setSortDir] = useState<SortDir>(initialState?.sortDir ?? "ASC");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showInsert, setShowInsert] = useState(false);
  const [filters, setFilters] = useState<Record<string, string>>(initialState?.filters ?? {});
  const [showFilters, setShowFilters] = useState(initialState ? Object.keys(initialState.filters).length > 0 : false);
  const [showFilterHelp, setShowFilterHelp] = useState(false);
  const [showBrowserHistory, setShowBrowserHistory] = useState(false);

  const filtersKey = JSON.stringify(filters);
  const loadGenRef = useRef(0);

  const loadData = useCallback(async (newOffset: number) => {
    const gen = ++loadGenRef.current;
    setLoading(true);
    setError(null);
    try {
      const selectCols = needsRowid ? `rowid, *` : `*`;
      const where = buildWhereClause(filters);
      const orderBy = sortCol ? ` ORDER BY ${quoteId(sortCol)} ${sortDir}` : "";
      const dataSql = `SELECT ${selectCols} FROM ${quoteId(table.name)}${where}${orderBy} LIMIT ${PAGE_SIZE} OFFSET ${newOffset}`;
      const countSql = `SELECT COUNT(*) as cnt FROM ${quoteId(table.name)}${where}`;

      const [dataRes, countRes] = await Promise.all([
        execQuery(dataSql),
        execQuery(countSql),
      ]);

      if (gen !== loadGenRef.current) return;

      if (dataRes.error) {
        setError(dataRes.error);
        return;
      }

      setRows(dataRes.rows);
      setColumns(dataRes.columns);
      setOffset(newOffset);
      if (countRes.rows?.[0]) {
        setTotalCount(Number(countRes.rows[0].cnt));
      }
      // Save to browser history when there are filters or sort
      if (where || orderBy) {
        browserHistory.add({ table: table.name, filters, sortCol, sortDir });
      }
    } catch (e: any) {
      if (gen !== loadGenRef.current) return;
      setError(e.message ?? String(e));
    } finally {
      if (gen === loadGenRef.current) setLoading(false);
    }
  }, [table.name, sortCol, sortDir, filtersKey, needsRowid, execQuery]);

  // Reset filters when switching tables
  useEffect(() => {
    setFilters({});
    setShowFilters(false);
    setSortCol(null);
  }, [table.name]);

  // Reload when table, sort, or filters change
  useEffect(() => {
    setOffset(0);
    setShowInsert(false);
    loadData(0);
  }, [table.name, sortCol, sortDir, filtersKey]);

  const handleSort = (col: string) => {
    if (sortCol === col) {
      setSortDir(d => d === "ASC" ? "DESC" : "ASC");
    } else {
      setSortCol(col);
      setSortDir("ASC");
    }
  };

  const handleUpdate = async (row: Record<string, unknown>, col: string, value: unknown) => {
    const where = pkCols.map(pk => `${quoteId(pk)} = ${sqlLiteral(row[pk])}`).join(" AND ");
    const sql = `UPDATE ${quoteId(table.name)} SET ${quoteId(col)} = ${sqlLiteral(value)} WHERE ${where}`;
    try {
      const res = await execQuery(sql);
      if (res.error) {
        setError(res.error);
        return;
      }
      await loadData(offset);
    } catch (e: any) {
      setError(e.message ?? String(e));
    }
  };

  const handleDelete = async (row: Record<string, unknown>) => {
    if (!confirm("Delete this row?")) return;
    const where = pkCols.map(pk => `${quoteId(pk)} = ${sqlLiteral(row[pk])}`).join(" AND ");
    const sql = `DELETE FROM ${quoteId(table.name)} WHERE ${where}`;
    try {
      const res = await execQuery(sql);
      if (res.error) {
        setError(res.error);
        return;
      }
      await loadData(offset);
    } catch (e: any) {
      setError(e.message ?? String(e));
    }
  };

  const handleInsert = async (values: Record<string, unknown>) => {
    const cols = Object.keys(values);
    const vals = cols.map(c => sqlLiteral(values[c]));
    const sql = `INSERT INTO ${quoteId(table.name)} (${cols.map(quoteId).join(", ")}) VALUES (${vals.join(", ")})`;
    try {
      const res = await execQuery(sql);
      if (res.error) {
        setError(res.error);
        return;
      }
      setShowInsert(false);
      await loadData(offset);
    } catch (e: any) {
      setError(e.message ?? String(e));
    }
  };

  // Columns to display (hide rowid if it was added just for PK tracking)
  const displayCols = columns.filter(c => !(needsRowid && c === "rowid"));
  const activeFilterCount = Object.values(filters).filter(v => v.trim()).length;

  // Current query SQL (for display / open-in-console)
  const where = buildWhereClause(filters);
  const orderBy = sortCol ? ` ORDER BY ${quoteId(sortCol)} ${sortDir}` : "";
  const currentSql = `SELECT * FROM ${quoteId(table.name)}${where}${orderBy}`;

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;
  const rangeStart = totalCount === 0 ? 0 : offset + 1;
  const rangeEnd = Math.min(offset + PAGE_SIZE, totalCount);

  return (
    <div>
      {/* Toolbar */}
      <div class="flex items-center justify-between mb-4">
        <div class="flex items-center gap-3">
          <h3 class="text-lg font-bold font-mono">{table.name}</h3>
          <span class="text-xs text-gray-400 tabular-nums">{totalCount} row(s)</span>
        </div>
        <div class="flex items-center gap-2">
          <button
            onClick={() => setShowFilters(v => !v)}
            class={`rounded-md px-3 py-1.5 text-sm font-medium transition-all ${
              showFilters || activeFilterCount > 0
                ? "bg-ink text-white"
                : "bg-white border border-gray-200 text-gray-500 hover:bg-gray-50"
            }`}
          >
            Filter{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
          </button>
          <button
            onClick={() => setShowFilterHelp(true)}
            class="rounded-md w-7 h-7 text-sm font-bold bg-white border border-gray-200 text-gray-400 hover:text-gray-600 hover:bg-gray-50 transition-all"
            title="Filter syntax help"
          >
            ?
          </button>
          <button
            onClick={() => setShowBrowserHistory(v => !v)}
            class={`rounded-md px-3 py-1.5 text-sm font-medium transition-all ${
              showBrowserHistory
                ? "bg-ink text-white"
                : "bg-white border border-gray-200 text-gray-500 hover:bg-gray-50"
            }`}
          >
            History{browserHistory.entries.length > 0 ? ` (${browserHistory.entries.length})` : ""}
          </button>
          <button
            onClick={() => setShowInsert(!showInsert)}
            class={`rounded-md px-3 py-1.5 text-sm font-medium transition-all ${
              showInsert
                ? "bg-gray-200 text-gray-600"
                : "bg-ink text-white hover:bg-ink-muted"
            }`}
          >
            {showInsert ? "Cancel" : "+ Add Row"}
          </button>
          <button
            onClick={() => loadData(offset)}
            disabled={loading}
            class="rounded-md px-3 py-1.5 text-sm font-medium bg-white border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-40 transition-all"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Current SQL */}
      <div
        onClick={() => onOpenInConsole(currentSql)}
        class="mb-4 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg flex items-center gap-2 cursor-pointer hover:bg-gray-100 hover:border-gray-300 transition-colors group"
        title="Open in SQL Console"
      >
        <code class="flex-1 text-xs font-mono text-gray-500 truncate">{currentSql}</code>
        <span class="text-xs text-gray-300 group-hover:text-gray-500 transition-colors flex-shrink-0">&rarr; SQL Console</span>
      </div>

      {/* Browser history */}
      {showBrowserHistory && (
        <BrowserHistoryPanel
          entries={browserHistory.entries}
          currentTable={table.name}
          onSelect={(entry) => { onRestoreHistory(entry); setShowBrowserHistory(false); }}
          onClear={browserHistory.clear}
        />
      )}

      {/* Error banner */}
      {error && (
        <div class="bg-red-50 text-red-600 p-3 rounded-lg text-sm font-medium mb-4 flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} class="text-red-400 hover:text-red-600 ml-3 text-xs">dismiss</button>
        </div>
      )}

      {/* Data table */}
      <div class="bg-white rounded-lg border border-gray-200 overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-gray-100">
              {displayCols.map(col => (
                <th
                  key={col}
                  onClick={() => handleSort(col)}
                  class="text-left px-4 py-2.5 font-medium text-xs text-gray-400 uppercase tracking-wider font-mono cursor-pointer hover:text-gray-600 select-none"
                >
                  {col}
                  {sortCol === col && (
                    <span class="ml-1">{sortDir === "ASC" ? "\u2191" : "\u2193"}</span>
                  )}
                </th>
              ))}
              <th class="w-16 px-4 py-2.5"></th>
            </tr>
            {showFilters && (
              <FilterRow
                columns={displayCols}
                filters={filters}
                onFilterChange={(col, val) => setFilters(f => {
                  const next = { ...f };
                  if (val) next[col] = val;
                  else delete next[col];
                  return next;
                })}
                onClearAll={() => setFilters({})}
              />
            )}
          </thead>
          <tbody>
            {showInsert && (
              <InsertRowForm
                schema={schema}
                displayCols={displayCols}
                onSave={handleInsert}
                onCancel={() => setShowInsert(false)}
              />
            )}
            {loading && rows.length === 0 ? (
              <tr>
                <td colSpan={displayCols.length + 1} class="px-4 py-8 text-center text-gray-400 text-sm">Loading...</td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={displayCols.length + 1} class="px-4 py-8 text-center text-gray-400 text-sm">No rows</td>
              </tr>
            ) : (
              rows.map((row, i) => (
                <tr key={i} class="group border-b border-gray-50 last:border-0 hover:bg-gray-50/50 transition-colors">
                  {displayCols.map(col => (
                    <td key={col} class="px-4 py-0">
                      <EditableCell
                        value={row[col]}
                        onSave={(v) => handleUpdate(row, col, v)}
                      />
                    </td>
                  ))}
                  <td class="px-4 py-2 text-right">
                    <button
                      onClick={() => handleDelete(row)}
                      class="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-600 text-xs font-medium rounded-md px-2 py-1 hover:bg-red-50 transition-all"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div class="flex items-center justify-between mt-4">
        <span class="text-xs text-gray-400 tabular-nums">{rangeStart}–{rangeEnd} of {totalCount}</span>
        <div class="flex items-center gap-2">
          <button
            onClick={() => loadData(offset - PAGE_SIZE)}
            disabled={offset === 0 || loading}
            class="rounded-md px-3 py-1.5 text-xs font-medium bg-white border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            Prev
          </button>
          <span class="text-xs text-gray-400 tabular-nums">{currentPage} / {totalPages}</span>
          <button
            onClick={() => loadData(offset + PAGE_SIZE)}
            disabled={offset + PAGE_SIZE >= totalCount || loading}
            class="rounded-md px-3 py-1.5 text-xs font-medium bg-white border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            Next
          </button>
        </div>
      </div>

      {showFilterHelp && <FilterHelpModal onClose={() => setShowFilterHelp(false)} />}
    </div>
  );
}

// ─── HistoryPanel ────────────────────────────────────────────────────

function HistoryPanel({ entries, onSelect, onClear }: {
  entries: HistoryEntry[];
  onSelect: (entry: HistoryEntry) => void;
  onClear: () => void;
}) {
  if (entries.length === 0) {
    return (
      <div class="bg-white rounded-lg border border-gray-200 p-5 mb-6 text-center text-sm text-gray-400">
        No history yet
      </div>
    );
  }

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return isToday ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
  };

  return (
    <div class="bg-white rounded-lg border border-gray-200 mb-6 overflow-hidden">
      <div class="flex items-center justify-between px-4 py-2.5 border-b border-gray-100 bg-gray-50/50">
        <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Query History</span>
        <button onClick={onClear} class="text-xs text-gray-400 hover:text-red-500 transition-colors">Clear all</button>
      </div>
      <div class="max-h-64 overflow-y-auto divide-y divide-gray-50">
        {entries.map((entry, i) => (
          <button
            key={i}
            onClick={() => onSelect(entry)}
            class="w-full text-left px-4 py-2.5 hover:bg-gray-50 transition-colors flex items-center gap-3 group"
          >
            <code class="flex-1 text-xs font-mono text-gray-600 truncate group-hover:text-ink transition-colors">{entry.sql}</code>
            <span class="text-[10px] text-gray-300 tabular-nums flex-shrink-0">{formatTime(entry.ts)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── BrowserHistoryPanel ─────────────────────────────────────────────

function BrowserHistoryPanel({ entries, currentTable, onSelect, onClear }: {
  entries: BrowserHistoryEntry[];
  currentTable: string;
  onSelect: (entry: BrowserHistoryEntry) => void;
  onClear: () => void;
}) {
  if (entries.length === 0) {
    return (
      <div class="bg-white rounded-lg border border-gray-200 p-5 mb-4 text-center text-sm text-gray-400">
        No history yet — filter or sort a table to save an entry
      </div>
    );
  }

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return isToday ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
  };

  const formatFilters = (filters: Record<string, string>) => {
    const parts = Object.entries(filters).filter(([, v]) => v.trim());
    if (parts.length === 0) return null;
    return parts.map(([col, val]) => `${col}: ${val}`).join(", ");
  };

  return (
    <div class="bg-white rounded-lg border border-gray-200 mb-4 overflow-hidden">
      <div class="flex items-center justify-between px-4 py-2.5 border-b border-gray-100 bg-gray-50/50">
        <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">Browser History</span>
        <button onClick={onClear} class="text-xs text-gray-400 hover:text-red-500 transition-colors">Clear all</button>
      </div>
      <div class="max-h-64 overflow-y-auto divide-y divide-gray-50">
        {entries.map((entry, i) => {
          const filterStr = formatFilters(entry.filters);
          const isSameTable = entry.table === currentTable;
          return (
            <button
              key={i}
              onClick={() => onSelect(entry)}
              class="w-full text-left px-4 py-2.5 hover:bg-gray-50 transition-colors group"
            >
              <div class="flex items-center gap-2 mb-1">
                <span class={`font-mono text-xs font-semibold ${isSameTable ? "text-ink" : "text-accent-olive"}`}>{entry.table}</span>
                <span class="text-[10px] text-gray-300 tabular-nums">{formatTime(entry.ts)}</span>
              </div>
              <div class="flex flex-wrap gap-x-3 gap-y-0.5">
                {filterStr && (
                  <span class="text-xs text-gray-500">
                    <span class="text-gray-400">filter:</span>{" "}
                    <span class="font-mono">{filterStr}</span>
                  </span>
                )}
                {entry.sortCol && (
                  <span class="text-xs text-gray-500">
                    <span class="text-gray-400">order:</span>{" "}
                    <span class="font-mono">{entry.sortCol} {entry.sortDir}</span>
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── FilterRow ───────────────────────────────────────────────────────

function FilterRow({ columns, filters, onFilterChange, onClearAll }: {
  columns: string[];
  filters: Record<string, string>;
  onFilterChange: (col: string, value: string) => void;
  onClearAll: () => void;
}) {
  const debounceRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const hasAny = Object.values(filters).some(v => v.trim());

  const handleInput = (col: string, value: string) => {
    clearTimeout(debounceRef.current[col]);
    debounceRef.current[col] = setTimeout(() => {
      onFilterChange(col, value);
    }, 400);
  };

  return (
    <tr class="border-b border-gray-100 bg-gray-50/50">
      {columns.map(col => (
        <th key={col} class="px-4 py-1.5">
          <input
            type="text"
            placeholder="filter..."
            defaultValue={filters[col] ?? ""}
            onInput={e => handleInput(col, (e.target as HTMLInputElement).value)}
            onKeyDown={e => {
              if (e.key === "Enter") {
                clearTimeout(debounceRef.current[col]);
                onFilterChange(col, (e.target as HTMLInputElement).value);
              }
            }}
            class="w-full bg-white border border-gray-200 rounded px-2 py-1 font-mono text-xs font-normal outline-none focus:border-gray-300 focus:ring-1 focus:ring-gray-200 transition-all"
          />
        </th>
      ))}
      <th class="px-4 py-1.5">
        {hasAny && (
          <button
            onClick={onClearAll}
            class="text-xs text-gray-400 hover:text-gray-600 transition-colors whitespace-nowrap"
            title="Clear all filters"
          >
            clear
          </button>
        )}
      </th>
    </tr>
  );
}

// ─── FilterHelpModal ─────────────────────────────────────────────────

const FILTER_HELP: { expr: string; desc: string; example: string }[] = [
  { expr: "text", desc: "Contains (case-insensitive match)", example: "alice" },
  { expr: "=value", desc: "Exact match", example: "=pending" },
  { expr: "!value", desc: "Not equal", example: "!cancelled" },
  { expr: ">value", desc: "Greater than", example: ">100" },
  { expr: "<value", desc: "Less than", example: "<50" },
  { expr: ">=value", desc: "Greater or equal", example: ">=10.5" },
  { expr: "<=value", desc: "Less or equal", example: "<=99" },
  { expr: "%pat%", desc: "LIKE pattern (% = any, _ = one char)", example: "%@example%" },
  { expr: "NULL", desc: "Value is NULL", example: "NULL" },
  { expr: "!NULL", desc: "Value is not NULL", example: "!NULL" },
];

function FilterHelpModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div class="bg-white rounded-xl shadow-xl border border-gray-200 w-full max-w-md mx-4">
        <div class="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h3 class="text-sm font-bold text-ink">Filter Syntax</h3>
          <button onClick={onClose} class="text-gray-400 hover:text-gray-600 text-lg leading-none transition-colors">&times;</button>
        </div>
        <div class="px-5 py-3">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-xs text-gray-400 uppercase tracking-wider">
                <th class="text-left py-1.5 font-medium">Expression</th>
                <th class="text-left py-1.5 font-medium">Description</th>
                <th class="text-left py-1.5 font-medium">Example</th>
              </tr>
            </thead>
            <tbody>
              {FILTER_HELP.map(h => (
                <tr key={h.expr} class="border-t border-gray-50">
                  <td class="py-1.5 pr-3"><code class="text-xs font-mono bg-gray-50 px-1.5 py-0.5 rounded text-ink">{h.expr}</code></td>
                  <td class="py-1.5 pr-3 text-xs text-gray-500">{h.desc}</td>
                  <td class="py-1.5"><code class="text-xs font-mono text-gray-400">{h.example}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div class="px-5 py-3 border-t border-gray-100 text-xs text-gray-400">
          Filters apply per column. Multiple column filters combine with AND.
        </div>
      </div>
    </div>
  );
}

// ─── EditableCell ────────────────────────────────────────────────────

function EditableCell({ value, onSave }: { value: unknown; onSave: (v: unknown) => void }) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [isNull, setIsNull] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const startEdit = () => {
    setIsNull(value === null);
    setEditValue(value === null ? "" : String(value));
    setEditing(true);
  };

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const save = () => {
    const newValue = isNull ? null : editValue;
    setEditing(false);
    // Only save if value actually changed
    if (newValue !== (value === null ? null : String(value))) {
      onSave(newValue);
    }
  };

  const cancel = () => {
    setEditing(false);
  };

  if (editing) {
    return (
      <div class="flex items-center gap-1 py-1">
        <input
          ref={inputRef}
          type="text"
          value={isNull ? "" : editValue}
          disabled={isNull}
          onInput={e => setEditValue((e.target as HTMLInputElement).value)}
          onKeyDown={e => {
            if (e.key === "Enter") save();
            else if (e.key === "Escape") cancel();
          }}
          class={`w-full bg-gray-50 border border-gray-300 rounded px-2 py-1 font-mono text-xs outline-none focus:border-ink focus:ring-1 focus:ring-gray-200 ${isNull ? "opacity-40" : ""}`}
        />
        <button
          onClick={() => { setIsNull(!isNull); if (!isNull) setEditValue(""); }}
          title={isNull ? "Set to value" : "Set to NULL"}
          class={`flex-shrink-0 rounded px-1.5 py-1 text-xs font-bold transition-colors ${
            isNull ? "bg-amber-100 text-amber-700" : "bg-gray-100 text-gray-400 hover:bg-gray-200"
          }`}
        >
          N
        </button>
      </div>
    );
  }

  return (
    <div
      onClick={startEdit}
      class="cursor-pointer font-mono text-xs py-2 min-h-[2rem] flex items-center"
    >
      {value === null ? (
        <span class="text-gray-300 italic">NULL</span>
      ) : (
        <span class="truncate max-w-xs" title={String(value)}>{String(value)}</span>
      )}
    </div>
  );
}

// ─── InsertRowForm ───────────────────────────────────────────────────

function InsertRowForm({ schema, displayCols, onSave, onCancel }: {
  schema: TableSchema;
  displayCols: string[];
  onSave: (values: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [nulls, setNulls] = useState<Record<string, boolean>>(() => {
    const n: Record<string, boolean> = {};
    for (const col of schema.columns) {
      // Default autoincrement PKs to NULL
      if (col.autoIncrement) n[col.name] = true;
    }
    return n;
  });

  const handleSave = () => {
    const result: Record<string, unknown> = {};
    for (const col of displayCols) {
      const colInfo = schema.columns.find(c => c.name === col);
      if (colInfo?.autoIncrement && nulls[col]) continue; // omit autoincrement columns set to NULL
      if (nulls[col]) {
        result[col] = null;
      } else {
        result[col] = values[col] ?? "";
      }
    }
    onSave(result);
  };

  return (
    <tr class="border-b border-emerald-100 bg-emerald-50/30">
      {displayCols.map(col => {
        const colInfo = schema.columns.find(c => c.name === col);
        const isAutoInc = colInfo?.autoIncrement ?? false;
        const isNullVal = nulls[col] ?? false;
        return (
          <td key={col} class="px-4 py-2">
            <div class="flex items-center gap-1">
              <input
                type="text"
                value={isNullVal ? "" : (values[col] ?? "")}
                disabled={isNullVal}
                placeholder={isAutoInc ? "auto" : colInfo?.type ?? ""}
                onInput={e => setValues(v => ({ ...v, [col]: (e.target as HTMLInputElement).value }))}
                onKeyDown={e => { if (e.key === "Enter") handleSave(); else if (e.key === "Escape") onCancel(); }}
                class={`w-full bg-white border border-gray-200 rounded px-2 py-1 font-mono text-xs outline-none focus:border-ink focus:ring-1 focus:ring-gray-200 ${isNullVal ? "opacity-40" : ""}`}
              />
              <button
                onClick={() => setNulls(n => ({ ...n, [col]: !n[col] }))}
                title={isNullVal ? "Set to value" : "Set to NULL"}
                class={`flex-shrink-0 rounded px-1.5 py-1 text-xs font-bold transition-colors ${
                  isNullVal ? "bg-amber-100 text-amber-700" : "bg-gray-100 text-gray-400 hover:bg-gray-200"
                }`}
              >
                N
              </button>
            </div>
          </td>
        );
      })}
      <td class="px-4 py-2">
        <div class="flex items-center gap-1">
          <button
            onClick={handleSave}
            class="rounded px-2 py-1 text-xs font-medium bg-emerald-500 text-white hover:bg-emerald-600 transition-colors"
          >
            Save
          </button>
          <button
            onClick={onCancel}
            class="rounded px-2 py-1 text-xs font-medium text-gray-400 hover:text-gray-600 transition-colors"
          >
            Cancel
          </button>
        </div>
      </td>
    </tr>
  );
}

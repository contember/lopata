import { useState, useEffect } from "preact/hooks";
import { api } from "../lib";
import { EmptyState, Breadcrumb, Table, PageHeader, TableLink } from "../components";

interface D1Database {
  name: string;
  tables: number;
}

interface D1Table {
  name: string;
  sql: string;
  rows: number;
}

interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  count: number;
  message?: string;
  error?: string;
}

export function D1View({ route }: { route: string }) {
  const parts = route.split("/").filter(Boolean);
  if (parts.length === 1) return <D1DatabaseList />;
  if (parts.length >= 2) return <D1DatabaseDetail dbName={decodeURIComponent(parts[1]!)} />;
  return null;
}

function D1DatabaseList() {
  const [databases, setDatabases] = useState<D1Database[]>([]);

  useEffect(() => {
    api<D1Database[]>("/d1").then(setDatabases);
  }, []);

  return (
    <div class="p-8">
      <PageHeader title="D1 Databases" subtitle={`${databases.length} database(s)`} />
      {databases.length === 0 ? (
        <EmptyState message="No D1 databases found" />
      ) : (
        <Table
          headers={["Database", "Tables"]}
          rows={databases.map(db => [
            <TableLink href={`#/d1/${encodeURIComponent(db.name)}`}>{db.name}</TableLink>,
            <span class="font-bold text-lg">{db.tables}</span>,
          ])}
        />
      )}
    </div>
  );
}

function D1DatabaseDetail({ dbName }: { dbName: string }) {
  const [tables, setTables] = useState<D1Table[]>([]);
  const [sql, setSql] = useState("");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    api<D1Table[]>(`/d1/${encodeURIComponent(dbName)}/tables`).then(setTables);
  }, [dbName]);

  const runQuery = async () => {
    if (!sql.trim()) return;
    setRunning(true);
    setResult(null);
    try {
      const res = await api<QueryResult>(`/d1/${encodeURIComponent(dbName)}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql }),
      });
      setResult(res);
    } catch (err) {
      setResult({ columns: [], rows: [], count: 0, error: String(err) });
    }
    setRunning(false);
  };

  return (
    <div class="p-8">
      <Breadcrumb items={[{ label: "D1", href: "#/d1" }, { label: dbName }]} />

      {/* Tables */}
      <div class="mb-8">
        <h3 class="text-lg font-bold mb-4">Tables</h3>
        {tables.length === 0 ? (
          <EmptyState message="No tables found" />
        ) : (
          <Table
            headers={["Table", "Rows", "Schema"]}
            rows={tables.map(t => [
              <button
                onClick={() => setSql(`SELECT * FROM "${t.name}" LIMIT 100`)}
                class="text-ink font-medium hover:text-accent-olive transition-colors font-mono text-xs"
              >
                {t.name}
              </button>,
              <span class="font-bold">{t.rows}</span>,
              <pre class="text-xs text-gray-400 max-w-lg truncate font-mono">{t.sql}</pre>,
            ])}
          />
        )}
      </div>

      {/* SQL Console */}
      <div class="bg-white rounded-card shadow-card p-6 mb-6">
        <h3 class="text-lg font-bold mb-4">SQL Console</h3>
        <textarea
          value={sql}
          onInput={e => setSql((e.target as HTMLTextAreaElement).value)}
          onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) runQuery(); }}
          placeholder="SELECT * FROM ..."
          class="w-full bg-surface-raised border-none rounded-2xl px-5 py-4 font-mono text-sm outline-none min-h-[100px] resize-y focus:bg-surface focus:shadow-focus-soft transition-all mb-4"
        />
        <div class="flex items-center gap-3">
          <button
            onClick={runQuery}
            disabled={running || !sql.trim()}
            class="rounded-full px-6 py-2.5 text-sm font-semibold bg-ink text-white hover:bg-ink-muted disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            {running ? "Running..." : "Run Query"}
          </button>
          <span class="text-xs text-gray-400 font-medium">Ctrl+Enter to run</span>
        </div>
      </div>

      {/* Results */}
      {result && (
        <div>
          {result.error ? (
            <div class="bg-red-50 text-red-600 p-5 rounded-card text-sm font-medium">
              {result.error}
            </div>
          ) : result.message ? (
            <div class="bg-emerald-50 text-emerald-700 p-5 rounded-card text-sm font-medium">
              {result.message}
            </div>
          ) : result.columns.length > 0 ? (
            <div>
              <div class="text-sm text-gray-400 mb-3 font-medium">{result.count} row(s)</div>
              <div class="bg-white rounded-card shadow-card p-5 overflow-x-auto">
                <table class="w-full text-sm" style="border-collapse: separate; border-spacing: 0 6px;">
                  <thead>
                    <tr>
                      {result.columns.map(col => (
                        <th key={col} class="text-left px-5 pb-2 font-medium text-xs text-gray-400 uppercase tracking-wider font-mono">{col}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row, i) => (
                      <tr key={i} class="group">
                        {result.columns.map((col, j) => (
                          <td
                            key={col}
                            class={`px-5 py-3.5 bg-surface-raised group-hover:bg-surface-hover transition-colors font-mono text-xs ${
                              j === 0 ? "rounded-l-2xl" : ""
                            } ${j === result.columns.length - 1 ? "rounded-r-2xl" : ""}`}
                          >
                            {row[col] === null ? <span class="text-gray-300 italic">NULL</span> : String(row[col])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

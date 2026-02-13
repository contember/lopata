import { useState, useEffect } from "preact/hooks";
import { api } from "../lib";
import { EmptyState, Breadcrumb, Table } from "./kv";

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
      <h1 class="text-2xl font-bold mb-6">D1 Databases</h1>
      {databases.length === 0 ? (
        <EmptyState message="No D1 databases found" />
      ) : (
        <Table
          headers={["Database", "Tables"]}
          rows={databases.map(db => [
            <a href={`#/d1/${encodeURIComponent(db.name)}`} class="text-orange-600 dark:text-orange-400 hover:underline">{db.name}</a>,
            db.tables,
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
        <h3 class="text-lg font-semibold mb-3">Tables</h3>
        {tables.length === 0 ? (
          <EmptyState message="No tables found" />
        ) : (
          <Table
            headers={["Table", "Rows", "Schema"]}
            rows={tables.map(t => [
              <button
                onClick={() => setSql(`SELECT * FROM "${t.name}" LIMIT 100`)}
                class="text-orange-600 dark:text-orange-400 hover:underline font-mono text-xs"
              >
                {t.name}
              </button>,
              t.rows,
              <pre class="text-xs text-gray-500 max-w-lg truncate">{t.sql}</pre>,
            ])}
          />
        )}
      </div>

      {/* SQL Console */}
      <div class="mb-6">
        <h3 class="text-lg font-semibold mb-3">SQL Console</h3>
        <div class="flex gap-2 mb-3">
          <textarea
            value={sql}
            onInput={e => setSql((e.target as HTMLTextAreaElement).value)}
            onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) runQuery(); }}
            placeholder="SELECT * FROM ..."
            class="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-md bg-white dark:bg-gray-900 font-mono text-sm min-h-[80px] resize-y"
          />
        </div>
        <button
          onClick={runQuery}
          disabled={running || !sql.trim()}
          class="px-4 py-2 bg-orange-600 text-white rounded-md text-sm hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {running ? "Running..." : "Run Query"}
        </button>
        <span class="ml-2 text-xs text-gray-400">Ctrl+Enter to run</span>
      </div>

      {/* Results */}
      {result && (
        <div>
          {result.error ? (
            <div class="bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400 p-4 rounded text-sm">
              {result.error}
            </div>
          ) : result.message ? (
            <div class="bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-400 p-4 rounded text-sm">
              {result.message}
            </div>
          ) : result.columns.length > 0 ? (
            <div>
              <div class="text-sm text-gray-500 mb-2">{result.count} row(s)</div>
              <div class="overflow-x-auto border border-gray-200 dark:border-gray-800 rounded-lg">
                <table class="w-full text-sm">
                  <thead class="bg-gray-50 dark:bg-gray-900">
                    <tr>
                      {result.columns.map(col => (
                        <th key={col} class="text-left px-4 py-2 font-medium text-gray-500 dark:text-gray-400 font-mono text-xs">{col}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-gray-100 dark:divide-gray-800">
                    {result.rows.map((row, i) => (
                      <tr key={i} class="hover:bg-gray-50 dark:hover:bg-gray-900/50">
                        {result.columns.map(col => (
                          <td key={col} class="px-4 py-2 font-mono text-xs">
                            {row[col] === null ? <span class="text-gray-400 italic">NULL</span> : String(row[col])}
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

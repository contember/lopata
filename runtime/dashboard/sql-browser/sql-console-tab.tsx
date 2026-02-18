import { useState, useEffect } from "preact/hooks";
import type { QueryResult } from "../rpc/types";
import type { useHistory } from "./hooks";
import { HistoryPanel } from "./history-panels";

export function SqlConsoleTab({ execQuery, initialSql, history }: {
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
      <div class="bg-panel rounded-lg border border-border p-5 mb-6">
        <textarea
          value={sql}
          onInput={e => setSql((e.target as HTMLTextAreaElement).value)}
          onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run(); }}
          placeholder="SELECT * FROM ..."
          class="w-full bg-panel-secondary border border-border rounded-lg px-4 py-3 font-mono text-sm outline-none min-h-[100px] resize-y focus:border-border focus:ring-1 focus:ring-border transition-all mb-4"
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
                : "bg-panel border border-border text-text-secondary hover:bg-panel-hover"
            }`}
          >
            History{history.entries.length > 0 ? ` (${history.entries.length})` : ""}
          </button>
          <span class="text-xs text-text-muted">Ctrl+Enter to run</span>
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
              <div class="text-sm text-text-muted mb-3 font-medium">{result.count} row(s)</div>
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
    <div class="bg-panel rounded-lg border border-border overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-border-subtle">
            {columns.map(col => (
              <th key={col} class="text-left px-4 py-2.5 font-medium text-xs text-text-muted uppercase tracking-wider font-mono">{col}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} class="group border-b border-border-row last:border-0 hover:bg-panel-hover/50 transition-colors">
              {columns.map(col => (
                <td key={col} class="px-4 py-2.5 font-mono text-xs">
                  {row[col] === null ? <span class="text-text-dim italic">NULL</span> : String(row[col])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

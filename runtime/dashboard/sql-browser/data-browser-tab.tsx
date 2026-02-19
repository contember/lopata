import { useState, useEffect } from "preact/hooks";
import type { D1Table, QueryResult } from "../rpc/types";
import { navigate, replaceRoute } from "../lib";
import type { SortDir, BrowserHistoryEntry } from "./types";
import type { useHistory, useBrowserHistory } from "./hooks";
import { TableDataView } from "./table-data-view";
import { TableSidebar } from "./table-sidebar";

export function DataBrowserTab({ tables, execQuery, onOpenInConsole, history, browserHistory, historyScope, basePath, routeTable, routeQuery }: {
  tables?: D1Table[] | null;
  execQuery: (sql: string) => Promise<QueryResult>;
  onOpenInConsole: (sql: string) => void;
  history: ReturnType<typeof useHistory>;
  browserHistory: ReturnType<typeof useBrowserHistory>;
  historyScope?: string;
  basePath?: string;
  routeTable?: string | null;
  routeQuery?: URLSearchParams;
}) {
  // Table selection: URL-driven when basePath is set, local state otherwise
  const [localTable, setLocalTable] = useState<string | null>(null);
  const [localRestoredState, setLocalRestoredState] = useState<{ filters: Record<string, string>; sortCol: string | null; sortDir: SortDir } | null>(null);
  const selectedTable = basePath ? (routeTable ?? null) : localTable;

  // Auto-select first table
  useEffect(() => {
    if (!selectedTable && tables?.length) {
      if (basePath) {
        replaceRoute(basePath + "/data/" + encodeURIComponent(tables[0]!.name));
      } else {
        setLocalTable(tables[0]!.name);
      }
    }
  }, [tables, selectedTable, basePath]);

  const tableInfo = tables?.find(t => t.name === selectedTable) ?? null;

  const handleRestoreHistory = (entry: BrowserHistoryEntry) => {
    if (basePath) {
      const params = new URLSearchParams();
      for (const [col, val] of Object.entries(entry.filters)) {
        if (val.trim()) params.set("f." + col, val);
      }
      if (entry.sortCol) {
        params.set("s", entry.sortCol);
        params.set("d", entry.sortDir);
      }
      const qs = params.toString();
      navigate(basePath + "/data/" + encodeURIComponent(entry.table) + (qs ? "?" + qs : ""));
    } else {
      setLocalTable(entry.table);
      setLocalRestoredState({ filters: entry.filters, sortCol: entry.sortCol, sortDir: entry.sortDir });
    }
  };

  const handleNavigateFK = (targetTable: string, targetColumn: string, value: unknown) => {
    if (!tables?.some(t => t.name === targetTable)) return;
    if (basePath) {
      const params = new URLSearchParams();
      params.set("f." + targetColumn, `=${String(value)}`);
      navigate(basePath + "/data/" + encodeURIComponent(targetTable) + "?" + params.toString());
    } else {
      setLocalTable(targetTable);
      setLocalRestoredState({ filters: { [targetColumn]: `=${String(value)}` }, sortCol: null, sortDir: "ASC" });
    }
  };

  const handleTableSelect = (name: string) => {
    if (basePath) {
      navigate(basePath + "/data/" + encodeURIComponent(name));
    } else {
      setLocalTable(name);
      setLocalRestoredState(null);
    }
  };

  // Build effective query: from URL route or from local restored state
  const effectiveQuery = (() => {
    if (basePath) return routeQuery;
    if (!localRestoredState) return undefined;
    const params = new URLSearchParams();
    for (const [col, val] of Object.entries(localRestoredState.filters)) {
      if (val.trim()) params.set("f." + col, val);
    }
    if (localRestoredState.sortCol) {
      params.set("s", localRestoredState.sortCol);
      params.set("d", localRestoredState.sortDir);
    }
    return params;
  })();

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
            key={tableInfo.name + "?" + (effectiveQuery?.toString() ?? "")}
            table={tableInfo}
            execQuery={execQuery}
            onOpenInConsole={onOpenInConsole}
            history={history}
            browserHistory={browserHistory}
            onRestoreHistory={handleRestoreHistory}
            onNavigateFK={handleNavigateFK}
            historyScope={historyScope}
            basePath={basePath}
            routeQuery={effectiveQuery}
          />
        ) : (
          <div class="text-center py-16 text-text-muted text-sm font-medium">
            {tables?.length ? "Select a table" : "No tables found"}
          </div>
        )}
      </div>
    </div>
  );
}

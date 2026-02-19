import { useState } from "preact/hooks";
import { navigate } from "../lib";
import type { SqlBrowserProps, Tab } from "./types";
import { TABS } from "./types";
import { useHistory, useBrowserHistory } from "./hooks";
import { DataBrowserTab } from "./data-browser-tab";
import { SchemaBrowserTab } from "./schema-browser-tab";
import { SqlConsoleTab } from "./sql-console-tab";

export function SqlBrowser({ tables, execQuery, historyScope, basePath, routeTab, routeTable, routeQuery }: SqlBrowserProps) {
  const [localTab, setLocalTab] = useState<Tab>("data");
  const tab = basePath ? (routeTab ?? "data") : localTab;
  const [consoleSql, setConsoleSql] = useState("");
  const history = useHistory(historyScope);
  const browserHistory = useBrowserHistory(historyScope);

  const switchTab = (t: Tab) => {
    if (basePath) navigate(basePath + "/" + t);
    else setLocalTab(t);
  };

  const openInConsole = (sql: string) => {
    setConsoleSql(sql);
    if (basePath) navigate(basePath + "/sql");
    else setLocalTab("sql");
  };

  return (
    <div>
      {/* Tab bar */}
      <div class="flex gap-1 mb-5 border-b border-border">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => switchTab(t.key)}
            class={`px-4 py-2 text-sm font-medium border-b-2 transition-colors -mb-px ${
              tab === t.key
                ? "border-ink text-ink"
                : "border-transparent text-text-muted hover:text-text-data"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "data" && <DataBrowserTab tables={tables} execQuery={execQuery} onOpenInConsole={openInConsole} history={history} browserHistory={browserHistory} historyScope={historyScope} basePath={basePath} routeTable={routeTable} routeQuery={routeQuery} />}
      {tab === "schema" && <SchemaBrowserTab tables={tables} />}
      {tab === "sql" && <SqlConsoleTab execQuery={execQuery} initialSql={consoleSql} history={history} />}
    </div>
  );
}

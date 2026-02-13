import { useState } from "preact/hooks";
import { useQuery, useMutation } from "../rpc/hooks";
import { EmptyState, Breadcrumb, Table, PageHeader, TableLink } from "../components";

export function D1View({ route }: { route: string }) {
  const parts = route.split("/").filter(Boolean);
  if (parts.length === 1) return <D1DatabaseList />;
  if (parts.length >= 2) return <D1DatabaseDetail dbName={decodeURIComponent(parts[1]!)} />;
  return null;
}

function D1DatabaseList() {
  const { data: databases } = useQuery("d1.listDatabases");

  return (
    <div class="p-8">
      <PageHeader title="D1 Databases" subtitle={`${databases?.length ?? 0} database(s)`} />
      {!databases?.length ? (
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
  const { data: tables } = useQuery("d1.listTables", { dbName });
  const [sql, setSql] = useState("");
  const query = useMutation("d1.query");

  return (
    <div class="p-8">
      <Breadcrumb items={[{ label: "D1", href: "#/d1" }, { label: dbName }]} />

      {/* Tables */}
      <div class="mb-8">
        <h3 class="text-lg font-bold mb-4">Tables</h3>
        {!tables?.length ? (
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
          onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) query.mutate({ dbName, sql }); }}
          placeholder="SELECT * FROM ..."
          class="w-full bg-surface-raised border-none rounded-2xl px-5 py-4 font-mono text-sm outline-none min-h-[100px] resize-y focus:bg-surface focus:shadow-focus-soft transition-all mb-4"
        />
        <div class="flex items-center gap-3">
          <button
            onClick={() => query.mutate({ dbName, sql })}
            disabled={query.isLoading || !sql.trim()}
            class="rounded-full px-6 py-2.5 text-sm font-semibold bg-ink text-white hover:bg-ink-muted disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            {query.isLoading ? "Running..." : "Run Query"}
          </button>
          <span class="text-xs text-gray-400 font-medium">Ctrl+Enter to run</span>
        </div>
      </div>

      {/* Results */}
      {query.error ? (
        <div class="bg-red-50 text-red-600 p-5 rounded-card text-sm font-medium">
          {query.error.message}
        </div>
      ) : query.data ? (
        <div>
          {query.data.message ? (
            <div class="bg-emerald-50 text-emerald-700 p-5 rounded-card text-sm font-medium">
              {query.data.message}
            </div>
          ) : query.data.columns.length > 0 ? (
            <div>
              <div class="text-sm text-gray-400 mb-3 font-medium">{query.data.count} row(s)</div>
              <div class="bg-white rounded-card shadow-card p-5 overflow-x-auto">
                <table class="w-full text-sm" style="border-collapse: separate; border-spacing: 0 6px;">
                  <thead>
                    <tr>
                      {query.data.columns.map(col => (
                        <th key={col} class="text-left px-5 pb-2 font-medium text-xs text-gray-400 uppercase tracking-wider font-mono">{col}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {query.data.rows.map((row, i) => (
                      <tr key={i} class="group">
                        {query.data!.columns.map((col, j) => (
                          <td
                            key={col}
                            class={`px-5 py-3.5 bg-surface-raised group-hover:bg-surface-hover transition-colors font-mono text-xs ${
                              j === 0 ? "rounded-l-2xl" : ""
                            } ${j === query.data!.columns.length - 1 ? "rounded-r-2xl" : ""}`}
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
      ) : null}
    </div>
  );
}

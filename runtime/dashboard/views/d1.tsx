import { useState } from "preact/hooks";
import { useQuery, useMutation } from "../rpc/hooks";
import { EmptyState, Breadcrumb, Table, PageHeader, TableLink, ServiceInfo } from "../components";

export function D1View({ route }: { route: string }) {
  const parts = route.split("/").filter(Boolean);
  if (parts.length === 1) return <D1DatabaseList />;
  if (parts.length >= 2) return <D1DatabaseDetail dbName={decodeURIComponent(parts[1]!)} />;
  return null;
}

function D1DatabaseList() {
  const { data: databases } = useQuery("d1.listDatabases");
  const { data: configGroups } = useQuery("config.forService", { type: "d1" });

  const totalTables = databases?.reduce((s, db) => s + db.tables, 0) ?? 0;

  return (
    <div class="p-8 max-w-5xl mx-auto">
      <PageHeader title="D1 Databases" subtitle={`${databases?.length ?? 0} database(s)`} />
      <div class="flex gap-6 items-start">
        <div class="flex-1 min-w-0">
          {!databases?.length ? (
            <EmptyState message="No D1 databases found" />
          ) : (
            <Table
              headers={["Database", "Tables"]}
              rows={databases.map(db => [
                <TableLink href={`#/d1/${encodeURIComponent(db.name)}`}>{db.name}</TableLink>,
                <span class="tabular-nums">{db.tables}</span>,
              ])}
            />
          )}
        </div>
        <ServiceInfo
          description="Serverless SQLite databases at the edge."
          stats={[
            { label: "Databases", value: databases?.length ?? 0 },
            { label: "Tables", value: totalTables.toLocaleString() },
          ]}
          configGroups={configGroups}
          links={[
            { label: "Documentation", href: "https://developers.cloudflare.com/d1/" },
            { label: "API Reference", href: "https://developers.cloudflare.com/api/resources/d1/" },
          ]}
        />
      </div>
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
              <span class="tabular-nums">{t.rows}</span>,
              <pre class="text-xs text-gray-400 max-w-lg truncate font-mono">{t.sql}</pre>,
            ])}
          />
        )}
      </div>

      {/* SQL Console */}
      <div class="bg-white rounded-lg border border-gray-200 p-5 mb-6">
        <h3 class="text-lg font-bold mb-4">SQL Console</h3>
        <textarea
          value={sql}
          onInput={e => setSql((e.target as HTMLTextAreaElement).value)}
          onKeyDown={e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) query.mutate({ dbName, sql }); }}
          placeholder="SELECT * FROM ..."
          class="w-full bg-gray-50 border border-gray-200 rounded-lg px-4 py-3 font-mono text-sm outline-none min-h-[100px] resize-y focus:border-gray-300 focus:ring-1 focus:ring-gray-200 transition-all mb-4"
        />
        <div class="flex items-center gap-3">
          <button
            onClick={() => query.mutate({ dbName, sql })}
            disabled={query.isLoading || !sql.trim()}
            class="rounded-md px-4 py-2 text-sm font-medium bg-ink text-white hover:bg-ink-muted disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            {query.isLoading ? "Running..." : "Run Query"}
          </button>
          <span class="text-xs text-gray-400">Ctrl+Enter to run</span>
        </div>
      </div>

      {/* Results */}
      {query.error ? (
        <div class="bg-red-50 text-red-600 p-4 rounded-lg text-sm font-medium">
          {query.error.message}
        </div>
      ) : query.data ? (
        <div>
          {query.data.message ? (
            <div class="bg-emerald-50 text-emerald-700 p-4 rounded-lg text-sm font-medium">
              {query.data.message}
            </div>
          ) : query.data.columns.length > 0 ? (
            <div>
              <div class="text-sm text-gray-400 mb-3 font-medium">{query.data.count} row(s)</div>
              <div class="bg-white rounded-lg border border-gray-200 overflow-x-auto">
                <table class="w-full text-sm">
                  <thead>
                    <tr class="border-b border-gray-100">
                      {query.data.columns.map(col => (
                        <th key={col} class="text-left px-4 py-2.5 font-medium text-xs text-gray-400 uppercase tracking-wider font-mono">{col}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {query.data.rows.map((row, i) => (
                      <tr key={i} class="group border-b border-gray-50 last:border-0 hover:bg-gray-50/50 transition-colors">
                        {query.data!.columns.map((col) => (
                          <td key={col} class="px-4 py-2.5 font-mono text-xs">
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

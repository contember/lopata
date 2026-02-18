import { useQuery } from "../rpc/hooks";
import { rpc } from "../rpc/client";
import { Breadcrumb, PageHeader, Table, TableLink, ServiceInfo, EmptyState, SqlBrowser } from "../components";
import { parseHashRoute } from "../lib";
import type { Tab } from "../sql-browser/index";

export function D1View({ route }: { route: string }) {
  const { segments, query } = parseHashRoute(route);
  if (segments.length <= 1) return <D1DatabaseList />;
  const dbName = decodeURIComponent(segments[1]!);
  const rawTab = segments[2] as Tab | undefined;
  const tab: Tab = rawTab === "schema" || rawTab === "sql" ? rawTab : "data";
  const tableName = segments[3] ? decodeURIComponent(segments[3]) : null;
  const basePath = `/d1/${encodeURIComponent(dbName)}`;
  return <D1DatabaseDetail dbName={dbName} basePath={basePath} routeTab={tab} routeTable={tableName} routeQuery={query} />;
}

function D1DatabaseList() {
  const { data: databases } = useQuery("d1.listDatabases");
  const { data: configGroups } = useQuery("config.forService", { type: "d1" });

  const totalTables = databases?.reduce((s, db) => s + db.tables, 0) ?? 0;

  return (
    <div class="p-8 max-w-6xl">
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

function D1DatabaseDetail({ dbName, basePath, routeTab, routeTable, routeQuery }: {
  dbName: string;
  basePath: string;
  routeTab: Tab;
  routeTable: string | null;
  routeQuery: URLSearchParams;
}) {
  const { data: tables } = useQuery("d1.listTables", { dbName });

  return (
    <div class="p-8">
      <Breadcrumb items={[{ label: "D1", href: "#/d1" }, { label: dbName }]} />
      <SqlBrowser
        tables={tables}
        execQuery={(sql) => rpc("d1.query", { dbName, sql })}
        basePath={basePath}
        routeTab={routeTab}
        routeTable={routeTable}
        routeQuery={routeQuery}
      />
    </div>
  );
}

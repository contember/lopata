import { useQuery } from "../rpc/hooks";
import { rpc } from "../rpc/client";
import { Breadcrumb, PageHeader, Table, TableLink, ServiceInfo, EmptyState, SqlBrowser } from "../components";

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

  return (
    <div class="p-8">
      <Breadcrumb items={[{ label: "D1", href: "#/d1" }, { label: dbName }]} />
      <SqlBrowser
        tables={tables}
        execQuery={(sql) => rpc("d1.query", { dbName, sql })}
      />
    </div>
  );
}

import { formatTime } from "../lib";
import { useQuery, useMutation } from "../rpc/hooks";
import { rpc } from "../rpc/client";
import { EmptyState, Breadcrumb, Table, PageHeader, DeleteButton, TableLink, ServiceInfo, SqlBrowser } from "../components";

export function DoView({ route }: { route: string }) {
  const parts = route.split("/").filter(Boolean);
  if (parts.length === 1) return <DoNamespaceList />;
  if (parts.length === 2) return <DoInstanceList ns={decodeURIComponent(parts[1]!)} />;
  if (parts.length >= 3) return <DoInstanceDetail ns={decodeURIComponent(parts[1]!)} id={decodeURIComponent(parts[2]!)} />;
  return null;
}

function DoNamespaceList() {
  const { data: namespaces } = useQuery("do.listNamespaces");
  const { data: configGroups } = useQuery("config.forService", { type: "do" });

  const totalInstances = namespaces?.reduce((s, ns) => s + ns.count, 0) ?? 0;

  return (
    <div class="p-8 max-w-5xl mx-auto">
      <PageHeader title="Durable Objects" subtitle={`${namespaces?.length ?? 0} namespace(s)`} />
      <div class="flex gap-6 items-start">
        <div class="flex-1 min-w-0">
          {!namespaces?.length ? (
            <EmptyState message="No Durable Object namespaces found" />
          ) : (
            <Table
              headers={["Namespace", "Instances"]}
              rows={namespaces.map(ns => [
                <TableLink href={`#/do/${encodeURIComponent(ns.namespace)}`}>{ns.namespace}</TableLink>,
                <span class="tabular-nums">{ns.count}</span>,
              ])}
            />
          )}
        </div>
        <ServiceInfo
          description="Durable Objects provide strongly consistent coordination."
          stats={[
            { label: "Namespaces", value: namespaces?.length ?? 0 },
            { label: "Instances", value: totalInstances.toLocaleString() },
          ]}
          configGroups={configGroups}
          links={[
            { label: "Documentation", href: "https://developers.cloudflare.com/durable-objects/" },
            { label: "API Reference", href: "https://developers.cloudflare.com/api/resources/durable_objects/" },
          ]}
        />
      </div>
    </div>
  );
}

function DoInstanceList({ ns }: { ns: string }) {
  const { data: instances } = useQuery("do.listInstances", { ns });

  return (
    <div class="p-8">
      <Breadcrumb items={[{ label: "Durable Objects", href: "#/do" }, { label: ns }]} />
      {!instances?.length ? (
        <EmptyState message="No instances found" />
      ) : (
        <Table
          headers={["Instance ID", "Name", "Storage Keys", "Alarm"]}
          rows={instances.map(inst => [
            <TableLink href={`#/do/${encodeURIComponent(ns)}/${encodeURIComponent(inst.id)}`} mono>{inst.id}</TableLink>,
            inst.name ? <span class="text-sm">{inst.name}</span> : <span class="text-text-muted">—</span>,
            <span class="tabular-nums">{inst.key_count}</span>,
            inst.alarm ? formatTime(inst.alarm) : "—",
          ])}
        />
      )}
    </div>
  );
}

function DoInstanceDetail({ ns, id }: { ns: string; id: string }) {
  const { data, refetch } = useQuery("do.getInstance", { ns, id });
  const deleteEntry = useMutation("do.deleteEntry");
  const { data: sqlTables } = useQuery("do.listSqlTables", { ns, id });

  const handleDelete = async (key: string) => {
    if (!confirm(`Delete storage key "${key}"?`)) return;
    await deleteEntry.mutate({ ns, id, key });
    refetch();
  };

  if (!data) return <div class="p-8 text-text-muted font-medium">Loading...</div>;

  return (
    <div class="p-8">
      <Breadcrumb items={[
        { label: "Durable Objects", href: "#/do" },
        { label: ns, href: `#/do/${encodeURIComponent(ns)}` },
        { label: id.slice(0, 16) + "..." },
      ]} />
      {data.alarm && (
        <div class="mb-6 px-4 py-3 bg-panel-secondary border border-border rounded-lg text-sm font-medium text-ink">
          Alarm set for: {formatTime(data.alarm)}
        </div>
      )}
      {data.entries.length === 0 ? (
        <EmptyState message="No storage entries" />
      ) : (
        <Table
          headers={["Key", "Value", ""]}
          rows={data.entries.map(e => [
            <span class="font-mono text-xs font-medium">{e.key}</span>,
            <pre class="text-xs max-w-lg truncate font-mono">{e.value}</pre>,
            <DeleteButton onClick={() => handleDelete(e.key)} />,
          ])}
        />
      )}

      {/* SQL Storage */}
      {sqlTables && sqlTables.length > 0 && (
        <div class="mt-8">
          <SqlBrowser
            tables={sqlTables}
            execQuery={(sql) => rpc("do.sqlQuery", { ns, id, sql })}
          />
        </div>
      )}
    </div>
  );
}

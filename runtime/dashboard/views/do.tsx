import { formatTime } from "../lib";
import { useQuery, useMutation } from "../rpc/hooks";
import { EmptyState, Breadcrumb, Table, PageHeader, DeleteButton, TableLink } from "../components";

export function DoView({ route }: { route: string }) {
  const parts = route.split("/").filter(Boolean);
  if (parts.length === 1) return <DoNamespaceList />;
  if (parts.length === 2) return <DoInstanceList ns={decodeURIComponent(parts[1]!)} />;
  if (parts.length >= 3) return <DoInstanceDetail ns={decodeURIComponent(parts[1]!)} id={decodeURIComponent(parts[2]!)} />;
  return null;
}

function DoNamespaceList() {
  const { data: namespaces } = useQuery("do.listNamespaces");

  return (
    <div class="p-8">
      <PageHeader title="Durable Objects" subtitle={`${namespaces?.length ?? 0} namespace(s)`} />
      {!namespaces?.length ? (
        <EmptyState message="No Durable Object namespaces found" />
      ) : (
        <Table
          headers={["Namespace", "Instances"]}
          rows={namespaces.map(ns => [
            <TableLink href={`#/do/${encodeURIComponent(ns.namespace)}`}>{ns.namespace}</TableLink>,
            <span class="font-bold text-lg">{ns.count}</span>,
          ])}
        />
      )}
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
          headers={["Instance ID", "Storage Keys", "Alarm"]}
          rows={instances.map(inst => [
            <TableLink href={`#/do/${encodeURIComponent(ns)}/${encodeURIComponent(inst.id)}`} mono>{inst.id}</TableLink>,
            <span class="font-bold">{inst.key_count}</span>,
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

  const handleDelete = async (key: string) => {
    if (!confirm(`Delete storage key "${key}"?`)) return;
    await deleteEntry.mutate({ ns, id, key });
    refetch();
  };

  if (!data) return <div class="p-8 text-gray-400 font-medium">Loading...</div>;

  return (
    <div class="p-8">
      <Breadcrumb items={[
        { label: "Durable Objects", href: "#/do" },
        { label: ns, href: `#/do/${encodeURIComponent(ns)}` },
        { label: id.slice(0, 16) + "..." },
      ]} />
      {data.alarm && (
        <div class="mb-6 px-6 py-4 bg-accent-lime rounded-2xl text-sm font-medium text-ink shadow-lime-glow">
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
    </div>
  );
}

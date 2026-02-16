import { useQuery } from "../rpc/hooks";
import { EmptyState, Breadcrumb, Table, PageHeader, TableLink, StatusBadge, ServiceInfo } from "../components";

const CONTAINER_STATE_COLORS: Record<string, string> = {
  running: "bg-emerald-100 text-emerald-700",
  exited: "bg-gray-200 text-gray-600",
  created: "bg-accent-blue text-ink",
  paused: "bg-yellow-100 text-yellow-700",
  dead: "bg-red-100 text-red-700",
};

export function ContainersView({ route }: { route: string }) {
  const parts = route.split("/").filter(Boolean);
  if (parts.length === 1) return <ContainerList />;
  if (parts.length >= 2) return <ContainerInstanceList className={decodeURIComponent(parts[1]!)} />;
  return null;
}

function ContainerList() {
  const { data: containers } = useQuery("containers.list");
  const { data: configGroups } = useQuery("config.forService", { type: "containers" });

  const totalRunning = containers?.reduce((s, c) => s + c.runningCount, 0) ?? 0;

  return (
    <div class="p-8 max-w-5xl mx-auto">
      <PageHeader title="Containers" subtitle={`${containers?.length ?? 0} container class(es)`} />
      <div class="flex gap-6 items-start">
        <div class="flex-1 min-w-0">
          {!containers?.length ? (
            <EmptyState message="No containers configured" />
          ) : (
            <Table
              headers={["Class Name", "Image", "Max Instances", "Running"]}
              rows={containers.map(c => [
                <TableLink href={`#/containers/${encodeURIComponent(c.className)}`}>{c.className}</TableLink>,
                <span class="font-mono text-xs">{c.image}</span>,
                c.maxInstances ?? "unlimited",
                <span class={`tabular-nums font-medium ${c.runningCount > 0 ? "text-emerald-600" : ""}`}>{c.runningCount}</span>,
              ])}
            />
          )}
        </div>
        <ServiceInfo
          description="Docker-backed container instances managed as Durable Objects."
          stats={[
            { label: "Classes", value: String(containers?.length ?? 0) },
            { label: "Running", value: String(totalRunning) },
          ]}
          configGroups={configGroups}
          links={[
            { label: "Documentation", href: "https://developers.cloudflare.com/containers/" },
          ]}
        />
      </div>
    </div>
  );
}

function ContainerInstanceList({ className }: { className: string }) {
  const { data: instances } = useQuery("containers.listInstances", { className });

  return (
    <div class="p-8">
      <Breadcrumb items={[{ label: "Containers", href: "#/containers" }, { label: className }]} />
      {!instances?.length ? (
        <EmptyState message="No container instances found" />
      ) : (
        <Table
          headers={["Container Name", "State", "Ports"]}
          rows={instances.map(inst => [
            <span class="font-mono text-xs font-medium">{inst.name}</span>,
            <StatusBadge status={inst.state} colorMap={CONTAINER_STATE_COLORS} />,
            Object.keys(inst.ports).length > 0
              ? <span class="font-mono text-xs">{Object.entries(inst.ports).map(([k, v]) => `${v}->${k}`).join(", ")}</span>
              : <span class="text-gray-400">—</span>,
          ])}
        />
      )}
    </div>
  );
}

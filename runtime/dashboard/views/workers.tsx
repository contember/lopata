import { useQuery } from "../rpc/hooks";
import { EmptyState, PageHeader, Table, TableLink, StatusBadge } from "../components";

const TYPE_COLORS: Record<string, string> = {
  kv: "bg-emerald-100 text-emerald-700",
  r2: "bg-blue-100 text-blue-700",
  d1: "bg-violet-100 text-violet-700",
  do: "bg-amber-100 text-amber-700",
  queue: "bg-rose-100 text-rose-700",
  workflow: "bg-cyan-100 text-cyan-700",
  service: "bg-panel-active text-text-data",
  images: "bg-pink-100 text-pink-700",
};

export function WorkersView() {
  const { data: workers } = useQuery("workers.list");

  return (
    <div class="p-8">
      <PageHeader title="Workers" subtitle={`${workers?.length ?? 0} worker(s)`} />
      {!workers?.length ? (
        <EmptyState message="No workers configured" />
      ) : (
        <div class="space-y-8">
          {workers.map(w => (
            <div key={w.name}>
              <div class="flex items-center gap-3 mb-4">
                <span class="w-7 h-7 rounded-md bg-panel-hover flex items-center justify-center text-sm">⊡</span>
                <h2 class="text-lg font-bold text-ink">{w.name}</h2>
                {w.isMain && (
                  <span class="px-2 py-0.5 rounded-md text-xs font-medium bg-gray-900 text-white">main</span>
                )}
                <span class="text-xs text-text-muted">{w.bindings.length} binding(s)</span>
              </div>
              {w.bindings.length === 0 ? (
                <EmptyState message="No bindings configured" />
              ) : (
                <Table
                  headers={["Type", "Binding", "Target"]}
                  rows={w.bindings.map(b => [
                    <StatusBadge status={b.type} colorMap={TYPE_COLORS} />,
                    <span class="font-mono text-xs font-medium">{b.name}</span>,
                    b.href
                      ? <TableLink href={b.href}>{b.target}</TableLink>
                      : <span class="text-text-secondary">{b.target || "—"}</span>,
                  ])}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

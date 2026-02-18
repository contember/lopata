import type { OverviewData, WorkerInfo } from "../rpc/types";
import { useQuery } from "../rpc/hooks";
import { StatusBadge, KeyValueTable } from "../components";

type Card = {
  key: string;
  label: string;
  path: string;
  icon: string;
  color: string;
};

const CARD_GROUPS: { label: string; cards: Card[] }[] = [
  {
    label: "Observability",
    cards: [
      { key: "errors", label: "Errors", path: "/errors", icon: "⚠\uFE0E", color: "text-red-400" },
    ],
  },
  {
    label: "Storage",
    cards: [
      { key: "kv", label: "KV Namespaces", path: "/kv", icon: "⬡", color: "text-blue-400" },
      { key: "r2", label: "R2 Buckets", path: "/r2", icon: "◧", color: "text-violet-400" },
      { key: "d1", label: "D1 Databases", path: "/d1", icon: "⊞", color: "text-cyan-400" },
      { key: "cache", label: "Cache Names", path: "/cache", icon: "◎", color: "text-teal-400" },
    ],
  },
  {
    label: "Compute",
    cards: [
      { key: "do", label: "Durable Objects", path: "/do", icon: "⬢", color: "text-emerald-400" },
      { key: "workflows", label: "Workflows", path: "/workflows", icon: "⇶", color: "text-amber-400" },
      { key: "containers", label: "Containers", path: "/containers", icon: "▣", color: "text-indigo-400" },
      { key: "scheduled", label: "Scheduled", path: "/scheduled", icon: "⏱\uFE0E", color: "text-orange-400" },
    ],
  },
  {
    label: "Messaging",
    cards: [
      { key: "queue", label: "Queues", path: "/queue", icon: "☰", color: "text-yellow-400" },
      { key: "email", label: "Email", path: "/email", icon: "✉\uFE0E", color: "text-pink-400" },
    ],
  },
  {
    label: "AI",
    cards: [
      { key: "ai", label: "AI Requests", path: "/ai", icon: "⚡", color: "text-purple-400" },
    ],
  },
];

const BINDING_COLORS: Record<string, string> = {
  kv: "bg-blue-500/15 text-blue-400",
  r2: "bg-violet-500/15 text-violet-400",
  d1: "bg-cyan-500/15 text-cyan-400",
  do: "bg-emerald-500/15 text-emerald-400",
  queue: "bg-yellow-500/15 text-yellow-400",
  workflow: "bg-amber-500/15 text-amber-400",
  service: "bg-neutral-500/15 text-neutral-400",
  images: "bg-pink-500/15 text-pink-400",
};

export function HomeView() {
  const { data } = useQuery("overview.get");
  const { data: workers } = useQuery("workers.list");

  return (
    <div class="p-8">
      <div class="mb-8">
        <h1 class="text-2xl font-bold text-ink">Overview</h1>
        <p class="text-sm text-text-muted mt-1">Bunflare Dev Dashboard</p>
      </div>

      {!data ? (
        <div class="text-text-muted font-medium">Loading...</div>
      ) : (
        <div class="flex flex-col gap-8">
          {CARD_GROUPS.map(group => (
            <div key={group.label}>
              <h2 class="text-xs font-semibold uppercase tracking-wider text-text-muted mb-3">{group.label}</h2>
              <div class="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {group.cards.map(card => {
                  const count = data[card.key as keyof OverviewData] as number;
                  const active = count > 0;
                  return (
                    <a
                      key={card.key}
                      href={`#${card.path}`}
                      class={`block bg-panel rounded-lg border p-5 no-underline transition-colors group ${
                        active
                          ? "border-border hover:border-text-dim"
                          : "border-border-subtle opacity-50 hover:opacity-75"
                      }`}
                    >
                      <div class="flex items-center gap-3">
                        <span class={`text-3xl ${active ? card.color : "text-text-dim"}`}>{card.icon}</span>
                        <div>
                          <div class="text-2xl font-semibold text-ink">{count}</div>
                          <div class="text-sm text-text-muted">{card.label}</div>
                        </div>
                      </div>
                    </a>
                  );
                })}
              </div>
            </div>
          ))}
          {workers && workers.length > 0 && (
            <div>
              <h2 class="text-xs font-semibold uppercase tracking-wider text-text-muted mb-3">Workers</h2>
              <div class="flex flex-col gap-3">
                {workers.map((w: WorkerInfo) => (
                  <a
                    key={w.name}
                    href="#/workers"
                    class="block bg-panel rounded-lg border border-border p-4 no-underline hover:border-text-dim transition-colors"
                  >
                    <div class="flex items-center gap-2 mb-2">
                      <span class="text-sm font-semibold text-ink">{w.name}</span>
                      {w.isMain && (
                        <span class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-ink text-surface">main</span>
                      )}
                      <span class="text-xs text-text-muted">{w.bindings.length} binding(s)</span>
                    </div>
                    {w.bindings.length > 0 && (
                      <div class="flex flex-wrap gap-1.5">
                        {w.bindings.map(b => (
                          <span key={b.name} class="inline-flex items-center gap-1.5 text-xs">
                            <StatusBadge status={b.type} colorMap={BINDING_COLORS} />
                            <span class="font-mono text-text-secondary">{b.name}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </a>
                ))}
              </div>
            </div>
          )}
          <div>
            <h2 class="text-xs font-semibold uppercase tracking-wider text-text-muted mb-3">Runtime</h2>
            <div class="bg-panel rounded-lg border border-border overflow-hidden">
              <KeyValueTable data={{
                "Bun": data.runtime.bunVersion,
                "Platform": `${data.runtime.platform} / ${data.runtime.arch}`,
                "PID": String(data.runtime.pid),
                "Working Directory": data.runtime.cwd,
              }} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

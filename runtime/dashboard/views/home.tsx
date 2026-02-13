import type { OverviewData } from "../rpc/types";
import { useQuery } from "../rpc/hooks";

const CARDS = [
  { key: "kv", label: "KV Namespaces", path: "/kv", icon: "⬡", accent: "bg-accent-lime" },
  { key: "r2", label: "R2 Buckets", path: "/r2", icon: "◧", accent: "bg-accent-blue" },
  { key: "queue", label: "Queues", path: "/queue", icon: "☰", accent: "bg-accent-lime" },
  { key: "do", label: "Durable Objects", path: "/do", icon: "⬢", accent: "bg-accent-blue" },
  { key: "workflows", label: "Workflows", path: "/workflows", icon: "⇶", accent: "bg-accent-lime" },
  { key: "d1", label: "D1 Databases", path: "/d1", icon: "⊞", accent: "bg-accent-blue" },
  { key: "cache", label: "Cache Names", path: "/cache", icon: "◎", accent: "bg-accent-lime" },
] as const;

export function HomeView() {
  const { data } = useQuery("overview.get");

  return (
    <div class="p-8">
      <div class="mb-8">
        <div class="inline-flex items-center gap-3 bg-accent-lime rounded-full px-6 py-3 shadow-lime-glow">
          <span class="text-xl">🔥</span>
          <div>
            <div class="text-lg font-bold text-ink">Bunflare</div>
            <div class="text-xs text-ink/60 font-medium">Dev Dashboard</div>
          </div>
        </div>
      </div>

      {!data ? (
        <div class="text-gray-400 font-medium">Loading...</div>
      ) : (
        <div class="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
          {CARDS.map(card => (
            <a
              key={card.key}
              href={`#${card.path}`}
              class="block bg-white rounded-card p-6 no-underline shadow-card hover:shadow-card-hover transition-all group"
            >
              <div class={`w-11 h-11 ${card.accent} rounded-2xl flex items-center justify-center text-lg mb-4`}>
                {card.icon}
              </div>
              <div class="text-4xl font-bold text-ink mb-1">{data[card.key as keyof OverviewData]}</div>
              <div class="text-sm text-gray-400 font-medium">{card.label}</div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

import type { OverviewData } from "../rpc/types";
import { useQuery } from "../rpc/hooks";

const CARDS = [
  { key: "errors", label: "Errors", path: "/errors", icon: "⚠" },
  { key: "kv", label: "KV Namespaces", path: "/kv", icon: "⬡" },
  { key: "r2", label: "R2 Buckets", path: "/r2", icon: "◧" },
  { key: "queue", label: "Queues", path: "/queue", icon: "☰" },
  { key: "do", label: "Durable Objects", path: "/do", icon: "⬢" },
  { key: "workflows", label: "Workflows", path: "/workflows", icon: "⇶" },
  { key: "d1", label: "D1 Databases", path: "/d1", icon: "⊞" },
  { key: "cache", label: "Cache Names", path: "/cache", icon: "◎" },
] as const;

export function HomeView() {
  const { data } = useQuery("overview.get");

  return (
    <div class="p-8">
      <div class="mb-8">
        <h1 class="text-2xl font-bold text-ink">Overview</h1>
        <p class="text-sm text-gray-400 mt-1">Bunflare Dev Dashboard</p>
      </div>

      {!data ? (
        <div class="text-gray-400 font-medium">Loading...</div>
      ) : (
        <div class="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {CARDS.map(card => (
            <a
              key={card.key}
              href={`#${card.path}`}
              class="block bg-white rounded-lg border border-gray-200 p-5 no-underline hover:border-gray-300 transition-colors group"
            >
              <div class="flex items-center gap-3">
                <span class="text-3xl text-gray-300">{card.icon}</span>
                <div>
                  <div class="text-2xl font-semibold text-ink">{data[card.key as keyof OverviewData]}</div>
                  <div class="text-sm text-gray-400">{card.label}</div>
                </div>
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

import { useState, useEffect } from "preact/hooks";
import { api, navigate } from "../lib";

interface Overview {
  kv: number;
  r2: number;
  queue: number;
  do: number;
  workflows: number;
  d1: number;
  cache: number;
}

const CARDS = [
  { key: "kv", label: "KV Namespaces", path: "/kv", icon: "⬡", color: "blue" },
  { key: "r2", label: "R2 Buckets", path: "/r2", icon: "◧", color: "green" },
  { key: "queue", label: "Queues", path: "/queue", icon: "☰", color: "purple" },
  { key: "do", label: "Durable Objects", path: "/do", icon: "⬢", color: "amber" },
  { key: "workflows", label: "Workflows", path: "/workflows", icon: "⇶", color: "pink" },
  { key: "d1", label: "D1 Databases", path: "/d1", icon: "⊞", color: "cyan" },
  { key: "cache", label: "Cache Names", path: "/cache", icon: "◎", color: "slate" },
] as const;

const COLOR_MAP: Record<string, string> = {
  blue: "bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-800",
  green: "bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-400 border-green-200 dark:border-green-800",
  purple: "bg-purple-50 dark:bg-purple-950/30 text-purple-700 dark:text-purple-400 border-purple-200 dark:border-purple-800",
  amber: "bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-800",
  pink: "bg-pink-50 dark:bg-pink-950/30 text-pink-700 dark:text-pink-400 border-pink-200 dark:border-pink-800",
  cyan: "bg-cyan-50 dark:bg-cyan-950/30 text-cyan-700 dark:text-cyan-400 border-cyan-200 dark:border-cyan-800",
  slate: "bg-slate-50 dark:bg-slate-950/30 text-slate-700 dark:text-slate-400 border-slate-200 dark:border-slate-800",
};

export function HomeView() {
  const [data, setData] = useState<Overview | null>(null);

  useEffect(() => {
    api<Overview>("/overview").then(setData);
  }, []);

  return (
    <div class="p-8">
      <h1 class="text-2xl font-bold mb-6">Overview</h1>
      {!data ? (
        <div class="text-gray-400">Loading...</div>
      ) : (
        <div class="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {CARDS.map(card => (
            <a
              key={card.key}
              href={`#${card.path}`}
              class={`block p-5 rounded-lg border cursor-pointer no-underline transition-shadow hover:shadow-md ${COLOR_MAP[card.color]}`}
            >
              <div class="text-2xl mb-2">{card.icon}</div>
              <div class="text-3xl font-bold">{data[card.key as keyof Overview]}</div>
              <div class="text-sm mt-1 opacity-75">{card.label}</div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

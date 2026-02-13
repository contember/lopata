import { useState, useEffect } from "preact/hooks";
import { api } from "../lib";
import { EmptyState, Breadcrumb, Table } from "./kv";

interface CacheName {
  cache_name: string;
  count: number;
}

interface CacheEntry {
  url: string;
  status: number;
  headers: string;
  expires_at: number | null;
}

export function CacheView({ route }: { route: string }) {
  const parts = route.split("/").filter(Boolean);
  if (parts.length === 1) return <CacheNameList />;
  if (parts.length >= 2) return <CacheEntryList name={decodeURIComponent(parts[1]!)} />;
  return null;
}

function CacheNameList() {
  const [caches, setCaches] = useState<CacheName[]>([]);

  useEffect(() => {
    api<CacheName[]>("/cache").then(setCaches);
  }, []);

  return (
    <div class="p-8">
      <h1 class="text-2xl font-bold mb-6">Cache</h1>
      {caches.length === 0 ? (
        <EmptyState message="No cache entries found" />
      ) : (
        <Table
          headers={["Cache Name", "Entries"]}
          rows={caches.map(c => [
            <a href={`#/cache/${encodeURIComponent(c.cache_name)}`} class="text-orange-600 dark:text-orange-400 hover:underline">{c.cache_name}</a>,
            c.count,
          ])}
        />
      )}
    </div>
  );
}

function CacheEntryList({ name }: { name: string }) {
  const [entries, setEntries] = useState<CacheEntry[]>([]);

  useEffect(() => {
    api<CacheEntry[]>(`/cache/${encodeURIComponent(name)}`).then(setEntries);
  }, [name]);

  const deleteEntry = async (url: string) => {
    if (!confirm(`Delete cache entry for "${url}"?`)) return;
    await api(`/cache/${encodeURIComponent(name)}?url=${encodeURIComponent(url)}`, { method: "DELETE" });
    setEntries(prev => prev.filter(e => e.url !== url));
  };

  return (
    <div class="p-8">
      <Breadcrumb items={[{ label: "Cache", href: "#/cache" }, { label: name }]} />
      {entries.length === 0 ? (
        <EmptyState message="No cache entries" />
      ) : (
        <Table
          headers={["URL", "Status", "Expires", ""]}
          rows={entries.map(e => [
            <span class="font-mono text-xs max-w-md truncate block">{e.url}</span>,
            <span class={`px-2 py-0.5 rounded text-xs font-medium ${
              e.status < 300 ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400"
                : e.status < 400 ? "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400"
                : "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400"
            }`}>{e.status}</span>,
            e.expires_at ? new Date(e.expires_at * 1000).toLocaleString() : "—",
            <button onClick={() => deleteEntry(e.url)} class="text-red-500 hover:text-red-700 text-xs">Delete</button>,
          ])}
        />
      )}
    </div>
  );
}

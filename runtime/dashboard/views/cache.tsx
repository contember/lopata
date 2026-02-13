import { useState, useEffect } from "preact/hooks";
import { api } from "../lib";
import { EmptyState, Breadcrumb, Table, PageHeader, DeleteButton, TableLink, StatusBadge } from "../components";

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

const HTTP_STATUS_COLORS: Record<string, string> = {
  "2xx": "bg-emerald-100 text-emerald-700",
  "3xx": "bg-amber-100 text-amber-700",
  "4xx": "bg-red-100 text-red-700",
  "5xx": "bg-red-100 text-red-700",
};

function httpStatusColor(status: number): string {
  if (status < 300) return HTTP_STATUS_COLORS["2xx"]!;
  if (status < 400) return HTTP_STATUS_COLORS["3xx"]!;
  return HTTP_STATUS_COLORS["4xx"]!;
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
      <PageHeader title="Cache" subtitle={`${caches.length} cache(s)`} />
      {caches.length === 0 ? (
        <EmptyState message="No cache entries found" />
      ) : (
        <Table
          headers={["Cache Name", "Entries"]}
          rows={caches.map(c => [
            <TableLink href={`#/cache/${encodeURIComponent(c.cache_name)}`}>{c.cache_name}</TableLink>,
            <span class="font-bold text-lg">{c.count}</span>,
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
            <span class={`inline-flex px-3.5 py-1 rounded-full text-xs font-semibold ${httpStatusColor(e.status)}`}>{e.status}</span>,
            e.expires_at ? new Date(e.expires_at * 1000).toLocaleString() : "—",
            <DeleteButton onClick={() => deleteEntry(e.url)} />,
          ])}
        />
      )}
    </div>
  );
}

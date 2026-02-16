import { useQuery, useMutation } from "../rpc/hooks";
import { EmptyState, Breadcrumb, Table, PageHeader, DeleteButton, TableLink, ServiceInfo } from "../components";

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
  const { data: caches } = useQuery("cache.listCaches");

  const totalEntries = caches?.reduce((s, c) => s + c.count, 0) ?? 0;

  return (
    <div class="p-8 max-w-5xl mx-auto">
      <PageHeader title="Cache" subtitle={`${caches?.length ?? 0} cache(s)`} />
      <div class="flex gap-6 items-start">
        <div class="flex-1 min-w-0">
          {!caches?.length ? (
            <EmptyState message="No cache entries found" />
          ) : (
            <Table
              headers={["Cache Name", "Entries"]}
              rows={caches.map(c => [
                <TableLink href={`#/cache/${encodeURIComponent(c.cache_name)}`}>{c.cache_name}</TableLink>,
                <span class="tabular-nums">{c.count}</span>,
              ])}
            />
          )}
        </div>
        <ServiceInfo
          description="Cache API for programmatic HTTP response caching."
          stats={[
            { label: "Caches", value: caches?.length ?? 0 },
            { label: "Entries", value: totalEntries.toLocaleString() },
          ]}
          links={[
            { label: "Documentation", href: "https://developers.cloudflare.com/cache/" },
            { label: "API Reference", href: "https://developers.cloudflare.com/api/resources/cache/" },
          ]}
        />
      </div>
    </div>
  );
}

function CacheEntryList({ name }: { name: string }) {
  const { data: entries, refetch } = useQuery("cache.listEntries", { name });
  const deleteEntry = useMutation("cache.deleteEntry");

  const handleDelete = async (url: string) => {
    if (!confirm(`Delete cache entry for "${url}"?`)) return;
    await deleteEntry.mutate({ name, url });
    refetch();
  };

  return (
    <div class="p-8">
      <Breadcrumb items={[{ label: "Cache", href: "#/cache" }, { label: name }]} />
      {!entries?.length ? (
        <EmptyState message="No cache entries" />
      ) : (
        <Table
          headers={["URL", "Status", "Expires", ""]}
          rows={entries.map(e => [
            <span class="font-mono text-xs max-w-md truncate block">{e.url}</span>,
            <span class={`inline-flex px-2 py-0.5 rounded-md text-xs font-medium ${httpStatusColor(e.status)}`}>{e.status}</span>,
            e.expires_at ? new Date(e.expires_at * 1000).toLocaleString() : "—",
            <DeleteButton onClick={() => handleDelete(e.url)} />,
          ])}
        />
      )}
    </div>
  );
}

import { useState, useEffect } from "preact/hooks";
import { api, formatBytes } from "../lib";
import { EmptyState, Breadcrumb, Table, PageHeader, FilterInput, LoadMoreButton, DeleteButton, TableLink } from "../components";

interface R2Bucket {
  bucket: string;
  count: number;
  total_size: number;
}

interface R2Object {
  key: string;
  size: number;
  etag: string;
  uploaded: string;
  http_metadata: string | null;
  custom_metadata: string | null;
}

export function R2View({ route }: { route: string }) {
  const parts = route.split("/").filter(Boolean);
  if (parts.length === 1) return <R2BucketList />;
  if (parts.length >= 2) return <R2ObjectList bucket={decodeURIComponent(parts[1]!)} />;
  return null;
}

function R2BucketList() {
  const [buckets, setBuckets] = useState<R2Bucket[]>([]);

  useEffect(() => {
    api<R2Bucket[]>("/r2").then(setBuckets);
  }, []);

  return (
    <div class="p-8">
      <PageHeader title="R2 Buckets" subtitle={`${buckets.length} bucket(s)`} />
      {buckets.length === 0 ? (
        <EmptyState message="No R2 buckets found" />
      ) : (
        <Table
          headers={["Bucket", "Objects", "Total Size"]}
          rows={buckets.map(b => [
            <TableLink href={`#/r2/${encodeURIComponent(b.bucket)}`}>{b.bucket}</TableLink>,
            <span class="font-bold text-lg">{b.count}</span>,
            formatBytes(b.total_size),
          ])}
        />
      )}
    </div>
  );
}

function R2ObjectList({ bucket }: { bucket: string }) {
  const [objects, setObjects] = useState<R2Object[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [prefix, setPrefix] = useState("");

  const load = (reset = false) => {
    const c = reset ? "" : (cursor ?? "");
    api<{ items: R2Object[]; cursor: string | null }>(`/r2/${encodeURIComponent(bucket)}?prefix=${encodeURIComponent(prefix)}&cursor=${encodeURIComponent(c)}`)
      .then(data => {
        setObjects(prev => reset ? data.items : [...prev, ...data.items]);
        setCursor(data.cursor);
      });
  };

  useEffect(() => { load(true); }, [bucket, prefix]);

  const deleteObject = async (key: string) => {
    if (!confirm(`Delete object "${key}"?`)) return;
    await api(`/r2/${encodeURIComponent(bucket)}/${encodeURIComponent(key)}`, { method: "DELETE" });
    setObjects(prev => prev.filter(o => o.key !== key));
  };

  return (
    <div class="p-8">
      <Breadcrumb items={[{ label: "R2", href: "#/r2" }, { label: bucket }]} />
      <div class="mb-6">
        <FilterInput value={prefix} onInput={setPrefix} placeholder="Filter by prefix..." />
      </div>
      {objects.length === 0 ? (
        <EmptyState message="No objects found" />
      ) : (
        <>
          <Table
            headers={["Key", "Size", "ETag", "Uploaded", ""]}
            rows={objects.map(o => [
              <span class="font-mono text-xs font-medium">{o.key}</span>,
              formatBytes(o.size),
              <span class="font-mono text-xs text-gray-400">{o.etag.slice(0, 12)}</span>,
              o.uploaded,
              <DeleteButton onClick={() => deleteObject(o.key)} />,
            ])}
          />
          {cursor && <LoadMoreButton onClick={() => load()} />}
        </>
      )}
    </div>
  );
}

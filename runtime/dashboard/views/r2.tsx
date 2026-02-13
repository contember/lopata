import { useState, useEffect } from "preact/hooks";
import { api, formatBytes } from "../lib";
import { EmptyState, Breadcrumb, Table } from "./kv";

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
      <h1 class="text-2xl font-bold mb-6">R2 Buckets</h1>
      {buckets.length === 0 ? (
        <EmptyState message="No R2 buckets found" />
      ) : (
        <Table
          headers={["Bucket", "Objects", "Total Size"]}
          rows={buckets.map(b => [
            <a href={`#/r2/${encodeURIComponent(b.bucket)}`} class="text-orange-600 dark:text-orange-400 hover:underline">{b.bucket}</a>,
            b.count,
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
      <div class="mb-4">
        <input
          type="text"
          placeholder="Filter by prefix..."
          value={prefix}
          onInput={e => setPrefix((e.target as HTMLInputElement).value)}
          class="px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-md bg-white dark:bg-gray-900 text-sm w-64"
        />
      </div>
      {objects.length === 0 ? (
        <EmptyState message="No objects found" />
      ) : (
        <>
          <Table
            headers={["Key", "Size", "ETag", "Uploaded", ""]}
            rows={objects.map(o => [
              <span class="font-mono text-xs">{o.key}</span>,
              formatBytes(o.size),
              <span class="font-mono text-xs text-gray-500">{o.etag.slice(0, 12)}</span>,
              o.uploaded,
              <button onClick={() => deleteObject(o.key)} class="text-red-500 hover:text-red-700 text-xs">Delete</button>,
            ])}
          />
          {cursor && (
            <button onClick={() => load()} class="mt-4 px-4 py-2 text-sm bg-gray-100 dark:bg-gray-800 rounded hover:bg-gray-200 dark:hover:bg-gray-700">
              Load more
            </button>
          )}
        </>
      )}
    </div>
  );
}

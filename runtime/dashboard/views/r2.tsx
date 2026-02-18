import { useState, useRef } from "preact/hooks";
import { formatBytes } from "../lib";
import { useQuery, usePaginatedQuery, useMutation } from "../rpc/hooks";
import { EmptyState, Breadcrumb, Table, PageHeader, FilterInput, LoadMoreButton, DeleteButton, TableLink, ServiceInfo } from "../components";

export function R2View({ route }: { route: string }) {
  const parts = route.split("/").filter(Boolean);
  if (parts.length === 1) return <R2BucketList />;
  if (parts.length >= 2) return <R2ObjectList bucket={decodeURIComponent(parts[1]!)} />;
  return null;
}

function R2BucketList() {
  const { data: buckets } = useQuery("r2.listBuckets");
  const { data: configGroups } = useQuery("config.forService", { type: "r2" });

  const totalObjects = buckets?.reduce((s, b) => s + b.count, 0) ?? 0;
  const totalSize = buckets?.reduce((s, b) => s + b.total_size, 0) ?? 0;

  return (
    <div class="p-8 max-w-6xl">
      <PageHeader title="R2 Buckets" subtitle={`${buckets?.length ?? 0} bucket(s)`} />
      <div class="flex gap-6 items-start">
        <div class="flex-1 min-w-0">
          {!buckets?.length ? (
            <EmptyState message="No R2 buckets found" />
          ) : (
            <Table
              headers={["Bucket", "Objects", "Total Size"]}
              rows={buckets.map(b => [
                <TableLink href={`#/r2/${encodeURIComponent(b.bucket)}`}>{b.bucket}</TableLink>,
                <span class="tabular-nums">{b.count}</span>,
                formatBytes(b.total_size),
              ])}
            />
          )}
        </div>
        <ServiceInfo
          description="Object storage with S3-compatible API. Zero egress fees."
          stats={[
            { label: "Buckets", value: buckets?.length ?? 0 },
            { label: "Objects", value: totalObjects.toLocaleString() },
            { label: "Storage", value: formatBytes(totalSize) },
          ]}
          configGroups={configGroups}
          links={[
            { label: "Documentation", href: "https://developers.cloudflare.com/r2/" },
            { label: "API Reference", href: "https://developers.cloudflare.com/api/resources/r2/" },
          ]}
        />
      </div>
    </div>
  );
}

function UploadForm({ bucket, onUploaded }: { bucket: string; onUploaded: () => void }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: Event) => {
    const input = e.target as HTMLInputElement;
    const selected = input.files?.[0] ?? null;
    setFile(selected);
    if (selected && !key) setKey(selected.name);
  };

  const handleSubmit = async () => {
    if (!file || !key.trim()) return;
    setError("");
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("bucket", bucket);
      formData.append("key", key.trim());
      formData.append("file", file);
      const res = await fetch("/__dashboard/api/r2/upload", { method: "POST", body: formData });
      const data = await res.json() as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Upload failed");
      setKey("");
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setOpen(false);
      onUploaded();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        class="rounded-md px-3 py-1.5 text-sm font-medium bg-ink text-surface hover:opacity-80 transition-all"
      >
        Upload object
      </button>
    );
  }

  return (
    <div class="bg-panel border border-border rounded-lg p-4 mb-6">
      <div class="flex items-center justify-between mb-3">
        <div class="text-sm font-semibold text-ink">Upload object</div>
        <button onClick={() => { setOpen(false); setError(""); }} class="text-text-muted hover:text-text-data text-xs font-medium">
          Cancel
        </button>
      </div>
      <div class="space-y-3">
        <input
          ref={fileInputRef}
          type="file"
          onChange={handleFileChange}
          class="w-full text-sm text-text-secondary file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-panel-hover file:text-ink hover:file:bg-panel-active file:cursor-pointer file:transition-all"
        />
        <input
          type="text"
          value={key}
          onInput={e => setKey((e.target as HTMLInputElement).value)}
          placeholder="Object key (defaults to filename)"
          class="w-full bg-panel-secondary border border-border rounded-lg px-3 py-2 text-sm font-mono outline-none focus:border-border focus:ring-1 focus:ring-border transition-all"
        />
      </div>
      {error && <div class="text-red-500 text-xs mt-2">{error}</div>}
      <div class="flex justify-end mt-3">
        <button
          onClick={handleSubmit}
          disabled={uploading || !file || !key.trim()}
          class="rounded-md px-4 py-1.5 text-sm font-medium bg-ink text-surface hover:opacity-80 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {uploading ? "Uploading..." : "Upload"}
        </button>
      </div>
    </div>
  );
}

function R2ObjectList({ bucket }: { bucket: string }) {
  const [prefix, setPrefix] = useState("");
  const { items: objects, hasMore, loadMore, refetch } = usePaginatedQuery("r2.listObjects", { bucket, prefix });
  const deleteObject = useMutation("r2.deleteObject");
  const renameObject = useMutation("r2.renameObject");

  const handleDelete = async (key: string) => {
    if (!confirm(`Delete object "${key}"?`)) return;
    await deleteObject.mutate({ bucket, key });
    refetch();
  };

  const handleRename = async (oldKey: string) => {
    const newKey = prompt("New key:", oldKey);
    if (!newKey || newKey === oldKey) return;
    await renameObject.mutate({ bucket, oldKey, newKey });
    refetch();
  };

  return (
    <div class="p-8">
      <Breadcrumb items={[{ label: "R2", href: "#/r2" }, { label: bucket }]} />
      <div class="mb-6 flex gap-2 items-center justify-between">
        <FilterInput value={prefix} onInput={setPrefix} placeholder="Filter by prefix..." />
        <UploadForm bucket={bucket} onUploaded={refetch} />
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
              <span class="font-mono text-xs text-text-muted">{o.etag.slice(0, 12)}</span>,
              o.uploaded,
              <div class="flex gap-1">
                <a
                  href={`/__dashboard/api/r2/download?bucket=${encodeURIComponent(bucket)}&key=${encodeURIComponent(o.key)}`}
                  class="text-blue-500 hover:text-blue-700 text-xs font-medium rounded-md px-2 py-1 hover:bg-blue-50 transition-all"
                >
                  Download
                </a>
                <button onClick={() => handleRename(o.key)} class="text-text-secondary hover:text-ink text-xs font-medium rounded-md px-2 py-1 hover:bg-panel-hover transition-all">
                  Rename
                </button>
                <DeleteButton onClick={() => handleDelete(o.key)} />
              </div>,
            ])}
          />
          {hasMore && <LoadMoreButton onClick={loadMore} />}
        </>
      )}
    </div>
  );
}

import { useState } from "preact/hooks";
import { formatBytes } from "../lib";
import { useQuery, usePaginatedQuery, useMutation } from "../rpc/hooks";
import { EmptyState, Breadcrumb, Table, PageHeader, FilterInput, LoadMoreButton, DeleteButton, TableLink } from "../components";

export function R2View({ route }: { route: string }) {
  const parts = route.split("/").filter(Boolean);
  if (parts.length === 1) return <R2BucketList />;
  if (parts.length >= 2) return <R2ObjectList bucket={decodeURIComponent(parts[1]!)} />;
  return null;
}

function R2BucketList() {
  const { data: buckets } = useQuery("r2.listBuckets");

  return (
    <div class="p-8">
      <PageHeader title="R2 Buckets" subtitle={`${buckets?.length ?? 0} bucket(s)`} />
      {!buckets?.length ? (
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
  const [prefix, setPrefix] = useState("");
  const { items: objects, hasMore, loadMore } = usePaginatedQuery("r2.listObjects", { bucket, prefix });
  const deleteObject = useMutation("r2.deleteObject");

  const handleDelete = async (key: string) => {
    if (!confirm(`Delete object "${key}"?`)) return;
    await deleteObject.mutate({ bucket, key });
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
              <DeleteButton onClick={() => handleDelete(o.key)} />,
            ])}
          />
          {hasMore && <LoadMoreButton onClick={loadMore} />}
        </>
      )}
    </div>
  );
}

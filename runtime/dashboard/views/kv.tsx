import { useState } from "preact/hooks";
import { formatBytes } from "../lib";
import { useQuery, usePaginatedQuery, useMutation } from "../rpc/hooks";
import type { KvValue } from "../rpc/types";
import { EmptyState, PageHeader, Breadcrumb, Table, DetailField, CodeBlock, FilterInput, LoadMoreButton, DeleteButton, TableLink, ServiceInfo } from "../components";

export function KvView({ route }: { route: string }) {
  const parts = route.split("/").filter(Boolean);

  if (parts.length === 1) return <KvNamespaceList />;
  if (parts.length === 2) return <KvKeyList ns={decodeURIComponent(parts[1]!)} />;
  if (parts.length >= 3) return <KvKeyDetail ns={decodeURIComponent(parts[1]!)} keyName={decodeURIComponent(parts.slice(2).join("/"))} />;
  return null;
}

function KvNamespaceList() {
  const { data: namespaces } = useQuery("kv.listNamespaces");
  const { data: configGroups } = useQuery("config.forService", { type: "kv" });

  const totalKeys = namespaces?.reduce((s, ns) => s + ns.count, 0) ?? 0;

  return (
    <div class="p-8 max-w-5xl mx-auto">
      <PageHeader title="KV Namespaces" subtitle={`${namespaces?.length ?? 0} namespace(s)`} />
      <div class="flex gap-6 items-start">
        <div class="flex-1 min-w-0">
          {!namespaces?.length ? (
            <EmptyState message="No KV namespaces found" />
          ) : (
            <Table
              headers={["Namespace", "Keys"]}
              rows={namespaces.map(ns => [
                <TableLink href={`#/kv/${encodeURIComponent(ns.namespace)}`}>{ns.namespace}</TableLink>,
                <span class="tabular-nums">{ns.count}</span>,
              ])}
            />
          )}
        </div>
        <ServiceInfo
          description="Key-value storage for fast, globally distributed reads."
          stats={[
            { label: "Namespaces", value: namespaces?.length ?? 0 },
            { label: "Total keys", value: totalKeys.toLocaleString() },
          ]}
          configGroups={configGroups}
          links={[
            { label: "Documentation", href: "https://developers.cloudflare.com/kv/" },
            { label: "API Reference", href: "https://developers.cloudflare.com/api/resources/kv/" },
          ]}
        />
      </div>
    </div>
  );
}

function KvKeyList({ ns }: { ns: string }) {
  const [prefix, setPrefix] = useState("");
  const { items: keys, hasMore, loadMore } = usePaginatedQuery("kv.listKeys", { ns, prefix });
  const deleteKey = useMutation("kv.deleteKey");

  const handleDelete = async (key: string) => {
    if (!confirm(`Delete key "${key}"?`)) return;
    await deleteKey.mutate({ ns, key });
  };

  return (
    <div class="p-8">
      <Breadcrumb items={[{ label: "KV", href: "#/kv" }, { label: ns }]} />
      <div class="mb-6">
        <FilterInput value={prefix} onInput={setPrefix} placeholder="Filter by prefix..." />
      </div>
      {keys.length === 0 ? (
        <EmptyState message="No keys found" />
      ) : (
        <>
          <Table
            headers={["Key", "Size", "Expiration", ""]}
            rows={keys.map(k => [
              <TableLink href={`#/kv/${encodeURIComponent(ns)}/${encodeURIComponent(k.key)}`} mono>{k.key}</TableLink>,
              formatBytes(k.size),
              k.expiration ? new Date(k.expiration * 1000).toLocaleString() : "—",
              <DeleteButton onClick={() => handleDelete(k.key)} />,
            ])}
          />
          {hasMore && <LoadMoreButton onClick={loadMore} />}
        </>
      )}
    </div>
  );
}

function KvKeyDetail({ ns, keyName }: { ns: string; keyName: string }) {
  const { data } = useQuery("kv.getKey", { ns, key: keyName });

  if (!data) return <div class="p-8 text-gray-400">Loading...</div>;

  return (
    <div class="p-8">
      <Breadcrumb items={[{ label: "KV", href: "#/kv" }, { label: ns, href: `#/kv/${encodeURIComponent(ns)}` }, { label: keyName }]} />
      <div class="space-y-5">
        <DetailField label="Key" value={data.key} />
        <DetailField label="Value">
          <CodeBlock class="max-h-96">{data.value}</CodeBlock>
        </DetailField>
        {data.metadata && (
          <DetailField label="Metadata">
            <CodeBlock>{JSON.stringify(data.metadata, null, 2)}</CodeBlock>
          </DetailField>
        )}
        {data.expiration && (
          <DetailField label="Expiration" value={new Date(data.expiration * 1000).toLocaleString()} />
        )}
      </div>
    </div>
  );
}

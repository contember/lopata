import { useState } from "preact/hooks";
import { formatBytes } from "../lib";
import { useQuery, usePaginatedQuery, useMutation } from "../rpc/hooks";
import type { KvValue } from "../rpc/types";
import { EmptyState, PageHeader, Breadcrumb, Table, DetailField, CodeBlock, FilterInput, LoadMoreButton, DeleteButton, TableLink, ServiceInfo, PillButton } from "../components";

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

// ─── Put Key Form (add / edit) ─────────────────────────────────────

interface KvPutFormProps {
  ns: string;
  /** Pre-fill for editing an existing key */
  initial?: { key: string; value: string; metadata?: string; expiration?: number | null };
  onSaved: () => void;
  onCancel: () => void;
}

function KvPutForm({ ns, initial, onSaved, onCancel }: KvPutFormProps) {
  const isEdit = !!initial;
  const [key, setKey] = useState(initial?.key ?? "");
  const [value, setValue] = useState(initial?.value ?? "");
  const [metadata, setMetadata] = useState(initial?.metadata ?? "");
  const [ttl, setTtl] = useState("");
  const [error, setError] = useState("");
  const putKey = useMutation("kv.putKey");

  const handleSubmit = async () => {
    setError("");
    if (!key.trim()) { setError("Key is required"); return; }

    const input: { ns: string; key: string; value: string; metadata?: string; expirationTtl?: number } = { ns, key, value };
    if (metadata.trim()) input.metadata = metadata.trim();
    if (ttl.trim()) {
      const ttlNum = parseInt(ttl, 10);
      if (isNaN(ttlNum) || ttlNum < 60) { setError("TTL must be at least 60 seconds"); return; }
      input.expirationTtl = ttlNum;
    }

    const result = await putKey.mutate(input);
    if (result) {
      onSaved();
    } else if (putKey.error) {
      setError(putKey.error.message);
    }
  };

  return (
    <div class="bg-white border border-gray-200 rounded-lg p-4 mb-6">
      <div class="flex items-center justify-between mb-3">
        <div class="text-sm font-semibold text-ink">{isEdit ? "Edit key" : "Add key"}</div>
        <button onClick={onCancel} class="text-gray-400 hover:text-gray-600 text-xs font-medium">
          Cancel
        </button>
      </div>

      <div class="space-y-3">
        <div>
          <label class="block text-xs font-medium text-gray-500 mb-1">Key</label>
          <input
            type="text"
            value={key}
            onInput={e => setKey((e.target as HTMLInputElement).value)}
            placeholder="my-key"
            disabled={isEdit}
            class="w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono outline-none focus:border-gray-300 focus:ring-1 focus:ring-gray-200 transition-all disabled:opacity-50"
          />
        </div>

        <div>
          <label class="block text-xs font-medium text-gray-500 mb-1">Value</label>
          <textarea
            value={value}
            onInput={e => setValue((e.target as HTMLTextAreaElement).value)}
            placeholder="Value..."
            class="w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono outline-none focus:border-gray-300 focus:ring-1 focus:ring-gray-200 transition-all resize-y min-h-[80px]"
            rows={4}
          />
        </div>

        <div class="flex gap-3">
          <div class="flex-1">
            <label class="block text-xs font-medium text-gray-500 mb-1">Metadata (JSON, optional)</label>
            <input
              type="text"
              value={metadata}
              onInput={e => setMetadata((e.target as HTMLInputElement).value)}
              placeholder='{"type": "config"}'
              class="w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono outline-none focus:border-gray-300 focus:ring-1 focus:ring-gray-200 transition-all"
            />
          </div>
          <div class="w-40">
            <label class="block text-xs font-medium text-gray-500 mb-1">TTL (seconds)</label>
            <input
              type="text"
              value={ttl}
              onInput={e => setTtl((e.target as HTMLInputElement).value)}
              placeholder="e.g. 3600"
              class="w-full bg-gray-50 border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono outline-none focus:border-gray-300 focus:ring-1 focus:ring-gray-200 transition-all"
            />
          </div>
        </div>
      </div>

      {error && <div class="text-red-500 text-xs mt-2">{error}</div>}
      <div class="flex justify-end mt-3">
        <button
          onClick={handleSubmit}
          disabled={putKey.isLoading || !key.trim()}
          class="rounded-md px-4 py-1.5 text-sm font-medium bg-ink text-white hover:bg-gray-800 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {putKey.isLoading ? "Saving..." : isEdit ? "Save" : "Add key"}
        </button>
      </div>
    </div>
  );
}

// ─── Key list ───────────────────────────────────────────────────────

function KvKeyList({ ns }: { ns: string }) {
  const [prefix, setPrefix] = useState("");
  const { items: keys, hasMore, loadMore, refetch } = usePaginatedQuery("kv.listKeys", { ns, prefix });
  const deleteKey = useMutation("kv.deleteKey");
  const [showAdd, setShowAdd] = useState(false);

  const handleDelete = async (key: string) => {
    if (!confirm(`Delete key "${key}"?`)) return;
    await deleteKey.mutate({ ns, key });
    refetch();
  };

  return (
    <div class="p-8">
      <Breadcrumb items={[{ label: "KV", href: "#/kv" }, { label: ns }]} />
      <div class="mb-6 flex gap-3 items-center justify-between">
        <FilterInput value={prefix} onInput={setPrefix} placeholder="Filter by prefix..." />
        {!showAdd && (
          <button
            onClick={() => setShowAdd(true)}
            class="rounded-md px-3 py-1.5 text-sm font-medium bg-ink text-white hover:bg-gray-800 transition-all"
          >
            Add key
          </button>
        )}
      </div>
      {showAdd && (
        <KvPutForm
          ns={ns}
          onSaved={() => { setShowAdd(false); refetch(); }}
          onCancel={() => setShowAdd(false)}
        />
      )}
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

// ─── Key detail ─────────────────────────────────────────────────────

function KvKeyDetail({ ns, keyName }: { ns: string; keyName: string }) {
  const { data, refetch } = useQuery("kv.getKey", { ns, key: keyName });
  const [editing, setEditing] = useState(false);

  if (!data) return <div class="p-8 text-gray-400">Loading...</div>;

  return (
    <div class="p-8">
      <Breadcrumb items={[{ label: "KV", href: "#/kv" }, { label: ns, href: `#/kv/${encodeURIComponent(ns)}` }, { label: keyName }]} />
      {editing ? (
        <KvPutForm
          ns={ns}
          initial={{
            key: data.key,
            value: data.value,
            metadata: data.metadata ? JSON.stringify(data.metadata, null, 2) : "",
            expiration: data.expiration,
          }}
          onSaved={() => { setEditing(false); refetch(); }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <div class="space-y-5">
          <div class="flex justify-end">
            <button
              onClick={() => setEditing(true)}
              class="rounded-md px-3 py-1.5 text-sm font-medium bg-white border border-gray-200 text-gray-600 hover:bg-gray-50 transition-all"
            >
              Edit
            </button>
          </div>
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
      )}
    </div>
  );
}

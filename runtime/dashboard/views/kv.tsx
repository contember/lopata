import { useState, useEffect } from "preact/hooks";
import { api, formatBytes } from "../lib";
import { EmptyState, PageHeader, Breadcrumb, Table, DetailField, CodeBlock, FilterInput, LoadMoreButton, DeleteButton, TableLink } from "../components";

interface KvNamespace {
  namespace: string;
  count: number;
}

interface KvKey {
  key: string;
  size: number;
  metadata: string | null;
  expiration: number | null;
}

interface KvValue {
  key: string;
  value: string;
  metadata: unknown;
  expiration: number | null;
}

export function KvView({ route }: { route: string }) {
  const parts = route.split("/").filter(Boolean);

  if (parts.length === 1) return <KvNamespaceList />;
  if (parts.length === 2) return <KvKeyList ns={decodeURIComponent(parts[1]!)} />;
  if (parts.length >= 3) return <KvKeyDetail ns={decodeURIComponent(parts[1]!)} keyName={decodeURIComponent(parts.slice(2).join("/"))} />;
  return null;
}

function KvNamespaceList() {
  const [namespaces, setNamespaces] = useState<KvNamespace[]>([]);

  useEffect(() => {
    api<KvNamespace[]>("/kv").then(setNamespaces);
  }, []);

  return (
    <div class="p-8">
      <PageHeader title="KV Namespaces" subtitle={`${namespaces.length} namespace(s)`} />
      {namespaces.length === 0 ? (
        <EmptyState message="No KV namespaces found" />
      ) : (
        <Table
          headers={["Namespace", "Keys"]}
          rows={namespaces.map(ns => [
            <TableLink href={`#/kv/${encodeURIComponent(ns.namespace)}`}>{ns.namespace}</TableLink>,
            <span class="font-bold text-lg">{ns.count}</span>,
          ])}
        />
      )}
    </div>
  );
}

function KvKeyList({ ns }: { ns: string }) {
  const [keys, setKeys] = useState<KvKey[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [prefix, setPrefix] = useState("");

  const load = (reset = false) => {
    const c = reset ? "" : (cursor ?? "");
    api<{ items: KvKey[]; cursor: string | null }>(`/kv/${encodeURIComponent(ns)}?prefix=${encodeURIComponent(prefix)}&cursor=${encodeURIComponent(c)}`)
      .then(data => {
        setKeys(prev => reset ? data.items : [...prev, ...data.items]);
        setCursor(data.cursor);
      });
  };

  useEffect(() => { load(true); }, [ns, prefix]);

  const deleteKey = async (key: string) => {
    if (!confirm(`Delete key "${key}"?`)) return;
    await api(`/kv/${encodeURIComponent(ns)}/${encodeURIComponent(key)}`, { method: "DELETE" });
    setKeys(prev => prev.filter(k => k.key !== key));
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
              <DeleteButton onClick={() => deleteKey(k.key)} />,
            ])}
          />
          {cursor && <LoadMoreButton onClick={() => load()} />}
        </>
      )}
    </div>
  );
}

function KvKeyDetail({ ns, keyName }: { ns: string; keyName: string }) {
  const [data, setData] = useState<KvValue | null>(null);

  useEffect(() => {
    api<KvValue>(`/kv/${encodeURIComponent(ns)}/${encodeURIComponent(keyName)}`).then(setData);
  }, [ns, keyName]);

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

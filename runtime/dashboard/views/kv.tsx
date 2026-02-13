import { useState, useEffect } from "preact/hooks";
import { api, navigate, formatBytes } from "../lib";

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
  const parts = route.split("/").filter(Boolean); // ["kv"] or ["kv", "NS"] or ["kv", "NS", "key"]

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
      <h1 class="text-2xl font-bold mb-6">KV Namespaces</h1>
      {namespaces.length === 0 ? (
        <EmptyState message="No KV namespaces found" />
      ) : (
        <Table
          headers={["Namespace", "Keys"]}
          rows={namespaces.map(ns => [
            <a href={`#/kv/${encodeURIComponent(ns.namespace)}`} class="text-orange-600 dark:text-orange-400 hover:underline">{ns.namespace}</a>,
            ns.count,
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
      <div class="mb-4">
        <input
          type="text"
          placeholder="Filter by prefix..."
          value={prefix}
          onInput={e => setPrefix((e.target as HTMLInputElement).value)}
          class="px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-md bg-white dark:bg-gray-900 text-sm w-64"
        />
      </div>
      {keys.length === 0 ? (
        <EmptyState message="No keys found" />
      ) : (
        <>
          <Table
            headers={["Key", "Size", "Expiration", ""]}
            rows={keys.map(k => [
              <a href={`#/kv/${encodeURIComponent(ns)}/${encodeURIComponent(k.key)}`} class="text-orange-600 dark:text-orange-400 hover:underline font-mono text-xs">{k.key}</a>,
              formatBytes(k.size),
              k.expiration ? new Date(k.expiration * 1000).toLocaleString() : "—",
              <button onClick={() => deleteKey(k.key)} class="text-red-500 hover:text-red-700 text-xs">Delete</button>,
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

function KvKeyDetail({ ns, keyName }: { ns: string; keyName: string }) {
  const [data, setData] = useState<KvValue | null>(null);

  useEffect(() => {
    api<KvValue>(`/kv/${encodeURIComponent(ns)}/${encodeURIComponent(keyName)}`).then(setData);
  }, [ns, keyName]);

  if (!data) return <div class="p-8 text-gray-400">Loading...</div>;

  return (
    <div class="p-8">
      <Breadcrumb items={[{ label: "KV", href: "#/kv" }, { label: ns, href: `#/kv/${encodeURIComponent(ns)}` }, { label: keyName }]} />
      <div class="space-y-4">
        <DetailField label="Key" value={data.key} />
        <DetailField label="Value">
          <pre class="bg-gray-100 dark:bg-gray-900 p-3 rounded text-xs overflow-x-auto max-h-96">{data.value}</pre>
        </DetailField>
        {data.metadata && (
          <DetailField label="Metadata">
            <pre class="bg-gray-100 dark:bg-gray-900 p-3 rounded text-xs overflow-x-auto">{JSON.stringify(data.metadata, null, 2)}</pre>
          </DetailField>
        )}
        {data.expiration && (
          <DetailField label="Expiration" value={new Date(data.expiration * 1000).toLocaleString()} />
        )}
      </div>
    </div>
  );
}

// ─── Shared components ───────────────────────────────────────────────
export function EmptyState({ message }: { message: string }) {
  return (
    <div class="text-center py-12 text-gray-400 dark:text-gray-600">
      <div class="text-4xl mb-2">∅</div>
      <div>{message}</div>
    </div>
  );
}

export function Breadcrumb({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <div class="flex items-center gap-2 text-sm text-gray-500 mb-6">
      {items.map((item, i) => (
        <span key={i} class="flex items-center gap-2">
          {i > 0 && <span>/</span>}
          {item.href ? (
            <a href={item.href} class="text-orange-600 dark:text-orange-400 hover:underline">{item.label}</a>
          ) : (
            <span class="text-gray-900 dark:text-gray-100 font-medium">{item.label}</span>
          )}
        </span>
      ))}
    </div>
  );
}

export function Table({ headers, rows }: { headers: string[]; rows: unknown[][] }) {
  return (
    <div class="overflow-x-auto border border-gray-200 dark:border-gray-800 rounded-lg">
      <table class="w-full text-sm">
        <thead class="bg-gray-50 dark:bg-gray-900">
          <tr>
            {headers.map(h => (
              <th key={h} class="text-left px-4 py-2 font-medium text-gray-500 dark:text-gray-400">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100 dark:divide-gray-800">
          {rows.map((row, i) => (
            <tr key={i} class="hover:bg-gray-50 dark:hover:bg-gray-900/50">
              {row.map((cell, j) => (
                <td key={j} class="px-4 py-2">{cell as any}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DetailField({ label, value, children }: { label: string; value?: string; children?: any }) {
  return (
    <div>
      <div class="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">{label}</div>
      {value ? <div class="font-mono text-sm">{value}</div> : children}
    </div>
  );
}

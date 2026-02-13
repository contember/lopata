import { useState, useEffect } from "preact/hooks";
import { api, formatTime } from "../lib";
import { EmptyState, Breadcrumb, Table } from "./kv";

interface DoNamespace {
  namespace: string;
  count: number;
}

interface DoInstance {
  id: string;
  key_count: number;
  alarm: number | null;
}

interface DoDetail {
  entries: { key: string; value: string }[];
  alarm: number | null;
}

export function DoView({ route }: { route: string }) {
  const parts = route.split("/").filter(Boolean);
  if (parts.length === 1) return <DoNamespaceList />;
  if (parts.length === 2) return <DoInstanceList ns={decodeURIComponent(parts[1]!)} />;
  if (parts.length >= 3) return <DoInstanceDetail ns={decodeURIComponent(parts[1]!)} id={decodeURIComponent(parts[2]!)} />;
  return null;
}

function DoNamespaceList() {
  const [namespaces, setNamespaces] = useState<DoNamespace[]>([]);

  useEffect(() => {
    api<DoNamespace[]>("/do").then(setNamespaces);
  }, []);

  return (
    <div class="p-8">
      <h1 class="text-2xl font-bold mb-6">Durable Objects</h1>
      {namespaces.length === 0 ? (
        <EmptyState message="No Durable Object namespaces found" />
      ) : (
        <Table
          headers={["Namespace", "Instances"]}
          rows={namespaces.map(ns => [
            <a href={`#/do/${encodeURIComponent(ns.namespace)}`} class="text-orange-600 dark:text-orange-400 hover:underline">{ns.namespace}</a>,
            ns.count,
          ])}
        />
      )}
    </div>
  );
}

function DoInstanceList({ ns }: { ns: string }) {
  const [instances, setInstances] = useState<DoInstance[]>([]);

  useEffect(() => {
    api<DoInstance[]>(`/do/${encodeURIComponent(ns)}`).then(setInstances);
  }, [ns]);

  return (
    <div class="p-8">
      <Breadcrumb items={[{ label: "Durable Objects", href: "#/do" }, { label: ns }]} />
      {instances.length === 0 ? (
        <EmptyState message="No instances found" />
      ) : (
        <Table
          headers={["Instance ID", "Storage Keys", "Alarm"]}
          rows={instances.map(inst => [
            <a href={`#/do/${encodeURIComponent(ns)}/${encodeURIComponent(inst.id)}`} class="text-orange-600 dark:text-orange-400 hover:underline font-mono text-xs">{inst.id}</a>,
            inst.key_count,
            inst.alarm ? formatTime(inst.alarm) : "—",
          ])}
        />
      )}
    </div>
  );
}

function DoInstanceDetail({ ns, id }: { ns: string; id: string }) {
  const [data, setData] = useState<DoDetail | null>(null);

  useEffect(() => {
    api<DoDetail>(`/do/${encodeURIComponent(ns)}/${encodeURIComponent(id)}`).then(setData);
  }, [ns, id]);

  const deleteEntry = async (key: string) => {
    if (!confirm(`Delete storage key "${key}"?`)) return;
    await api(`/do/${encodeURIComponent(ns)}/${encodeURIComponent(id)}/${encodeURIComponent(key)}`, { method: "DELETE" });
    setData(prev => prev ? { ...prev, entries: prev.entries.filter(e => e.key !== key) } : null);
  };

  if (!data) return <div class="p-8 text-gray-400">Loading...</div>;

  return (
    <div class="p-8">
      <Breadcrumb items={[
        { label: "Durable Objects", href: "#/do" },
        { label: ns, href: `#/do/${encodeURIComponent(ns)}` },
        { label: id.slice(0, 16) + "..." },
      ]} />
      {data.alarm && (
        <div class="mb-4 px-4 py-2 bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400 rounded text-sm">
          Alarm set for: {formatTime(data.alarm)}
        </div>
      )}
      {data.entries.length === 0 ? (
        <EmptyState message="No storage entries" />
      ) : (
        <Table
          headers={["Key", "Value", ""]}
          rows={data.entries.map(e => [
            <span class="font-mono text-xs">{e.key}</span>,
            <pre class="text-xs max-w-lg truncate">{e.value}</pre>,
            <button onClick={() => deleteEntry(e.key)} class="text-red-500 hover:text-red-700 text-xs">Delete</button>,
          ])}
        />
      )}
    </div>
  );
}

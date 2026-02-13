import { useState, useEffect } from "preact/hooks";
import { api, formatTime } from "../lib";
import { EmptyState, Breadcrumb, Table } from "./kv";

interface Queue {
  queue: string;
  pending: number;
  acked: number;
  failed: number;
}

interface QueueMessage {
  id: string;
  body: string;
  content_type: string;
  status: string;
  attempts: number;
  visible_at: number;
  created_at: number;
  completed_at: number | null;
}

export function QueueView({ route }: { route: string }) {
  const parts = route.split("/").filter(Boolean);
  if (parts.length === 1) return <QueueList />;
  if (parts.length >= 2) return <QueueMessages name={decodeURIComponent(parts[1]!)} />;
  return null;
}

function QueueList() {
  const [queues, setQueues] = useState<Queue[]>([]);

  useEffect(() => {
    api<Queue[]>("/queue").then(setQueues);
  }, []);

  return (
    <div class="p-8">
      <h1 class="text-2xl font-bold mb-6">Queues</h1>
      {queues.length === 0 ? (
        <EmptyState message="No queues found" />
      ) : (
        <Table
          headers={["Queue", "Pending", "Acked", "Failed"]}
          rows={queues.map(q => [
            <a href={`#/queue/${encodeURIComponent(q.queue)}`} class="text-orange-600 dark:text-orange-400 hover:underline">{q.queue}</a>,
            q.pending,
            q.acked,
            q.failed,
          ])}
        />
      )}
    </div>
  );
}

const STATUS_BADGE: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
  acked: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  failed: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
};

function QueueMessages({ name }: { name: string }) {
  const [messages, setMessages] = useState<QueueMessage[]>([]);
  const [filter, setFilter] = useState("");

  const load = () => {
    const qs = filter ? `?status=${filter}` : "";
    api<QueueMessage[]>(`/queue/${encodeURIComponent(name)}${qs}`).then(setMessages);
  };

  useEffect(() => { load(); }, [name, filter]);

  const deleteMsg = async (id: string) => {
    if (!confirm("Delete this message?")) return;
    await api(`/queue/${encodeURIComponent(name)}/${encodeURIComponent(id)}`, { method: "DELETE" });
    setMessages(prev => prev.filter(m => m.id !== id));
  };

  return (
    <div class="p-8">
      <Breadcrumb items={[{ label: "Queues", href: "#/queue" }, { label: name }]} />
      <div class="mb-4 flex gap-2">
        {["", "pending", "acked", "failed"].map(s => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            class={`px-3 py-1 text-sm rounded-md border ${filter === s ? "bg-orange-100 dark:bg-orange-900 border-orange-400 text-orange-800 dark:text-orange-200" : "border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800"}`}
          >
            {s || "All"}
          </button>
        ))}
      </div>
      {messages.length === 0 ? (
        <EmptyState message="No messages found" />
      ) : (
        <Table
          headers={["ID", "Body", "Status", "Attempts", "Created", "Completed", ""]}
          rows={messages.map(m => [
            <span class="font-mono text-xs">{m.id.slice(0, 12)}...</span>,
            <pre class="text-xs max-w-md truncate">{m.body}</pre>,
            <span class={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_BADGE[m.status] ?? ""}`}>{m.status}</span>,
            m.attempts,
            formatTime(m.created_at),
            m.completed_at ? formatTime(m.completed_at) : "—",
            <button onClick={() => deleteMsg(m.id)} class="text-red-500 hover:text-red-700 text-xs">Delete</button>,
          ])}
        />
      )}
    </div>
  );
}

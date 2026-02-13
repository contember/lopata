import { useState, useEffect } from "preact/hooks";
import { api, formatTime } from "../lib";
import { EmptyState, Breadcrumb, Table } from "./kv";

interface Queue {
  queue: string;
  count: number;
}

interface QueueMessage {
  id: string;
  body: string;
  content_type: string;
  attempts: number;
  visible_at: number;
  created_at: number;
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
          headers={["Queue", "Messages"]}
          rows={queues.map(q => [
            <a href={`#/queue/${encodeURIComponent(q.queue)}`} class="text-orange-600 dark:text-orange-400 hover:underline">{q.queue}</a>,
            q.count,
          ])}
        />
      )}
    </div>
  );
}

function QueueMessages({ name }: { name: string }) {
  const [messages, setMessages] = useState<QueueMessage[]>([]);

  useEffect(() => {
    api<QueueMessage[]>(`/queue/${encodeURIComponent(name)}`).then(setMessages);
  }, [name]);

  const deleteMsg = async (id: string) => {
    if (!confirm("Delete this message?")) return;
    await api(`/queue/${encodeURIComponent(name)}/${encodeURIComponent(id)}`, { method: "DELETE" });
    setMessages(prev => prev.filter(m => m.id !== id));
  };

  return (
    <div class="p-8">
      <Breadcrumb items={[{ label: "Queues", href: "#/queue" }, { label: name }]} />
      {messages.length === 0 ? (
        <EmptyState message="No messages in queue" />
      ) : (
        <Table
          headers={["ID", "Body", "Attempts", "Created", ""]}
          rows={messages.map(m => [
            <span class="font-mono text-xs">{m.id.slice(0, 12)}...</span>,
            <pre class="text-xs max-w-md truncate">{m.body}</pre>,
            m.attempts,
            formatTime(m.created_at),
            <button onClick={() => deleteMsg(m.id)} class="text-red-500 hover:text-red-700 text-xs">Delete</button>,
          ])}
        />
      )}
    </div>
  );
}

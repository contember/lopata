import { useState, useEffect } from "preact/hooks";
import { api, formatTime } from "../lib";
import { EmptyState, Breadcrumb, Table, PageHeader, PillButton, DeleteButton, TableLink, StatusBadge } from "../components";

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

const QUEUE_STATUS_COLORS: Record<string, string> = {
  pending: "bg-amber-100 text-amber-700",
  acked: "bg-emerald-100 text-emerald-700",
  failed: "bg-red-100 text-red-700",
};

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
      <PageHeader title="Queues" subtitle={`${queues.length} queue(s)`} />
      {queues.length === 0 ? (
        <EmptyState message="No queues found" />
      ) : (
        <Table
          headers={["Queue", "Pending", "Acked", "Failed"]}
          rows={queues.map(q => [
            <TableLink href={`#/queue/${encodeURIComponent(q.queue)}`}>{q.queue}</TableLink>,
            <span class="font-bold">{q.pending}</span>,
            <span class="font-bold">{q.acked}</span>,
            <span class="font-bold">{q.failed}</span>,
          ])}
        />
      )}
    </div>
  );
}

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
      <div class="mb-6 flex gap-2">
        {["", "pending", "acked", "failed"].map(s => (
          <PillButton key={s} onClick={() => setFilter(s)} active={filter === s}>
            {s || "All"}
          </PillButton>
        ))}
      </div>
      {messages.length === 0 ? (
        <EmptyState message="No messages found" />
      ) : (
        <Table
          headers={["ID", "Body", "Status", "Attempts", "Created", "Completed", ""]}
          rows={messages.map(m => [
            <span class="font-mono text-xs">{m.id.slice(0, 12)}...</span>,
            <pre class="text-xs max-w-md truncate font-mono">{m.body}</pre>,
            <StatusBadge status={m.status} colorMap={QUEUE_STATUS_COLORS} />,
            m.attempts,
            formatTime(m.created_at),
            m.completed_at ? formatTime(m.completed_at) : "—",
            <DeleteButton onClick={() => deleteMsg(m.id)} />,
          ])}
        />
      )}
    </div>
  );
}

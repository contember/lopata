import { useState } from "preact/hooks";
import { formatTime } from "../lib";
import { useQuery, useMutation } from "../rpc/hooks";
import { EmptyState, Breadcrumb, Table, PageHeader, PillButton, DeleteButton, TableLink, StatusBadge } from "../components";

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
  const { data: queues } = useQuery("queue.listQueues");

  return (
    <div class="p-8">
      <PageHeader title="Queues" subtitle={`${queues?.length ?? 0} queue(s)`} />
      {!queues?.length ? (
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
  const [filter, setFilter] = useState("");
  const { data: messages, refetch } = useQuery("queue.listMessages", { queue: name, status: filter || undefined });
  const deleteMsg = useMutation("queue.deleteMessage");

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this message?")) return;
    await deleteMsg.mutate({ queue: name, id });
    refetch();
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
      {!messages?.length ? (
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
            <DeleteButton onClick={() => handleDelete(m.id)} />,
          ])}
        />
      )}
    </div>
  );
}

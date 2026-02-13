import { useState, useEffect } from "preact/hooks";
import { api, formatTime } from "../lib";
import { EmptyState, Breadcrumb, Table } from "./kv";

interface WorkflowSummary {
  name: string;
  total: number;
  byStatus: Record<string, number>;
}

interface WorkflowInstance {
  id: string;
  status: string;
  params: string | null;
  output: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

interface WorkflowDetail extends WorkflowInstance {
  steps: { step_name: string; output: string | null; completed_at: number }[];
  events: { id: number; event_type: string; payload: string | null; created_at: number }[];
}

const STATUS_COLORS: Record<string, string> = {
  running: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
  complete: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400",
  errored: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
  terminated: "bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span class={`px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[status] ?? "bg-gray-100 text-gray-800"}`}>
      {status}
    </span>
  );
}

export function WorkflowsView({ route }: { route: string }) {
  const parts = route.split("/").filter(Boolean);
  if (parts.length === 1) return <WorkflowList />;
  if (parts.length === 2) return <WorkflowInstanceList name={decodeURIComponent(parts[1]!)} />;
  if (parts.length >= 3) return <WorkflowInstanceDetail name={decodeURIComponent(parts[1]!)} id={decodeURIComponent(parts[2]!)} />;
  return null;
}

function WorkflowList() {
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);

  useEffect(() => {
    api<WorkflowSummary[]>("/workflows").then(setWorkflows);
  }, []);

  return (
    <div class="p-8">
      <h1 class="text-2xl font-bold mb-6">Workflows</h1>
      {workflows.length === 0 ? (
        <EmptyState message="No workflow instances found" />
      ) : (
        <Table
          headers={["Workflow", "Total", "Running", "Complete", "Errored"]}
          rows={workflows.map(w => [
            <a href={`#/workflows/${encodeURIComponent(w.name)}`} class="text-orange-600 dark:text-orange-400 hover:underline">{w.name}</a>,
            w.total,
            w.byStatus.running ?? 0,
            w.byStatus.complete ?? 0,
            w.byStatus.errored ?? 0,
          ])}
        />
      )}
    </div>
  );
}

function WorkflowInstanceList({ name }: { name: string }) {
  const [instances, setInstances] = useState<WorkflowInstance[]>([]);
  const [statusFilter, setStatusFilter] = useState("");

  useEffect(() => {
    const qs = statusFilter ? `?status=${statusFilter}` : "";
    api<WorkflowInstance[]>(`/workflows/${encodeURIComponent(name)}${qs}`).then(setInstances);
  }, [name, statusFilter]);

  return (
    <div class="p-8">
      <Breadcrumb items={[{ label: "Workflows", href: "#/workflows" }, { label: name }]} />
      <div class="mb-4">
        <select
          value={statusFilter}
          onChange={e => setStatusFilter((e.target as HTMLSelectElement).value)}
          class="px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-md bg-white dark:bg-gray-900 text-sm"
        >
          <option value="">All statuses</option>
          <option value="running">Running</option>
          <option value="complete">Complete</option>
          <option value="errored">Errored</option>
          <option value="terminated">Terminated</option>
        </select>
      </div>
      {instances.length === 0 ? (
        <EmptyState message="No instances found" />
      ) : (
        <Table
          headers={["Instance ID", "Status", "Created", "Updated", ""]}
          rows={instances.map(inst => [
            <a href={`#/workflows/${encodeURIComponent(name)}/${encodeURIComponent(inst.id)}`} class="text-orange-600 dark:text-orange-400 hover:underline font-mono text-xs">{inst.id.slice(0, 16)}...</a>,
            <StatusBadge status={inst.status} />,
            formatTime(inst.created_at),
            formatTime(inst.updated_at),
            inst.status === "running" ? (
              <button
                onClick={async () => {
                  if (!confirm("Terminate this workflow?")) return;
                  await api(`/workflows/${encodeURIComponent(name)}/${encodeURIComponent(inst.id)}/terminate`, { method: "POST" });
                  setInstances(prev => prev.map(i => i.id === inst.id ? { ...i, status: "terminated" } : i));
                }}
                class="text-red-500 hover:text-red-700 text-xs"
              >
                Terminate
              </button>
            ) : null,
          ])}
        />
      )}
    </div>
  );
}

function WorkflowInstanceDetail({ name, id }: { name: string; id: string }) {
  const [data, setData] = useState<WorkflowDetail | null>(null);

  useEffect(() => {
    api<WorkflowDetail>(`/workflows/${encodeURIComponent(name)}/${encodeURIComponent(id)}`).then(setData);
  }, [name, id]);

  if (!data) return <div class="p-8 text-gray-400">Loading...</div>;

  return (
    <div class="p-8">
      <Breadcrumb items={[
        { label: "Workflows", href: "#/workflows" },
        { label: name, href: `#/workflows/${encodeURIComponent(name)}` },
        { label: id.slice(0, 16) + "..." },
      ]} />

      <div class="flex items-center gap-3 mb-6">
        <StatusBadge status={data.status} />
        <span class="text-sm text-gray-500">Created: {formatTime(data.created_at)}</span>
      </div>

      {data.params && (
        <div class="mb-6">
          <h3 class="text-sm font-medium text-gray-500 mb-2">Parameters</h3>
          <pre class="bg-gray-100 dark:bg-gray-900 p-3 rounded text-xs overflow-x-auto">{data.params}</pre>
        </div>
      )}

      {data.output && (
        <div class="mb-6">
          <h3 class="text-sm font-medium text-gray-500 mb-2">Output</h3>
          <pre class="bg-gray-100 dark:bg-gray-900 p-3 rounded text-xs overflow-x-auto">{data.output}</pre>
        </div>
      )}

      {data.error && (
        <div class="mb-6">
          <h3 class="text-sm font-medium text-gray-500 mb-2">Error</h3>
          <pre class="bg-red-50 dark:bg-red-950/30 p-3 rounded text-xs text-red-700 dark:text-red-400 overflow-x-auto">{data.error}</pre>
        </div>
      )}

      <div class="mb-6">
        <h3 class="text-sm font-medium text-gray-500 mb-2">Steps ({data.steps.length})</h3>
        {data.steps.length === 0 ? (
          <div class="text-gray-400 text-sm">No steps completed yet</div>
        ) : (
          <Table
            headers={["Step", "Output", "Completed"]}
            rows={data.steps.map(s => [
              <span class="font-mono text-xs">{s.step_name}</span>,
              s.output ? <pre class="text-xs max-w-md truncate">{s.output}</pre> : "—",
              formatTime(s.completed_at),
            ])}
          />
        )}
      </div>

      {data.events.length > 0 && (
        <div>
          <h3 class="text-sm font-medium text-gray-500 mb-2">Events ({data.events.length})</h3>
          <Table
            headers={["Type", "Payload", "Time"]}
            rows={data.events.map(e => [
              <span class="font-mono text-xs">{e.event_type}</span>,
              e.payload ? <pre class="text-xs max-w-md truncate">{e.payload}</pre> : "—",
              formatTime(e.created_at),
            ])}
          />
        </div>
      )}
    </div>
  );
}

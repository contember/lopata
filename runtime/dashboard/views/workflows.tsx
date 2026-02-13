import { useState, useEffect } from "preact/hooks";
import { api, formatTime } from "../lib";
import { EmptyState, Breadcrumb, Table, PageHeader, CodeBlock, TableLink, StatusBadge } from "../components";

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

const WORKFLOW_STATUS_COLORS: Record<string, string> = {
  running: "bg-accent-blue text-ink",
  complete: "bg-emerald-100 text-emerald-700",
  errored: "bg-red-100 text-red-700",
  terminated: "bg-gray-200 text-gray-600",
};

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
      <PageHeader title="Workflows" subtitle={`${workflows.length} workflow(s)`} />
      {workflows.length === 0 ? (
        <EmptyState message="No workflow instances found" />
      ) : (
        <Table
          headers={["Workflow", "Total", "Running", "Complete", "Errored"]}
          rows={workflows.map(w => [
            <TableLink href={`#/workflows/${encodeURIComponent(w.name)}`}>{w.name}</TableLink>,
            <span class="font-bold">{w.total}</span>,
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
      <div class="mb-6">
        <select
          value={statusFilter}
          onChange={e => setStatusFilter((e.target as HTMLSelectElement).value)}
          class="bg-surface-raised border-none rounded-2xl px-5 py-3 text-sm outline-none focus:bg-white focus:shadow-focus transition-all appearance-none pr-10"
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
            <TableLink href={`#/workflows/${encodeURIComponent(name)}/${encodeURIComponent(inst.id)}`} mono>{inst.id.slice(0, 16)}...</TableLink>,
            <StatusBadge status={inst.status} colorMap={WORKFLOW_STATUS_COLORS} />,
            formatTime(inst.created_at),
            formatTime(inst.updated_at),
            inst.status === "running" ? (
              <button
                onClick={async () => {
                  if (!confirm("Terminate this workflow?")) return;
                  await api(`/workflows/${encodeURIComponent(name)}/${encodeURIComponent(inst.id)}/terminate`, { method: "POST" });
                  setInstances(prev => prev.map(i => i.id === inst.id ? { ...i, status: "terminated" } : i));
                }}
                class="text-red-400 hover:text-red-600 text-xs font-medium rounded-full px-3 py-1 hover:bg-red-50 transition-all"
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

  if (!data) return <div class="p-8 text-gray-400 font-medium">Loading...</div>;

  return (
    <div class="p-8">
      <Breadcrumb items={[
        { label: "Workflows", href: "#/workflows" },
        { label: name, href: `#/workflows/${encodeURIComponent(name)}` },
        { label: id.slice(0, 16) + "..." },
      ]} />

      <div class="flex items-center gap-4 mb-8">
        <StatusBadge status={data.status} colorMap={WORKFLOW_STATUS_COLORS} />
        <span class="text-sm text-gray-400 font-medium">Created: {formatTime(data.created_at)}</span>
      </div>

      {data.params && (
        <div class="mb-6 bg-white rounded-card shadow-card p-5">
          <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Parameters</h3>
          <CodeBlock>{data.params}</CodeBlock>
        </div>
      )}

      {data.output && (
        <div class="mb-6 bg-white rounded-card shadow-card p-5">
          <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Output</h3>
          <CodeBlock>{data.output}</CodeBlock>
        </div>
      )}

      {data.error && (
        <div class="mb-6 bg-white rounded-card shadow-card p-5">
          <h3 class="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Error</h3>
          <pre class="bg-red-50 rounded-2xl p-5 text-xs text-red-600 overflow-x-auto font-mono">{data.error}</pre>
        </div>
      )}

      <div class="mb-6">
        <h3 class="text-sm font-semibold text-ink mb-4">Steps ({data.steps.length})</h3>
        {data.steps.length === 0 ? (
          <div class="text-gray-400 text-sm font-medium">No steps completed yet</div>
        ) : (
          <Table
            headers={["Step", "Output", "Completed"]}
            rows={data.steps.map(s => [
              <span class="font-mono text-xs font-medium">{s.step_name}</span>,
              s.output ? <pre class="text-xs max-w-md truncate font-mono">{s.output}</pre> : "—",
              formatTime(s.completed_at),
            ])}
          />
        )}
      </div>

      {data.events.length > 0 && (
        <div>
          <h3 class="text-sm font-semibold text-ink mb-4">Events ({data.events.length})</h3>
          <Table
            headers={["Type", "Payload", "Time"]}
            rows={data.events.map(e => [
              <span class="font-mono text-xs font-medium">{e.event_type}</span>,
              e.payload ? <pre class="text-xs max-w-md truncate font-mono">{e.payload}</pre> : "—",
              formatTime(e.created_at),
            ])}
          />
        </div>
      )}
    </div>
  );
}

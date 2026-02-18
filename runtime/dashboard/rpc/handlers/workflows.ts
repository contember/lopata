import type { HandlerContext, WorkflowSummary, WorkflowInstance, WorkflowDetail, OkResponse } from "../types";
import { getAllConfigs } from "../types";
import { getDatabase } from "../../../db";
import type { SQLQueryBindings } from "bun:sqlite";
import type { SqliteWorkflowBinding } from "../../../bindings/workflow";

function getWorkflowBinding(ctx: HandlerContext, name: string): SqliteWorkflowBinding {
  if (ctx.registry) {
    for (const manager of ctx.registry.listManagers().values()) {
      const gen = manager.active;
      if (!gen) continue;
      const entry = gen.registry.workflows.find(w => w.bindingName === name);
      if (entry) return entry.binding;
    }
  }
  if (ctx.manager?.active) {
    const entry = ctx.manager.active.registry.workflows.find(w => w.bindingName === name);
    if (entry) return entry.binding;
  }
  throw new Error(`Workflow binding "${name}" not found`);
}

export const handlers = {
  "workflows.list"(_input: {}, ctx: HandlerContext): WorkflowSummary[] {
    const db = getDatabase();
    const rows = db.query<{ workflow_name: string; status: string; count: number }, []>(
      "SELECT workflow_name, status, COUNT(*) as count FROM workflow_instances GROUP BY workflow_name, status ORDER BY workflow_name"
    ).all();

    const grouped = new Map<string, { total: number; byStatus: Record<string, number> }>();
    for (const row of rows) {
      let entry = grouped.get(row.workflow_name);
      if (!entry) {
        entry = { total: 0, byStatus: {} };
        grouped.set(row.workflow_name, entry);
      }
      entry.total += row.count;
      entry.byStatus[row.status] = row.count;
    }

    for (const config of getAllConfigs(ctx)) {
      for (const w of config.workflows ?? []) {
        if (!grouped.has(w.binding)) {
          grouped.set(w.binding, { total: 0, byStatus: {} });
        }
      }
    }

    return Array.from(grouped.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, data]) => ({ name, ...data }));
  },

  "workflows.listInstances"({ name, status }: { name: string; status?: string }): WorkflowInstance[] {
    const db = getDatabase();
    let query = "SELECT id, status, params, output, error, created_at, updated_at FROM workflow_instances WHERE workflow_name = ?";
    const params: SQLQueryBindings[] = [name];

    if (status) { query += " AND status = ?"; params.push(status); }
    query += " ORDER BY created_at DESC LIMIT 100";

    return db.prepare(query).all(...params) as WorkflowInstance[];
  },

  "workflows.getInstance"({ id }: { name: string; id: string }): WorkflowDetail {
    const db = getDatabase();
    const instance = db.query<Record<string, unknown>, [string]>(
      "SELECT * FROM workflow_instances WHERE id = ?"
    ).get(id);
    if (!instance) throw new Error("Workflow instance not found");

    const steps = db.query<{ step_name: string; output: string | null; completed_at: number }, [string]>(
      "SELECT step_name, output, completed_at FROM workflow_steps WHERE instance_id = ? ORDER BY completed_at"
    ).all(id);

    const events = db.query<{ id: number; event_type: string; payload: string | null; created_at: number }, [string]>(
      "SELECT id, event_type, payload, created_at FROM workflow_events WHERE instance_id = ? ORDER BY created_at"
    ).all(id);

    return { ...instance, steps, events } as WorkflowDetail;
  },

  async "workflows.terminate"({ name, id }: { name: string; id: string }, ctx: HandlerContext): Promise<OkResponse> {
    const binding = getWorkflowBinding(ctx, name);
    const instance = await binding.get(id);
    await instance.terminate();
    return { ok: true };
  },

  async "workflows.create"({ name, params }: { name: string; params: string }, ctx: HandlerContext): Promise<{ ok: true; id: string }> {
    const binding = getWorkflowBinding(ctx, name);
    const parsed = JSON.parse(params);
    const instance = await binding.create({ params: parsed });
    return { ok: true, id: instance.id };
  },

  async "workflows.pause"({ name, id }: { name: string; id: string }, ctx: HandlerContext): Promise<OkResponse> {
    const binding = getWorkflowBinding(ctx, name);
    const instance = await binding.get(id);
    await instance.pause();
    return { ok: true };
  },

  async "workflows.resume"({ name, id }: { name: string; id: string }, ctx: HandlerContext): Promise<OkResponse> {
    const binding = getWorkflowBinding(ctx, name);
    const instance = await binding.get(id);
    await instance.resume();
    return { ok: true };
  },

  async "workflows.restart"({ name, id, fromStep }: { name: string; id: string; fromStep?: string }, ctx: HandlerContext): Promise<OkResponse> {
    const binding = getWorkflowBinding(ctx, name);
    const instance = await binding.get(id);
    await instance.restart(fromStep ? { fromStep } : undefined);
    return { ok: true };
  },

  async "workflows.duplicate"({ name, id }: { name: string; id: string }, ctx: HandlerContext): Promise<{ ok: true; id: string }> {
    const binding = getWorkflowBinding(ctx, name);
    const db = getDatabase();
    const row = db.query<{ params: string | null }, [string]>(
      "SELECT params FROM workflow_instances WHERE id = ?"
    ).get(id);
    if (!row) throw new Error("Workflow instance not found");
    const params = row.params !== null ? JSON.parse(row.params) : {};
    const newInstance = await binding.create({ params });
    return { ok: true, id: newInstance.id };
  },
};

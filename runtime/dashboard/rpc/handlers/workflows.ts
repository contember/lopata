import type { HandlerContext, WorkflowSummary, WorkflowInstance, WorkflowDetail, OkResponse } from "../types";
import { getAllConfigs } from "../types";
import { getDatabase } from "../../../db";
import type { SQLQueryBindings } from "bun:sqlite";

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

  "workflows.terminate"({ id }: { name: string; id: string }): OkResponse {
    const db = getDatabase();
    db.prepare("UPDATE workflow_instances SET status = 'terminated', updated_at = ? WHERE id = ? AND status = 'running'").run(Date.now(), id);
    return { ok: true };
  },
};

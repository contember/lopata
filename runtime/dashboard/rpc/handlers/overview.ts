import type { HandlerContext, OverviewData } from "../types";
import { getAllConfigs } from "../types";
import { getDatabase, getDataDir } from "../../../db";
import { getTraceStore } from "../../../tracing/store";
import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";

export const handlers = {
  "overview.get"(_input: {}, ctx: HandlerContext): OverviewData {
    const db = getDatabase();

    const d1Dir = join(getDataDir(), "d1");
    let d1Count = 0;
    if (existsSync(d1Dir)) {
      d1Count = readdirSync(d1Dir).filter(f => f.endsWith(".sqlite")).length;
    }

    const dbContainers = new Set<string>();
    const dbKv = new Set(db.query<{ namespace: string }, []>("SELECT DISTINCT namespace FROM kv").all().map(r => r.namespace));
    const dbR2 = new Set(db.query<{ bucket: string }, []>("SELECT DISTINCT bucket FROM r2_objects").all().map(r => r.bucket));
    const dbQueue = new Set(db.query<{ queue: string }, []>("SELECT DISTINCT queue FROM queue_messages").all().map(r => r.queue));
    const dbDo = new Set(db.query<{ namespace: string }, []>("SELECT DISTINCT namespace FROM do_storage").all().map(r => r.namespace));
    const dbWorkflows = new Set(db.query<{ workflow_name: string }, []>("SELECT DISTINCT workflow_name FROM workflow_instances").all().map(r => r.workflow_name));

    for (const config of getAllConfigs(ctx)) {
      for (const ns of config.kv_namespaces ?? []) dbKv.add(ns.id);
      for (const b of config.r2_buckets ?? []) dbR2.add(b.bucket_name);
      for (const p of config.queues?.producers ?? []) dbQueue.add(p.queue);
      for (const b of config.durable_objects?.bindings ?? []) dbDo.add(b.class_name);
      for (const w of config.workflows ?? []) dbWorkflows.add(w.binding);
      for (const c of config.containers ?? []) dbContainers.add(c.class_name);
      d1Count = Math.max(d1Count, (config.d1_databases ?? []).length);
    }

    return {
      kv: dbKv.size,
      r2: dbR2.size,
      queue: dbQueue.size,
      do: dbDo.size,
      workflows: dbWorkflows.size,
      containers: dbContainers.size,
      d1: d1Count,
      cache: db.query<{ count: number }, []>("SELECT COUNT(DISTINCT cache_name) as count FROM cache_entries").get()?.count ?? 0,
      errors: getTraceStore().getErrorCount(),
      generations: ctx.manager ? ctx.manager.list() : [],
      ...(ctx.registry ? {
        workers: Array.from(ctx.registry.listManagers()).map(([name, mgr]) => ({
          workerName: name,
          generations: mgr.list(),
        })),
      } : {}),
    };
  },
};

import type { HandlerContext, WorkerInfo, WorkerBinding } from "../types";
import type { WranglerConfig } from "../../../config";

function extractBindings(config: WranglerConfig): WorkerBinding[] {
  const bindings: WorkerBinding[] = [];

  for (const ns of config.kv_namespaces ?? []) {
    bindings.push({ type: "kv", name: ns.binding, target: ns.id, href: `#/kv/${encodeURIComponent(ns.id)}` });
  }
  for (const b of config.r2_buckets ?? []) {
    bindings.push({ type: "r2", name: b.binding, target: b.bucket_name, href: `#/r2/${encodeURIComponent(b.bucket_name)}` });
  }
  for (const db of config.d1_databases ?? []) {
    bindings.push({ type: "d1", name: db.binding, target: db.database_name, href: `#/d1/${encodeURIComponent(db.database_name)}` });
  }
  for (const b of config.durable_objects?.bindings ?? []) {
    bindings.push({ type: "do", name: b.name, target: b.class_name, href: `#/do/${encodeURIComponent(b.class_name)}` });
  }
  for (const p of config.queues?.producers ?? []) {
    bindings.push({ type: "queue", name: p.binding, target: p.queue, href: `#/queue/${encodeURIComponent(p.queue)}` });
  }
  for (const w of config.workflows ?? []) {
    bindings.push({ type: "workflow", name: w.binding, target: w.class_name, href: `#/workflows/${encodeURIComponent(w.binding)}` });
  }
  for (const s of config.services ?? []) {
    const target = s.entrypoint ? `${s.service}#${s.entrypoint}` : s.service;
    bindings.push({ type: "service", name: s.binding, target, href: null });
  }
  if (config.images) {
    bindings.push({ type: "images", name: config.images.binding, target: "", href: null });
  }

  return bindings;
}

export const handlers = {
  "workers.list"(_input: {}, ctx: HandlerContext): WorkerInfo[] {
    if (ctx.registry) {
      const workers: WorkerInfo[] = [];
      let isFirst = true;
      for (const [name, mgr] of ctx.registry.listManagers()) {
        workers.push({
          name,
          isMain: isFirst,
          bindings: extractBindings(mgr.config),
        });
        isFirst = false;
      }
      return workers;
    }

    if (ctx.config) {
      return [{
        name: ctx.config.name || "main",
        isMain: true,
        bindings: extractBindings(ctx.config),
      }];
    }

    return [];
  },
};

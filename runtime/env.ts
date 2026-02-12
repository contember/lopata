import type { WranglerConfig } from "./config";
import { SqliteKVNamespace } from "./bindings/kv";
import { FileR2Bucket } from "./bindings/r2";
import { DurableObjectNamespaceImpl } from "./bindings/durable-object";
import { SqliteWorkflowBinding } from "./bindings/workflow";
import { openD1Database } from "./bindings/d1";
import { SqliteQueueProducer, QueueConsumer } from "./bindings/queue";
import { createServiceBinding } from "./bindings/service-binding";
import { getDatabase, getDataDir } from "./db";

export function parseDevVars(content: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

interface ConsumerConfig {
  queue: string;
  maxBatchSize: number;
  maxBatchTimeout: number;
  maxRetries: number;
  deadLetterQueue: string | null;
}

interface ServiceBindingEntry {
  bindingName: string;
  serviceName: string;
  entrypoint?: string;
  proxy: Record<string, unknown>;
}

interface ClassRegistry {
  durableObjects: { bindingName: string; className: string; namespace: DurableObjectNamespaceImpl }[];
  workflows: { bindingName: string; className: string; binding: SqliteWorkflowBinding }[];
  queueConsumers: ConsumerConfig[];
  serviceBindings: ServiceBindingEntry[];
}

export function buildEnv(config: WranglerConfig, devVarsPath?: string): { env: Record<string, unknown>; registry: ClassRegistry } {
  const env: Record<string, unknown> = {};
  const registry: ClassRegistry = { durableObjects: [], workflows: [], queueConsumers: [], serviceBindings: [] };

  // Environment variables from config
  if (config.vars) {
    for (const [key, value] of Object.entries(config.vars)) {
      env[key] = value;
    }
  }

  // Override with .dev.vars file (if exists)
  if (devVarsPath) {
    const { existsSync, readFileSync } = require("node:fs") as typeof import("node:fs");
    if (existsSync(devVarsPath)) {
      const content = readFileSync(devVarsPath, "utf-8");
      const devVars = parseDevVars(content);
      for (const [key, value] of Object.entries(devVars)) {
        env[key] = value;
      }
    }
  }

  // KV namespaces
  const db = getDatabase();
  for (const kv of config.kv_namespaces ?? []) {
    console.log(`[bunflare] KV namespace: ${kv.binding}`);
    env[kv.binding] = new SqliteKVNamespace(db, kv.binding);
  }

  // R2 buckets
  for (const r2 of config.r2_buckets ?? []) {
    console.log(`[bunflare] R2 bucket: ${r2.binding} (${r2.bucket_name})`);
    env[r2.binding] = new FileR2Bucket(db, r2.bucket_name, getDataDir());
  }

  // Durable Objects
  for (const doBinding of config.durable_objects?.bindings ?? []) {
    console.log(`[bunflare] Durable Object: ${doBinding.name} -> ${doBinding.class_name}`);
    const namespace = new DurableObjectNamespaceImpl(db, doBinding.class_name);
    env[doBinding.name] = namespace;
    registry.durableObjects.push({
      bindingName: doBinding.name,
      className: doBinding.class_name,
      namespace,
    });
  }

  // Workflows
  for (const wf of config.workflows ?? []) {
    console.log(`[bunflare] Workflow: ${wf.binding} -> ${wf.class_name}`);
    const binding = new SqliteWorkflowBinding(db, wf.binding, wf.class_name);
    env[wf.binding] = binding;
    registry.workflows.push({
      bindingName: wf.binding,
      className: wf.class_name,
      binding,
    });
  }

  // D1 databases
  for (const d1 of config.d1_databases ?? []) {
    console.log(`[bunflare] D1 database: ${d1.binding} (${d1.database_name})`);
    env[d1.binding] = openD1Database(getDataDir(), d1.database_name);
  }

  // Queue producers
  for (const producer of config.queues?.producers ?? []) {
    console.log(`[bunflare] Queue producer: ${producer.binding} -> ${producer.queue}`);
    env[producer.binding] = new SqliteQueueProducer(db, producer.queue, producer.delivery_delay ?? 0);
  }

  // Queue consumers (configs — actual consumers started in dev.ts after worker import)
  for (const consumer of config.queues?.consumers ?? []) {
    console.log(`[bunflare] Queue consumer: ${consumer.queue}`);
    registry.queueConsumers.push({
      queue: consumer.queue,
      maxBatchSize: consumer.max_batch_size ?? 10,
      maxBatchTimeout: consumer.max_batch_timeout ?? 5,
      maxRetries: consumer.max_retries ?? 3,
      deadLetterQueue: consumer.dead_letter_queue ?? null,
    });
  }

  // Service bindings
  for (const svc of config.services ?? []) {
    console.log(`[bunflare] Service binding: ${svc.binding} -> ${svc.service}${svc.entrypoint ? ` (${svc.entrypoint})` : ""}`);
    const proxy = createServiceBinding(svc.service, svc.entrypoint);
    env[svc.binding] = proxy;
    registry.serviceBindings.push({
      bindingName: svc.binding,
      serviceName: svc.service,
      entrypoint: svc.entrypoint,
      proxy,
    });
  }

  return { env, registry };
}

export function wireClassRefs(
  registry: ClassRegistry,
  workerModule: Record<string, unknown>,
  env: Record<string, unknown>,
) {
  for (const entry of registry.durableObjects) {
    const cls = workerModule[entry.className];
    if (!cls) throw new Error(`Durable Object class "${entry.className}" not exported from worker module`);
    entry.namespace._setClass(cls as any, env);
    console.log(`[bunflare] Wired DO class: ${entry.className}`);
  }

  for (const entry of registry.workflows) {
    const cls = workerModule[entry.className];
    if (!cls) throw new Error(`Workflow class "${entry.className}" not exported from worker module`);
    entry.binding._setClass(cls as any, env);
    console.log(`[bunflare] Wired Workflow class: ${entry.className}`);
  }

  // Wire service bindings (self-referencing same worker)
  for (const entry of registry.serviceBindings) {
    const wire = entry.proxy._wire as ((wm: Record<string, unknown>, e: Record<string, unknown>) => void) | undefined;
    if (wire) {
      wire(workerModule, env);
      console.log(`[bunflare] Wired service binding: ${entry.bindingName} -> ${entry.serviceName}${entry.entrypoint ? ` (${entry.entrypoint})` : ""}`);
    }
  }
}

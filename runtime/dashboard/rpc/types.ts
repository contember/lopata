// ─── Shared data types ───────────────────────────────────────────────

export type { GenerationInfo } from "../../generation";
import type { GenerationInfo } from "../../generation";

export interface Paginated<T> {
  items: T[];
  cursor: string | null;
}

export interface OkResponse {
  ok: true;
}

// Overview
export interface OverviewData {
  kv: number;
  r2: number;
  queue: number;
  do: number;
  workflows: number;
  d1: number;
  cache: number;
  errors: number;
  generations: GenerationInfo[];
}

// KV
export interface KvNamespace {
  namespace: string;
  count: number;
}

export interface KvKey {
  key: string;
  size: number;
  metadata: string | null;
  expiration: number | null;
}

export interface KvValue {
  key: string;
  value: string;
  metadata: unknown;
  expiration: number | null;
}

// R2
export interface R2Bucket {
  bucket: string;
  count: number;
  total_size: number;
}

export interface R2Object {
  key: string;
  size: number;
  etag: string;
  uploaded: string;
  http_metadata: string | null;
  custom_metadata: string | null;
}

// Queue
export interface QueueInfo {
  queue: string;
  pending: number;
  acked: number;
  failed: number;
}

export interface QueueMessage {
  id: string;
  body: string;
  content_type: string;
  status: string;
  attempts: number;
  visible_at: number;
  created_at: number;
  completed_at: number | null;
}

// Durable Objects
export interface DoNamespace {
  namespace: string;
  count: number;
}

export interface DoInstance {
  id: string;
  key_count: number;
  alarm: number | null;
}

export interface DoDetail {
  entries: { key: string; value: string }[];
  alarm: number | null;
}

// Workflows
export interface WorkflowSummary {
  name: string;
  total: number;
  byStatus: Record<string, number>;
}

export interface WorkflowInstance {
  id: string;
  status: string;
  params: string | null;
  output: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

export interface WorkflowDetail extends WorkflowInstance {
  steps: { step_name: string; output: string | null; completed_at: number }[];
  events: { id: number; event_type: string; payload: string | null; created_at: number }[];
}

// D1
export interface D1Database {
  name: string;
  tables: number;
}

export interface D1Table {
  name: string;
  sql: string;
  rows: number;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  count: number;
  message?: string;
  error?: string;
}

// Cache
export interface CacheName {
  cache_name: string;
  count: number;
}

export interface CacheEntry {
  url: string;
  status: number;
  headers: string;
  expires_at: number | null;
}

// Generations
export interface WorkerGenerations {
  workerName: string;
  generations: GenerationInfo[];
  gracePeriodMs: number;
}

export interface GenerationsData {
  generations: GenerationInfo[];
  gracePeriodMs: number;
  workers?: WorkerGenerations[];
}

// Workers
export interface WorkerBinding {
  type: string;
  name: string;
  target: string;
  href: string | null;
}

export interface WorkerInfo {
  name: string;
  isMain: boolean;
  bindings: WorkerBinding[];
}

// Errors
export interface ErrorSummary {
  id: string;
  timestamp: number;
  errorName: string;
  errorMessage: string;
  requestMethod: string | null;
  requestUrl: string | null;
  workerName: string | null;
  traceId: string | null;
  spanId: string | null;
  source: string | null;
}

export interface ErrorDetail {
  id: string;
  timestamp: number;
  traceId: string | null;
  spanId: string | null;
  source: string | null;
  data: {
    error: {
      name: string;
      message: string;
      stack: string;
      frames: Array<{
        file: string;
        line: number;
        column: number;
        function: string;
        source?: string[];
        sourceLine?: number;
      }>;
    };
    request: {
      method: string;
      url: string;
      headers: Record<string, string>;
    };
    env: Record<string, string>;
    bindings: Array<{ name: string; type: string }>;
    runtime: {
      bunVersion: string;
      platform: string;
      arch: string;
      workerName?: string;
      configName?: string;
    };
  };
}

export interface TraceErrorSummary {
  id: string;
  timestamp: number;
  errorName: string;
  errorMessage: string;
  source: string | null;
}

// Traces (re-export from tracing module)
export type { TraceSummary, TraceDetail, SpanData, SpanEventData, TraceEvent } from "../../tracing/types";

// ─── Handler context ─────────────────────────────────────────────────

import type { WranglerConfig } from "../../config";
import type { GenerationManager } from "../../generation-manager";
import type { WorkerRegistry } from "../../worker-registry";

export interface HandlerContext {
  config: WranglerConfig | null;
  manager: GenerationManager | null;
  registry: WorkerRegistry | null;
}

/** Collect configs from all workers (registry) or fall back to single config. */
export function getAllConfigs(ctx: HandlerContext): WranglerConfig[] {
  if (ctx.registry) {
    return Array.from(ctx.registry.listManagers().values()).map(m => m.config);
  }
  return ctx.config ? [ctx.config] : [];
}

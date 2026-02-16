import { getActiveContext, runWithContext, generateId, generateTraceId } from "./context";
import { getTraceStore } from "./store";
import type { SpanData } from "./types";

export interface SpanOptions {
  name: string;
  kind?: SpanData["kind"];
  attributes?: Record<string, unknown>;
  workerName?: string;
}

export async function startSpan<T>(opts: SpanOptions, fn: () => T | Promise<T>): Promise<T> {
  const store = getTraceStore();
  const parent = getActiveContext();

  const spanId = generateId();
  const traceId = parent?.traceId ?? generateTraceId();
  const parentSpanId = parent?.spanId ?? null;

  const span: SpanData = {
    spanId,
    traceId,
    parentSpanId,
    name: opts.name,
    kind: opts.kind ?? "internal",
    status: "unset",
    statusMessage: null,
    startTime: Date.now(),
    endTime: null,
    durationMs: null,
    attributes: opts.attributes ?? {},
    workerName: opts.workerName ?? null,
  };

  store.insertSpan(span);

  try {
    const result = await runWithContext({ traceId, spanId }, () => fn());
    const currentStatus = store.getSpanStatus(spanId);
    store.endSpan(spanId, Date.now(), currentStatus === "error" ? "error" : "ok");
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    store.endSpan(spanId, Date.now(), "error", message);
    store.addEvent({
      spanId,
      traceId,
      timestamp: Date.now(),
      name: "exception",
      level: "error",
      message,
      attributes: err instanceof Error ? { stack: err.stack } : {},
    });
    throw err;
  }
}

export function setSpanStatus(status: "ok" | "error", message?: string): void {
  const ctx = getActiveContext();
  if (!ctx) return;
  const store = getTraceStore();
  store.setSpanStatus(ctx.spanId, status, message ?? null);
}

export function setSpanAttribute(key: string, value: unknown): void {
  const ctx = getActiveContext();
  if (!ctx) return;
  const store = getTraceStore();
  store.updateAttributes(ctx.spanId, { [key]: value });
}

export function addSpanEvent(name: string, level: string, message: string, attrs?: Record<string, unknown>): void {
  const ctx = getActiveContext();
  if (!ctx) return;
  const store = getTraceStore();
  store.addEvent({
    spanId: ctx.spanId,
    traceId: ctx.traceId,
    timestamp: Date.now(),
    name,
    level,
    message,
    attributes: attrs ?? {},
  });
}

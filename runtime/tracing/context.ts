import { AsyncLocalStorage } from "node:async_hooks";

export interface SpanContext {
  traceId: string;
  spanId: string;
}

const storage = new AsyncLocalStorage<SpanContext>();

export function getActiveContext(): SpanContext | undefined {
  return storage.getStore();
}

export function runWithContext<T>(ctx: SpanContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function generateId(byteCount = 8): string {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

/** Generate a 128-bit trace ID (OTel standard: 16 bytes / 32 hex chars) */
export function generateTraceId(): string {
  return generateId(16);
}

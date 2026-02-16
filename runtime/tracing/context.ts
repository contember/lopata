import { AsyncLocalStorage } from "node:async_hooks";

export interface SpanContext {
  traceId: string;
  spanId: string;
}

const storage = new AsyncLocalStorage<SpanContext>();

// Fallback context for spans that skip ALS (to preserve async stack traces).
// ALS.run() in Bun/JSC destroys async stack frames after real I/O.
// The main request span uses this fallback; sub-spans (binding instrumentation)
// use ALS normally. With concurrent requests the fallback may produce wrong
// parent references, but that's acceptable for a dev server.
let fallbackContext: SpanContext | undefined = undefined;

export function getActiveContext(): SpanContext | undefined {
  return storage.getStore() ?? fallbackContext;
}

export function runWithContext<T>(ctx: SpanContext, fn: () => T, skipAls = false): T {
  if (skipAls) {
    const prev = fallbackContext;
    fallbackContext = ctx;
    try {
      return fn();
    } finally {
      fallbackContext = prev;
    }
  }
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

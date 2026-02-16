import { AsyncLocalStorage } from "node:async_hooks";

/** Mutable ref shared across all spans in the same trace. Allows fetch()
 *  call-site stacks captured in sub-spans to be visible in the root span's
 *  error handler. */
export interface FetchStackRef {
  current: Error | null;
}

export interface SpanContext {
  traceId: string;
  spanId: string;
  /** Shared ref to the last stack captured at an outbound fetch() call site.
   *  Used to reconstruct async stack traces broken by .then() in third-party
   *  libraries (e.g. GraphQL clients). The synchronous stack at the fetch()
   *  call still contains the user's code frames — we stitch it onto caught
   *  errors. */
  fetchStack: FetchStackRef;
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

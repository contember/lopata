import { startSpan } from "./span";
import type { SpanData } from "./types";

/** Append caller frames to an error stack when Bun/JSC loses async context (ALS.run, .then). */
function stitchAsyncStack(err: Error, callerError: Error): void {
  if (!err.stack || !callerError.stack) return;
  if (err.stack.includes("--- async ---")) return;

  const errFrames = err.stack.split("\n").filter(l => l.trim().startsWith("at "));
  if (errFrames.length > 5 && !err.stack.includes("processTicksAndRejections")) return;

  const callerLines = callerError.stack.split("\n").slice(1);
  const filtered = callerLines.filter(l => !l.includes("/bunflare/runtime/"));
  if (filtered.length === 0) return;

  err.stack += "\n    --- async ---\n" + filtered.join("\n");
}

interface InstrumentConfig {
  type: string;
  name: string;
  methods: string[];
  kind?: SpanData["kind"];
}

function wrapMethod(target: Function, type: string, bindingName: string, method: string, kind: SpanData["kind"]): Function {
  return wrapMethodWithExtraAttrs(target, type, bindingName, method, kind, {});
}

function wrapMethodWithExtraAttrs(target: Function, type: string, bindingName: string, method: string, kind: SpanData["kind"], extraAttrs: Record<string, unknown>): Function {
  return function (this: unknown, ...args: unknown[]) {
    const attrs: Record<string, unknown> = {
      "binding.type": type,
      "binding.name": bindingName,
      ...extraAttrs,
    };
    if (args.length > 0 && typeof args[0] === "string") {
      attrs["binding.key"] = args[0];
    }
    return startSpan(
      { name: `${type}.${method}`, kind, attributes: attrs },
      () => target.apply(this, args),
    );
  };
}

export function instrumentBinding<T extends object>(binding: T, config: InstrumentConfig): T {
  const kind = config.kind ?? "client";
  const methodSet = new Set(config.methods);

  return new Proxy(binding, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof prop === "string" && methodSet.has(prop) && typeof value === "function") {
        return wrapMethod(value, config.type, config.name, prop, kind);
      }
      return value;
    },
  });
}

/**
 * Wrap D1 database: instrument statement execution methods (first, all, run, raw),
 * not prepare() itself.
 */
export function instrumentD1<T extends object>(binding: T, name: string): T {
  return new Proxy(binding, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (prop === "prepare" && typeof value === "function") {
        return function (this: unknown, ...args: unknown[]) {
          const stmt = value.apply(obj, args);
          if (typeof stmt !== "object" || stmt === null) return stmt;
          const sql = typeof args[0] === "string" ? args[0] : undefined;
          return wrapD1Stmt(stmt, name, sql);
        };
      }
      // Also instrument batch and exec directly
      if ((prop === "batch" || prop === "exec" || prop === "dump") && typeof value === "function") {
        return wrapMethod(value, "d1", name, prop as string, "client");
      }
      // withSession() returns a new database-like object — wrap it with the same instrumentation
      if (prop === "withSession" && typeof value === "function") {
        return function (this: unknown, ...args: unknown[]) {
          const session = value.apply(obj, args);
          if (typeof session === "object" && session !== null) {
            return instrumentD1(session, name);
          }
          return session;
        };
      }
      return value;
    },
  });
}

function wrapD1Stmt(stmt: object, name: string, sql: string | undefined): object {
  const stmtMethods = ["first", "all", "run", "raw"];
  return new Proxy(stmt, {
    get(s, sProp, sReceiver) {
      const sValue = Reflect.get(s, sProp, sReceiver);
      if (typeof sProp === "string" && stmtMethods.includes(sProp) && typeof sValue === "function") {
        return wrapMethodWithExtraAttrs(sValue.bind(s), "d1", name, sProp, "client", sql ? { "db.statement": sql } : {});
      }
      // bind() returns a new statement — re-wrap it so execution methods stay instrumented
      if (sProp === "bind" && typeof sValue === "function") {
        return function (this: unknown, ...args: unknown[]) {
          const bound = sValue.apply(s, args);
          if (typeof bound === "object" && bound !== null) {
            return wrapD1Stmt(bound, name, sql);
          }
          return bound;
        };
      }
      return sValue;
    },
  });
}

/**
 * Wrap DO namespace: get() returns a wrapped stub where fetch() and RPC methods are traced.
 */
export function instrumentDONamespace<T extends object>(namespace: T, className: string): T {
  return new Proxy(namespace, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (prop === "get" && typeof value === "function") {
        return function (this: unknown, ...args: unknown[]) {
          const stub = value.apply(obj, args);
          if (typeof stub !== "object" || stub === null) return stub;
          return instrumentDOStub(stub, className);
        };
      }
      return value;
    },
  });
}

function instrumentDOStub<T extends object>(stub: T, className: string): T {
  return new Proxy(stub, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof prop === "symbol") return value;
      // Skip internal/promise props
      if (["then", "catch", "finally", "toJSON", "valueOf", "toString"].includes(prop)) return value;
      if (typeof value === "function") {
        // bind(obj) ensures correct `this` when the actual method is called;
        // the wrapper's own `this` (from Proxy get trap) is intentionally ignored.
        const wrapped = wrapMethod(value.bind(obj), "do", className, prop, "client");
        // Capture caller stack at access site (before ALS.run destroys it)
        // and stitch onto errors so the full call chain is visible.
        return async function (this: unknown, ...args: unknown[]) {
          const callerStack = new Error();
          try {
            return await (wrapped as Function).apply(this, args);
          } catch (err) {
            if (err instanceof Error) stitchAsyncStack(err, callerStack);
            throw err;
          }
        };
      }
      return value;
    },
  });
}

/**
 * Wrap service binding: instrument fetch() and RPC methods.
 */
export function instrumentServiceBinding<T extends object>(binding: T, serviceName: string): T {
  const internalProps = new Set(["_wire", "isWired", "_subrequestCount"]);

  return new Proxy(binding, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof prop === "symbol") return value;
      if (internalProps.has(prop)) return value;
      if (["then", "catch", "finally", "toJSON", "valueOf", "toString", "connect"].includes(prop)) return value;
      if (typeof value === "function") {
        const method = prop === "fetch" ? "fetch" : prop;
        return wrapMethod(value, "service", serviceName, method, "client");
      }
      return value;
    },
  });
}

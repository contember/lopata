/**
 * RPC argument/return-value validation.
 *
 * Cloudflare Workers RPC serialises payloads via structured clone with
 * extensions (function stubs, RpcTarget stubs).  Bunflare runs everything
 * in-process so values pass by reference — code that works locally may
 * break in production.  This module warns at dev time when a value
 * contains types that CF cannot serialise.
 */

const TYPED_ARRAY_TAGS = new Set([
  "Int8Array", "Uint8Array", "Uint8ClampedArray",
  "Int16Array", "Uint16Array",
  "Int32Array", "Uint32Array",
  "Float32Array", "Float64Array",
  "BigInt64Array", "BigUint64Array",
]);

function typeName(v: unknown): string {
  if (v === null) return "null";
  const tag = Object.prototype.toString.call(v);        // "[object Foo]"
  return tag.slice(8, -1);                               // "Foo"
}

/**
 * Recursively validate a value for CF RPC serialisation compatibility.
 * Returns an array of human-readable error strings (empty = OK).
 */
export function validateRpcValue(value: unknown, path = "$"): string[] {
  return _validate(value, path, new WeakSet());
}

function _validate(value: unknown, path: string, seen: WeakSet<object>): string[] {
  // --- primitives ---
  if (value === null || value === undefined) return [];
  const t = typeof value;
  if (t === "boolean" || t === "number" || t === "bigint" || t === "string") return [];

  // --- symbol ---
  if (t === "symbol") return [`${path}: Symbol values cannot be serialised over RPC`];

  // --- function → CF converts to callback stub ---
  if (t === "function") return [];

  // --- object ---
  if (t !== "object") return [`${path}: unsupported typeof "${t}"`];

  const obj = value as object;

  // cycle detection (structured clone handles cycles — just skip)
  if (seen.has(obj)) return [];
  seen.add(obj);

  // --- explicitly disallowed ---
  if (value instanceof Promise)          return [`${path}: Promise values cannot be sent as RPC arguments`];
  if (value instanceof WeakMap)          return [`${path}: WeakMap cannot be serialised over RPC`];
  if (value instanceof WeakSet)          return [`${path}: WeakSet cannot be serialised over RPC`];
  if (value instanceof SharedArrayBuffer) return [`${path}: SharedArrayBuffer cannot be serialised over RPC`];
  if (typeof Blob !== "undefined" && value instanceof Blob && !(typeof File !== "undefined" && value instanceof File)) {
    return [`${path}: Blob cannot be serialised over RPC`];
  }
  if (typeof File !== "undefined" && value instanceof File) {
    return [`${path}: File cannot be serialised over RPC`];
  }

  // --- allowed leaf types (no recursion needed) ---
  if (value instanceof Date)        return [];
  if (value instanceof RegExp)      return [];
  if (value instanceof Error)       return [];
  if (value instanceof ArrayBuffer) return [];
  if (value instanceof DataView)    return [];

  // TypedArray: ArrayBuffer.isView but not DataView
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) return [];

  // --- streams & web API types (pass-through on CF) ---
  if (typeof ReadableStream  !== "undefined" && value instanceof ReadableStream)  return [];
  if (typeof WritableStream  !== "undefined" && value instanceof WritableStream)  return [];
  if (typeof Request         !== "undefined" && value instanceof Request)         return [];
  if (typeof Response        !== "undefined" && value instanceof Response)        return [];
  if (typeof Headers         !== "undefined" && value instanceof Headers)         return [];

  // --- Map ---
  if (value instanceof Map) {
    const errors: string[] = [];
    let i = 0;
    for (const [k, v] of value) {
      errors.push(..._validate(k, `${path}.Map.key(${i})`, seen));
      errors.push(..._validate(v, `${path}.Map.value(${i})`, seen));
      i++;
    }
    return errors;
  }

  // --- Set ---
  if (value instanceof Set) {
    const errors: string[] = [];
    let i = 0;
    for (const v of value) {
      errors.push(..._validate(v, `${path}.Set(${i})`, seen));
      i++;
    }
    return errors;
  }

  // --- Array ---
  if (Array.isArray(value)) {
    const errors: string[] = [];
    for (let i = 0; i < value.length; i++) {
      errors.push(..._validate(value[i], `${path}[${i}]`, seen));
    }
    return errors;
  }

  // --- plain object ---
  const proto = Object.getPrototypeOf(obj);
  if (proto === Object.prototype || proto === null) {
    const errors: string[] = [];
    for (const key of Object.keys(obj)) {
      errors.push(..._validate((obj as Record<string, unknown>)[key], `${path}.${key}`, seen));
    }
    return errors;
  }

  // --- anything else: custom class instance ---
  return [
    `${path}: Custom class instance (${typeName(value)}) cannot be sent over RPC. ` +
    `Extend RpcTarget or serialise manually.`,
  ];
}

// ---------------------------------------------------------------------------
// Convenience wrappers called from binding proxies
// ---------------------------------------------------------------------------

export function warnInvalidRpcArgs(args: unknown[], methodName: string): void {
  for (let i = 0; i < args.length; i++) {
    const errors = validateRpcValue(args[i], `arg${i}`);
    for (const msg of errors) {
      console.warn(`[bunflare] RPC ${methodName}() argument warning: ${msg}`);
    }
  }
}

export function warnInvalidRpcReturn(value: unknown, methodName: string): void {
  const errors = validateRpcValue(value, "return");
  for (const msg of errors) {
    console.warn(`[bunflare] RPC ${methodName}() return value warning: ${msg}`);
  }
}

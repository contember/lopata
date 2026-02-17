import { test, expect, describe } from "bun:test";
import { validateRpcValue } from "../rpc-validate";

// Helper: expect no errors
function expectValid(value: unknown) {
  expect(validateRpcValue(value)).toEqual([]);
}

// Helper: expect at least one error containing `fragment`
function expectInvalid(value: unknown, fragment: string) {
  const errors = validateRpcValue(value);
  expect(errors.length).toBeGreaterThan(0);
  expect(errors.some(e => e.includes(fragment))).toBe(true);
}

// ---- allowed types ----

describe("allowed types", () => {
  test("primitives", () => {
    expectValid(null);
    expectValid(undefined);
    expectValid(true);
    expectValid(42);
    expectValid(0n);
    expectValid("hello");
  });

  test("Date, RegExp, Error", () => {
    expectValid(new Date());
    expectValid(/abc/gi);
    expectValid(new Error("boom"));
    expectValid(new TypeError("type"));
  });

  test("ArrayBuffer and views", () => {
    expectValid(new ArrayBuffer(8));
    expectValid(new Uint8Array(4));
    expectValid(new Int16Array(2));
    expectValid(new Float64Array(1));
    expectValid(new DataView(new ArrayBuffer(8)));
  });

  test("Map and Set with valid values", () => {
    expectValid(new Map([["a", 1], ["b", 2]]));
    expectValid(new Set([1, "two", true]));
  });

  test("ReadableStream, WritableStream", () => {
    expectValid(new ReadableStream());
    expectValid(new WritableStream());
  });

  test("Request, Response, Headers", () => {
    expectValid(new Request("http://example.com"));
    expectValid(new Response("ok"));
    expectValid(new Headers());
  });

  test("functions (become stubs)", () => {
    expectValid(() => {});
    expectValid(function named() {});
    expectValid(async () => {});
  });

  test("plain objects and arrays", () => {
    expectValid({ a: 1, b: "two", c: true });
    expectValid([1, "two", true]);
    expectValid({ nested: { deep: [1, 2, 3] } });
  });

  test("null-prototype objects", () => {
    const obj = Object.create(null);
    obj.key = "value";
    expectValid(obj);
  });

  test("cyclic references are allowed", () => {
    const a: Record<string, unknown> = { x: 1 };
    a.self = a;
    expectValid(a);

    const arr: unknown[] = [1];
    arr.push(arr);
    expectValid(arr);
  });
});

// ---- disallowed types ----

describe("disallowed types", () => {
  test("Symbol value", () => {
    expectInvalid(Symbol("x"), "Symbol");
  });

  test("custom class instance", () => {
    class Foo { x = 1; }
    expectInvalid(new Foo(), "Custom class instance");
  });

  test("Blob", () => {
    expectInvalid(new Blob(["data"]), "Blob");
  });

  test("SharedArrayBuffer", () => {
    expectInvalid(new SharedArrayBuffer(8), "SharedArrayBuffer");
  });

  test("WeakMap", () => {
    expectInvalid(new WeakMap(), "WeakMap");
  });

  test("WeakSet", () => {
    expectInvalid(new WeakSet(), "WeakSet");
  });

  test("Promise value", () => {
    expectInvalid(Promise.resolve(1), "Promise");
  });
});

// ---- nested errors ----

describe("nested invalid types", () => {
  test("custom class inside plain object", () => {
    class Bar {}
    const errors = validateRpcValue({ a: { b: new Bar() } });
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("$.a.b");
    expect(errors[0]).toContain("Custom class instance");
  });

  test("symbol inside array", () => {
    const errors = validateRpcValue([1, Symbol("x"), 3]);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("$[1]");
  });

  test("invalid value inside Map", () => {
    class Baz {}
    const m = new Map<string, unknown>([["ok", 1], ["bad", new Baz()]]);
    const errors = validateRpcValue(m);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("Map.value(1)");
  });

  test("invalid value inside Set", () => {
    const s = new Set([1, new WeakMap()]);
    const errors = validateRpcValue(s);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("Set(1)");
  });

  test("multiple errors in one value", () => {
    class X {}
    const val = { a: Symbol("s"), b: new X(), c: "ok" };
    const errors = validateRpcValue(val);
    expect(errors.length).toBe(2);
  });
});

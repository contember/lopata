import { test, expect, describe } from "bun:test";
import { ExecutionContext } from "../execution-context";
import { addCfProperty } from "../request-cf";

describe("ExecutionContext", () => {
  test("waitUntil tracks and awaits promises", async () => {
    const ctx = new ExecutionContext();
    let ran = false;
    ctx.waitUntil(new Promise<void>(resolve => {
      setTimeout(() => { ran = true; resolve(); }, 10);
    }));
    expect(ran).toBe(false);
    await ctx._awaitAll();
    expect(ran).toBe(true);
  });

  test("rejected promises do not throw from _awaitAll", async () => {
    const ctx = new ExecutionContext();
    ctx.waitUntil(Promise.reject(new Error("fail")));
    // Should not throw
    await ctx._awaitAll();
  });

  test("multiple promises all execute", async () => {
    const ctx = new ExecutionContext();
    const results: number[] = [];
    ctx.waitUntil(new Promise<void>(resolve => {
      results.push(1);
      resolve();
    }));
    ctx.waitUntil(new Promise<void>(resolve => {
      results.push(2);
      resolve();
    }));
    ctx.waitUntil(new Promise<void>(resolve => {
      results.push(3);
      resolve();
    }));
    await ctx._awaitAll();
    expect(results).toEqual([1, 2, 3]);
  });

});

describe("addCfProperty", () => {
  test("sets expected cf fields on request", () => {
    const req = new Request("http://localhost/test");
    addCfProperty(req);
    const cf = (req as any).cf;
    expect(cf).toBeDefined();
    expect(cf.country).toBe("US");
    expect(cf.city).toBe("San Francisco");
    expect(cf.colo).toBe("SFO");
    expect(cf.asn).toBe(13335);
    expect(cf.httpProtocol).toBe("HTTP/2");
    expect(cf.tlsVersion).toBe("TLSv1.3");
    expect(cf.timezone).toBe("America/Los_Angeles");
  });

});

import { test, expect } from "bun:test";
import "../plugin";

test("navigator.userAgent is 'Cloudflare-Workers'", () => {
  expect(navigator.userAgent).toBe("Cloudflare-Workers");
});

test("navigator.language defaults to 'en'", () => {
  expect(navigator.language).toBe("en");
});

test("performance.timeOrigin is 0", () => {
  expect(performance.timeOrigin).toBe(0);
});

test("performance.now() returns a number", () => {
  const now = performance.now();
  expect(typeof now).toBe("number");
  expect(now).toBeGreaterThanOrEqual(0);
});

test("scheduler.wait resolves after delay", async () => {
  const start = Date.now();
  await (globalThis as unknown as { scheduler: { wait(ms: number): Promise<void> } }).scheduler.wait(50);
  const elapsed = Date.now() - start;
  expect(elapsed).toBeGreaterThanOrEqual(40); // allow small timing variance
});

test("scheduler.wait(0) resolves immediately", async () => {
  const start = Date.now();
  await (globalThis as unknown as { scheduler: { wait(ms: number): Promise<void> } }).scheduler.wait(0);
  const elapsed = Date.now() - start;
  expect(elapsed).toBeLessThan(50);
});

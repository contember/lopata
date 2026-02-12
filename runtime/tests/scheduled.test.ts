import { test, expect, describe } from "bun:test";
import {
  parseCron,
  cronMatchesDate,
  createScheduledController,
} from "../bindings/scheduled";

describe("parseCron", () => {
  test("parses every-minute cron", () => {
    const cron = parseCron("* * * * *");
    expect(cron.minute.type).toBe("any");
    expect(cron.hour.type).toBe("any");
    expect(cron.dayOfMonth.type).toBe("any");
    expect(cron.month.type).toBe("any");
    expect(cron.dayOfWeek.type).toBe("any");
  });

  test("parses specific values", () => {
    const cron = parseCron("5 14 1 6 3");
    expect(cron.minute).toEqual({ type: "values", values: [5] });
    expect(cron.hour).toEqual({ type: "values", values: [14] });
    expect(cron.dayOfMonth).toEqual({ type: "values", values: [1] });
    expect(cron.month).toEqual({ type: "values", values: [6] });
    expect(cron.dayOfWeek).toEqual({ type: "values", values: [3] });
  });

  test("parses ranges", () => {
    const cron = parseCron("1-5 * * * *");
    expect(cron.minute).toEqual({ type: "values", values: [1, 2, 3, 4, 5] });
  });

  test("parses comma-separated values", () => {
    const cron = parseCron("0,15,30,45 * * * *");
    expect(cron.minute).toEqual({ type: "values", values: [0, 15, 30, 45] });
  });

  test("parses step values with wildcard", () => {
    const cron = parseCron("*/15 * * * *");
    expect(cron.minute).toEqual({ type: "values", values: [0, 15, 30, 45] });
  });

  test("parses step values with range", () => {
    const cron = parseCron("1-10/3 * * * *");
    expect(cron.minute).toEqual({ type: "values", values: [1, 4, 7, 10] });
  });

  test("throws on invalid expression (wrong number of fields)", () => {
    expect(() => parseCron("* * *")).toThrow("Invalid cron expression");
  });

  test("preserves original expression", () => {
    const cron = parseCron("*/5 * * * *");
    expect(cron.expression).toBe("*/5 * * * *");
  });
});

describe("cronMatchesDate", () => {
  test("every-minute matches any date", () => {
    const cron = parseCron("* * * * *");
    expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 0))).toBe(true);
    expect(cronMatchesDate(cron, new Date(2025, 5, 15, 12, 30))).toBe(true);
  });

  test("specific minute matches only that minute", () => {
    const cron = parseCron("30 * * * *");
    expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 30))).toBe(true);
    expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 0))).toBe(false);
    expect(cronMatchesDate(cron, new Date(2025, 0, 1, 12, 30))).toBe(true);
  });

  test("specific hour matches only that hour", () => {
    const cron = parseCron("0 14 * * *");
    expect(cronMatchesDate(cron, new Date(2025, 0, 1, 14, 0))).toBe(true);
    expect(cronMatchesDate(cron, new Date(2025, 0, 1, 15, 0))).toBe(false);
  });

  test("specific day of month", () => {
    const cron = parseCron("0 0 15 * *");
    expect(cronMatchesDate(cron, new Date(2025, 0, 15, 0, 0))).toBe(true);
    expect(cronMatchesDate(cron, new Date(2025, 0, 14, 0, 0))).toBe(false);
  });

  test("specific month", () => {
    const cron = parseCron("0 0 1 6 *");
    // Month 5 = June (0-indexed in JS Date)
    expect(cronMatchesDate(cron, new Date(2025, 5, 1, 0, 0))).toBe(true);
    expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 0))).toBe(false);
  });

  test("specific day of week", () => {
    const cron = parseCron("0 0 * * 1");
    // 2025-01-06 is a Monday (day 1)
    expect(cronMatchesDate(cron, new Date(2025, 0, 6, 0, 0))).toBe(true);
    // 2025-01-07 is a Tuesday (day 2)
    expect(cronMatchesDate(cron, new Date(2025, 0, 7, 0, 0))).toBe(false);
  });

  test("every 5 minutes", () => {
    const cron = parseCron("*/5 * * * *");
    expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 0))).toBe(true);
    expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 5))).toBe(true);
    expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 3))).toBe(false);
  });

  test("midnight daily", () => {
    const cron = parseCron("0 0 * * *");
    expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 0))).toBe(true);
    expect(cronMatchesDate(cron, new Date(2025, 0, 1, 1, 0))).toBe(false);
    expect(cronMatchesDate(cron, new Date(2025, 0, 1, 0, 1))).toBe(false);
  });
});

describe("ScheduledController", () => {
  test("has scheduledTime and cron properties", () => {
    const now = Date.now();
    const controller = createScheduledController("*/5 * * * *", now);
    expect(controller.scheduledTime).toBe(now);
    expect(controller.cron).toBe("*/5 * * * *");
  });

  test("noRetry is callable (no-op in dev)", () => {
    const controller = createScheduledController("* * * * *", Date.now());
    expect(() => controller.noRetry()).not.toThrow();
  });
});

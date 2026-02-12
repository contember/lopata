export interface ScheduledController {
  readonly scheduledTime: number;
  readonly cron: string;
  noRetry(): void;
}

interface CronField {
  type: "any" | "values";
  values: number[];
}

interface ParsedCron {
  expression: string;
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

function parseField(field: string, min: number, max: number): CronField {
  if (field === "*") {
    return { type: "any", values: [] };
  }

  const values: number[] = [];

  for (const part of field.split(",")) {
    const stepMatch = part.match(/^(\*|(\d+)-(\d+))\/(\d+)$/);
    if (stepMatch) {
      const step = parseInt(stepMatch[4]!, 10);
      const start = stepMatch[1] === "*" ? min : parseInt(stepMatch[2]!, 10);
      const end = stepMatch[1] === "*" ? max : parseInt(stepMatch[3]!, 10);
      for (let i = start; i <= end; i += step) {
        values.push(i);
      }
      continue;
    }

    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1]!, 10);
      const end = parseInt(rangeMatch[2]!, 10);
      for (let i = start; i <= end; i++) {
        values.push(i);
      }
      continue;
    }

    values.push(parseInt(part, 10));
  }

  return { type: "values", values };
}

export function parseCron(expression: string): ParsedCron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: "${expression}" (expected 5 fields)`);
  }

  return {
    expression,
    minute: parseField(parts[0]!, 0, 59),
    hour: parseField(parts[1]!, 0, 23),
    dayOfMonth: parseField(parts[2]!, 1, 31),
    month: parseField(parts[3]!, 1, 12),
    dayOfWeek: parseField(parts[4]!, 0, 6),
  };
}

function fieldMatches(field: CronField, value: number): boolean {
  if (field.type === "any") return true;
  return field.values.includes(value);
}

export function cronMatchesDate(cron: ParsedCron, date: Date): boolean {
  return (
    fieldMatches(cron.minute, date.getMinutes()) &&
    fieldMatches(cron.hour, date.getHours()) &&
    fieldMatches(cron.dayOfMonth, date.getDate()) &&
    fieldMatches(cron.month, date.getMonth() + 1) &&
    fieldMatches(cron.dayOfWeek, date.getDay())
  );
}

export function createScheduledController(cron: string, scheduledTime: number): ScheduledController {
  return {
    scheduledTime,
    cron,
    noRetry() {},
  };
}

type ScheduledHandler = (controller: ScheduledController, env: Record<string, unknown>, ctx: { waitUntil: (p: Promise<unknown>) => void; passThroughOnException: () => void }) => Promise<void>;

export function startCronScheduler(
  crons: string[],
  handler: ScheduledHandler,
  env: Record<string, unknown>,
): NodeJS.Timer {
  const parsed = crons.map(parseCron);

  // Check every 60 seconds, aligned to the start of each minute
  const interval = setInterval(() => {
    const now = new Date();
    for (const cron of parsed) {
      if (cronMatchesDate(cron, now)) {
        const controller = createScheduledController(cron.expression, now.getTime());
        const ctx = {
          waitUntil(_promise: Promise<unknown>) {},
          passThroughOnException() {},
        };
        console.log(`[bunflare] Cron triggered: ${cron.expression}`);
        handler(controller, env, ctx).catch((err) => {
          console.error(`[bunflare] Scheduled handler error (${cron.expression}):`, err);
        });
      }
    }
  }, 60_000);

  return interval;
}

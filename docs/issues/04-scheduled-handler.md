# Scheduled / Cron handler

Support for `scheduled()` handler and cron triggers.

## Wrangler config

```jsonc
"triggers": {
  "crons": ["*/5 * * * *", "0 0 * * *"]
}
```

## API to implement

### ScheduledController

```ts
interface ScheduledController {
  readonly scheduledTime: number;  // ms since epoch
  readonly cron: string;           // cron expression that triggered
  noRetry(): void;                 // prevent retry on failure
}
```

### Handler

```ts
export default {
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // ...
  }
}
```

## Implementation notes

- Parse `triggers.crons` from config
- On startup, set up timers that fire at the right intervals based on cron expressions
- When a cron fires, call `handler.scheduled(controller, env, ctx)`
- `noRetry()` is a no-op in dev (no retry mechanism needed locally)
- Use a simple cron parser — match minute/hour/day/month/weekday fields, or use a lightweight cron library
- Also expose an HTTP endpoint for manual triggering: `GET /__scheduled?cron=*+*+*+*+*` (matching wrangler dev behavior)
- Log each cron execution to console

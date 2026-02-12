# Durable Objects: Alarms

Schedule a callback to run at a future time on a Durable Object.

## API to implement

### DurableObjectStorage

- `getAlarm(options?): Promise<number | null>` — returns scheduled alarm time (ms epoch) or null
- `setAlarm(scheduledTime: number | Date, options?): Promise<void>` — schedule alarm
- `deleteAlarm(options?): Promise<void>` — cancel pending alarm

### Handler on DurableObject class

```ts
class MyDO extends DurableObject {
  async alarm(alarmInfo?: { retryCount: number; isRetry: boolean }): Promise<void> {
    // called when alarm fires
  }
}
```

## Behavior

- Only one alarm per DO instance at a time — `setAlarm()` replaces any existing alarm
- `alarm()` is called at or shortly after the scheduled time
- If `alarm()` throws, it retries up to 6 times with exponential backoff
- After alarm fires successfully, it's cleared (not recurring)

## Persistence

Uses the `do_alarms` table in `data.sqlite` (see issue 00).

- `setAlarm()` upserts row with alarm time, schedules `setTimeout` for the current process
- `deleteAlarm()` removes row and clears timeout
- `getAlarm()` reads from DB
- On startup: query all alarms, schedule `setTimeout` for any that haven't fired yet (or fire immediately if past due)
- Need reference to DO instance — lazily instantiate the DO when alarm fires (same as handling a request to it)
- Retry: wrap `alarm()` in try/catch, re-schedule with backoff on failure

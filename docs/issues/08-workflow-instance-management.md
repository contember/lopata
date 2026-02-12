# Workflow instance management

Extend the existing workflow binding with instance lifecycle methods and persistence.

## API to implement

### Workflow binding (extended)

- `create(options?): Promise<WorkflowInstance>` — already implemented (needs persistence)
- `createBatch(batch: { id?, params? }[]): Promise<WorkflowInstance[]>` — create multiple instances
- `get(id: string): Promise<WorkflowInstance>` — retrieve existing instance by ID

### WorkflowInstance

- `id: string` — instance ID
- `status(): Promise<WorkflowInstanceStatus>` — current status
- `pause(): Promise<void>`
- `resume(): Promise<void>`
- `terminate(): Promise<void>`
- `restart(): Promise<void>`
- `sendEvent(event: { type: string, payload?: unknown }): Promise<void>`

### WorkflowInstanceStatus

```ts
{
  status: "queued" | "running" | "paused" | "complete" | "errored" | "terminated" | "waiting";
  output?: unknown;
  error?: string;
}
```

### WorkflowStep (extended)

- `do(name, callback)` — already implemented
- `sleep(name, duration)` — already implemented
- `sleepUntil(name, timestamp: Date)` — sleep until a specific time
- `waitForEvent(name, options: { type: string, timeout?: Duration }): Promise<unknown>` — pause until event received via `sendEvent()`

## Persistence

Uses the `workflow_instances` table in `data.sqlite` (see issue 00).

- `create()` inserts a row with status `running`, starts execution in background
- Status updates (`pause`, `resume`, `terminate`, `complete`, `errored`) update the row
- `get(id)` reads the row and returns a `WorkflowInstance` handle
- `status()` reads current row state
- On restart: workflows with status `running` are NOT automatically resumed (they'd need to re-run from scratch since JS execution state is lost) — mark them as `errored` on startup or leave them for manual restart
- `pause()` sets a flag checked by step execution; stored in DB so it survives restart
- `sendEvent()` resolves any pending `waitForEvent()` promise with matching type
- `sleepUntil()` calculates delay from `Date.now()` to the target timestamp

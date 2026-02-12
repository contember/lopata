# Migrate Workflow binding from in-memory to SQLite

Current `runtime/bindings/workflow.ts` runs workflows in background with no persistence — state is lost on restart.

## Current state

`InMemoryWorkflowBinding` tracks a counter and runs workflows as fire-and-forget async functions. No state persistence.

## Target

Workflow instances tracked in the `workflow_instances` table in `data.sqlite`:

```sql
CREATE TABLE IF NOT EXISTS workflow_instances (
  id TEXT PRIMARY KEY,
  workflow_name TEXT NOT NULL,
  class_name TEXT NOT NULL,
  params TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  output TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

## Changes needed

### InMemoryWorkflowBinding → SqliteWorkflowBinding

- Constructor takes `db: Database`, `workflowName: string`, `className: string`
- `create(options)`:
  - Generate ID (or use provided `options.id`)
  - Insert row with status `running`, params as JSON
  - Start execution in background
  - On completion: update status to `complete`, store output
  - On error: update status to `errored`, store error message
  - Return `WorkflowInstance` handle
- `get(id)`:
  - Query row from DB
  - Return `WorkflowInstance` handle (status queries from DB, lifecycle operations update DB)

### WorkflowInstance

- `status()`: `SELECT status, output, error FROM workflow_instances WHERE id = ?`
- `pause()`: update status to `paused` + set in-memory flag checked by steps
- `resume()`: update status to `running` + clear flag
- `terminate()`: update status to `terminated` + abort execution (AbortController)
- `restart()`: reset row, re-run `run()` from scratch

### On restart behavior

- Workflows with status `running` at startup: mark as `errored` with message "interrupted by restart"
- User can manually restart them via `get(id).restart()`
- JS execution state (closures, step progress) cannot be restored — this is a known dev limitation

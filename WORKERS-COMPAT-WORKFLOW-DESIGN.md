# Workflow persistence and contract proposal

October 5, 2026. **Design with partial approval.** Covers F04, F10a/F10b, F11 and F07b. No runtime changes are included.

## Approved decisions and superseded proposals

- The user approved typed occurrences, additive migration preserving legacy checkpoints, bounded SQLite stream chunks with atomic commits, and explicit errors for ambiguous legacy identity/order.
- The user approved cooperative deletion and safe awaited self-delete as a documented partial F10b implementation. Arbitrary callback preemption remains unsupported.
- The user chose to preserve existing defaults for **all definitions**, then explicitly removed new Free/Paid plan limits and their enforcement from scope. Do not add plan selection, plan-derived quotas, new default limits, or automatic retention. Preserve existing configured local limits and validation. This document contains no plan-policy implementation requirement.
- Other unresolved contracts below still need evidence or approval; these decisions do not authorize new identity mappings or fabricated subscription history.

## Delivery boundary

1. Use typed, per-name occurrence keys and a separate invocation order. Keep legacy checkpoints intact and adopt them during replay; do not infer types from name prefixes alone.
2. Store stream results as a single SQLite BLOB in the occurrence checkpoint (see stage 2).
3. Deliver finite units in order: **F04 identity → F04 streams → F10b cooperative deletion**. The first unit below is the implementation-ready boundary for the leader's decomposition gate.
4. Subscription logging and definition mapping remain separate, unapproved designs. Do not create their tables, transport, policy snapshots or output-history retention as part of these units.
5. Preserve `WORKFLOW_DEFAULTS` and existing configured `WorkflowLimits` for old and new definitions alike. Existing `maxStepsPerWorkflow`, `maxStepOutputBytes`, retry, timeout and explicitly configured retention behavior continue to apply. No new instance byte quota, plan selector, automatic retention schedule or account-plan validation.
6. Basic F07b declaration wiring need not wait for F04; any proposed identity mapping needs its own decision. Schedules remain separate.

## Evidence and feasibility

- `src/db.ts` creates name-keyed `workflow_steps` and `workflow_step_attempts`; `workflow_instances.id` is globally unique. `workflow_events` is an incoming-event inbox, not execution history. `workflow-rollback-migrations.ts` adds name-keyed history and reverse `start_order` compensation.
- `workflow.ts` rejects repeated names; exposes `count: 1`; serializes outputs with JSON; checks string length rather than UTF-8 bytes. Sleeps encode their type in the name. `sleepUntil` replay consults the new argument instead of the saved deadline. Event delivery to a live waiter bypasses persistence; inbox consumption and checkpointing are separate writes.
- `restart({ fromStep })` truncates by completion timestamp, which cannot represent concurrent start order or tied timestamps. Retention deletes some tables but leaves checkpoints/inbox rows. The declared `create.retention` string is unused.
- `src/worker-thread/thread-env.ts` constructs real Workflow bindings in the user worker and opens the shared SQLite file. Main-side dashboard controls route through `executeControl`, `protocol.ts`, `executor.ts`, and `entry.ts`. This corrects the more general description in `CLAUDE.md`: Workflows are not ordinary main-owned binding proxies.
- `src/api/handlers/workflows.ts`, `src/api/types.ts`, `src/dashboard/views/workflows.tsx`, and `src/testing/workflow.ts` directly consume old tables/names. They must move with F04, including dashboard restart selection and fresh stream replay in test helpers.
- `src/env.ts` and thread construction use the legacy **binding variable**, not configured Workflow `name`, as storage identity. `WorkerEntrypointDispatcher.loopbacks()` in `src/bindings/worker-cache.ts` currently includes only branded WorkerEntrypoint classes. Vite uses `buildEnv`/`wireClassRefs`; test config passes through `src/testing/env-builder.ts`.
- Existing rollback tests cover real callback settlement after timeout, inverse start order, persistent retry/compensation, undefined versus null, repeated migrations, and restart reset. Preserve these guarantees and the accepted indefinite forward-drain policy in `CLOUDFLARE-COMPATIBILITY.md`.

**Storage inspection:** installed `bun-types/sqlite.d.ts` exposes typed-array BLOB binding and synchronous `transaction(...).immediate()`, but no public incremental BLOB handle. An in-memory probe on the available **Bun 1.3.14 / SQLite 3.53.0** round-tripped `00FF01` and confirmed `foreign_keys = 0`. Production open paths set WAL/busy timeout but do not enable foreign keys. Do not rely on cascades. Repeat the probe and implementation gates on the required Bun 1.4.2 baseline; that version was not exercised here.

Existing filesystem storage is available via `Bun.file().stream()`/writers in `src/bindings/r2.ts`, but its write helper is private and does not provide an atomic workflow checkpoint contract. A filesystem design needs immutable filenames, durable file/directory flush ordering, orphan recovery, and a supplied storage root for in-memory callers. Chunked SQLite is the smaller first implementation. No new dependency, FFI, or global SQLite durability-setting change is proposed. The guarantee is transaction/process-crash recovery under existing database settings, not a new power-loss guarantee.

## F04: occurrence model and migration

### Identity and state

Introduce concrete `WorkflowStepKey`, `WorkflowRestartOptions`, `WorkflowCheckpoint`, and `WorkflowExecutionToken` types in `src/bindings/workflow.ts` (extract storage types only where shared by the store).

- Public key: `{ type: 'do' | 'sleep' | 'waitForEvent', name, count }`, count starting at one per `(type, name)`. `sleepUntil` uses the `sleep` namespace and stores its original method separately. Confirm that normalization against released types/behavior before coding; the public restart type has no `sleepUntil` member.
- Allocate count and invocation ordinal synchronously at the public method call, before any await. Retries never increment count. Replaying a run resets in-memory counters and resolves the same keys. This also makes `Promise.all` invocation order deterministic where the program itself is deterministic.
- Persist a unique `incarnation` on creation and replace it on ID reuse; persist `run` for explicit restart and `execution_epoch` for execution ownership. A mutation must match all three plus the existing `workflow_name` storage identity. Reload takes ownership only after the previous generation is disposed, preserving the existing generation-manager invariant.
- A separate `start_order` orders **all** invocations; compensation uses reverse order of eligible `do` occurrences. Do not sort by finish time. Count only `do`/`waitForEvent` toward step limits; sleeps still have identity/order.
- Scope process registries to database identity plus incarnation/run, not a public ID alone. Enforce existing Workflow ownership in handle lookups/controls. Keep the current globally unique public-ID limitation explicit for this minimal migration; changing it to per-Workflow IDs requires a separate approved primary-key migration. No definition registry is introduced.

Proposed additive schema, installed by `src/bindings/workflow-migrations.ts` from `runMigrations`:

| Record                   | Required fields / invariants                                                                                                                                                                                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instance additions       | Stage 1: `incarnation`, `run`, `execution_epoch`, `persistence_version`; existing ID and columns retained; no policy or quota columns                                                                                                                                                          |
| `workflow_occurrences`   | Stage 1: `(incarnation, run, type, name, count)` unique; opaque occurrence ID; `start_order`, original method, state, deadline/event type, output kind/JSON, completion time, forward attempts/errors and existing rollback registration/state/attempt/error fields; stage 2 adds stream bytes |
| `workflow_legacy_claims` | One raw legacy key maps to at most one occurrence; migration/adoption version, original history order; raw legacy rows remain available                                                                                                                                                        |

Use SQL uniqueness/check constraints and typed parsers at stored-data boundaries. Avoid renaming or rewriting JSON payloads. Keep `undefined` (old SQL NULL) distinct from JSON `null`; stage 1 checkpoint kind is `undefined` or `json`, extended with `stream` in stage 2. This proposal does not expand JSON serialization into complete structured-clone support. In stage 1 preserve current output-size validation and configured threshold; byte-counting corrections are not an implied new policy change.

### Preserve old data without guessing

1. Install additive tables/columns under an immediate transaction with a version marker. The first upgrade requires a cold runtime start, so old-version executions cannot keep writing unmigrated rows after adoption. Subsequent `runMigrations` calls are idempotent, including normal generation startup. Do not globally enable foreign keys as part of this change.
2. Preserve old checkpoint, attempt, history and rollback rows byte-for-byte. Old history rows identify `do` steps; rows without history may be `do`, sleeps or waits. For example, `do('sleep:x')` and `sleep('x')` used the same raw key. Prefix stripping cannot safely migrate this.
3. Adopt an unclaimed legacy row when replay first reaches its matching old raw key, with the current typed invocation/count (normally one; a shared sleep/sleepUntil namespace can produce a higher count). Copy output/retry/rollback state atomically and record its claim. A migrated checkpoint is returned without running its callback. Assign invocation order as replay observes it and verify that the relative order of existing do-history rows agrees with their saved start order. Reject a mismatch rather than silently reordering compensation. Do not pretend missing cross-type order was recorded historically.
4. Preserve recovery of pre-rollback-migration checkpoints: replay may register the current callback's compensation for a cached result, matching the existing migration test. Never reset completed compensation or failed-attempt state merely because the schema changed.
5. An incompatible type/method/name trying to claim an already-claimed raw legacy key is an ambiguity error, not another cache hit. A later count of the same original method/name is a new occurrence, not a second claim of the old checkpoint; migrated instances can therefore execute newly added repeated-name loops. Existing lossy prefix collisions cannot be reconstructed. Old `{}` values from JSON-serialized streams are indistinguishable from legitimate JSON objects: preserve them as JSON, never fabricate bytes or reject all empty objects. Report ambiguity when evidence exists; do not claim detection of unrecoverable history that was never stored.
6. Historical cross-type order is unavailable before replay. Permit exact partial restart only once its target/order is resolved. For an unmapped terminal legacy instance, reject targeted restart with a migration explanation rather than replaying arbitrary user code solely to discover order. Full restart remains an explicit user action. This is within the approved explicit-ambiguity boundary.

New runs use only the typed tables. Legacy reads are allowed only for migration-marked instances and the first invocation of each unclaimed raw legacy key. Cleanup must remove both generations of records, so old tables cannot resurrect deleted data.

### Replay, retries and restart

- Record an attempt start before executing its callback and persist failed-attempt counters by occurrence. Preserve existing retry-delay behavior in stage 1; adding durable calculated retry deadlines is a separate enhancement, not required for occurrence identity.
- Persist sleep deadlines before yielding and a completion/skip state after waking. Repeated sleeps do not share timers. `sleepUntil` replay uses the persisted deadline. Register timer/wait resolvers by occurrence, not one slot per instance/event type.
- Always persist incoming events first. A transaction claims the oldest eligible inbox ID, stores that occurrence's output, and deletes/marks the exact consumed ID. A wakeup only prompts a durable read. Concurrent same-type waiters use start order; one event satisfies one occurrence. Persist wait deadlines so reload does not reset the timeout.
- Implement `restart({ from: { name, count = 1, type = 'do' } })`. Keep the dashboard's `fromStep` as an adapter during its transition, not the storage selector. Validate the target before aborting the current execution.
- Fence the old execution, settle actual live forward callbacks before starting replacement work in the same realm, then atomically start a new run. Copy retained prefix checkpoints by start order; reset rollback progress for the new run as existing restart behavior does. Keep attempts scoped to their occurrence/run. Never overlap a surviving old callback with a replacement callback merely because the outer promise was aborted.
- Preserve existing explicit restart semantics: retain the selected prefix, discard the target/suffix and reset compensation for the replacement run. Do not introduce a prior-run archive for unapproved subscriptions. Perform replacement atomically; copied prefix outputs keep their values. Preserve raw legacy data during migration, but never consult old rows after an explicit restart has invalidated them. Full restart and existing explicitly configured cleanup may remove their owned legacy rows. Stage 2 reclaims streams that no retained checkpoint references.
- Full-process failure cannot establish whether an unfinished callback performed external effects. Only committed checkpoints suppress re-execution. Neither this migration nor streams promise exactly-once external side effects.

## Stage 1: implementation-ready identity unit

**Deliverable:** repeated typed occurrences replay independently through do/sleep/sleepUntil/wait, retries, rollback and targeted restart, including old-data recovery. Stream persistence and deletion APIs arrive in the next two units. No subscription or definition registry is needed.

### Exclusive write territory

| Owner files                                                                                                                                                | Required change                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/bindings/workflow.ts`                                                                                                                                 | Allocate keys/order before awaits; replace name-keyed checkpoint/attempt/rollback access; occurrence-scoped waits; restart selector; existing cleanup reaches new records |
| New `src/bindings/workflow-store.ts`                                                                                                                       | Concrete occurrence types and synchronous SQLite operations below; no generic repository, event bus or policy abstraction                                                 |
| New `src/bindings/workflow-migrations.ts`, `src/db.ts`                                                                                                     | Additive identity schema/version and migration call; retain existing rollback migration and raw legacy tables                                                             |
| `src/worker-thread/protocol.ts`                                                                                                                            | Extend restart control payload with typed `from`; keep the current `fromStep` adapter                                                                                     |
| `src/api/handlers/workflows.ts`, `src/api/types.ts`, `src/dashboard/views/workflows.tsx`                                                                   | Read occurrence-aware details including unmapped legacy rows; render name/count/type; send precise restart selection                                                      |
| `src/testing/workflow.ts`                                                                                                                                  | Read through store; optional occurrence selector for waitForStep/mock hooks while preserving existing name-only behavior                                                  |
| `tests/workflow.test.ts`, `tests/workflow-rollbacks.test.ts`, new `tests/workflow-occurrences.test.ts`, new `tests/workflow-occurrence-migrations.test.ts` | Focused identity, rollback, legacy and configured-limit coverage                                                                                                          |
| `tests/thread-workflow-control-e2e.test.ts`, `tests/thread-workflow-resume-e2e.test.ts`, dedicated `tests/fixtures/workflow-occurrences-*` fixtures        | Typed control forwarding, real generation reload and file-backed fresh-process replay                                                                                     |

Read and run the existing thread rollback/e2e tests as regression coverage. `executor.ts`/`entry.ts` already forward the typed control envelope; do not edit them unless the implementation exposes a concrete forwarding mismatch. No config/env/virtual-module/definition-mapping edits belong to this unit. `workflow-rollback-migrations.ts` remains the legacy-schema owner; call the new migration after it.

### Store boundary

Keep SQL and stored-record parsing in the store; keep callbacks, timers, in-memory invocation counters and public validation in `workflow.ts`. Export shared types from the store, re-export public restart types from `workflow.ts`. Every operation is synchronous; no callback or await occurs inside a transaction. Method contract:

```ts
type WorkflowStepType = 'do' | 'sleep' | 'waitForEvent'
type WorkflowStepMethod = 'do' | 'sleep' | 'sleepUntil' | 'waitForEvent'
interface WorkflowStepKey {
	type: WorkflowStepType
	name: string
	count: number
}
interface WorkflowRestartOptions {
	from?: { name: string; count?: number; type?: WorkflowStepType }
}
interface WorkflowExecutionToken {
	instanceId: string
	workflowName: string // Existing storage identity, not a new definition mapping.
	incarnation: string
	run: number
	epoch: number
}
type WorkflowCheckpoint =
	| { kind: 'undefined' }
	| { kind: 'json'; serialized: string }
interface WorkflowStoredError {
	name: string
	message: string
	nonRetryable: boolean
	errorId: string | null
}
interface WorkflowOccurrenceInput {
	key: WorkflowStepKey
	method: WorkflowStepMethod
	startOrder: number
	rollbackRegistered: boolean
}
interface WorkflowOccurrenceRef {
	token: WorkflowExecutionToken
	occurrenceId: number
}

// Signatures on WorkflowStore, constructed with the existing Database.
// WorkflowOccurrenceRecord/WorkflowDetailRecords are concrete parsed records,
// with the fields specified in the schema above, not unknown-valued dictionaries.
interface WorkflowIdentityStore {
	acquireExecution(
		instanceId: string,
		workflowName: string,
	): WorkflowExecutionToken
	fenceExecution(token: WorkflowExecutionToken): WorkflowExecutionToken
	assertCurrent(token: WorkflowExecutionToken): void
	openOccurrence(
		token: WorkflowExecutionToken,
		input: WorkflowOccurrenceInput,
	): WorkflowOccurrenceRecord
	readCheckpoint(ref: WorkflowOccurrenceRef): WorkflowCheckpoint | null
	startAttempt(ref: WorkflowOccurrenceRef, attempt: number): void
	recordAttemptFailure(
		ref: WorkflowOccurrenceRef,
		failedAttempts: number,
		error: WorkflowStoredError,
		at: number,
	): void
	commitCheckpoint(
		ref: WorkflowOccurrenceRef,
		checkpoint: WorkflowCheckpoint,
		at: number,
	): void
	failOccurrence(
		ref: WorkflowOccurrenceRef,
		error: WorkflowStoredError,
		at: number,
	): void
	setDeadline(
		ref: WorkflowOccurrenceRef,
		deadline: number,
		eventType: string | null,
	): number
	completeSleep(ref: WorkflowOccurrenceRef, at: number): void
	consumeEvent(ref: WorkflowOccurrenceRef, at: number): WorkflowCheckpoint | null
	listRollbackOccurrences(
		token: WorkflowExecutionToken,
	): WorkflowOccurrenceRecord[]
	startRollbackAttempt(ref: WorkflowOccurrenceRef): void
	recordRollbackFailure(
		ref: WorkflowOccurrenceRef,
		failedAttempts: number,
		error: WorkflowStoredError,
	): void
	finishRollback(
		ref: WorkflowOccurrenceRef,
		outcome: 'complete' | 'failed',
	): void
	resolveRestartTarget(
		token: WorkflowExecutionToken,
		from: WorkflowStepKey,
	): number
	replaceRun(
		token: WorkflowExecutionToken,
		fromOrder: number | null,
	): WorkflowExecutionToken
	readDetail(instanceId: string, workflowName: string): WorkflowDetailRecords
	removeOwnedState(instanceId: string, workflowName: string): void
}
```

`WorkflowOccurrenceRecord` includes its ID/key/method/order, state, checkpoint, deadline/event type, forward attempt/failed-attempt/error fields and rollback fields. `WorkflowDetailRecords` contains typed occurrences plus explicitly marked unresolved legacy records for inspection. Match existing API error detail fields; do not silently drop `last_error_id` when migrating. Instance status/final output remains the existing concrete API; all mutation transactions must call the same execution-fence check, even where instance-level SQL stays in the runtime.

- `acquireExecution` increments ownership only once the prior generation/execution is drained or disposed. It reads the current run; it does not start a new run on ordinary replay. Add incarnation initialization to both `create` and `_createPrepared`.
- `openOccurrence` atomically looks up/creates an occurrence or adopts its legacy checkpoint/attempt/history. Compare stored method/order on replay; reject detectable divergence. The runtime allocates the input before awaiting pause, and validates existing limits before starting a new callback. Replaying the same occurrence does not consume an additional stored step.
- `commitCheckpoint` atomically sets completion/output and clears that occurrence's failed-attempt state. It preserves forward attempt context for compensation. Distinguish absent checkpoint from completed undefined output.
- `setDeadline` writes only on first entry and returns the existing deadline on replay. `consumeEvent` atomically selects/deletes the exact oldest matching inbox ID and writes the occurrence result. Persist sends before waking waiters. Register same-type waiters in invocation order; notifications carry no uncommitted payload.
- `resolveRestartTarget` is read-only validation; reject missing/ambiguous targets before abort. `fenceExecution` atomically advances epoch with compare-and-swap and returns the control token before abort/drain; old callbacks cannot commit while draining. After actual callback settlement, `replaceRun` verifies that control token, advances run/epoch, keeps the prefix, removes the invalidated suffix, clears failed-attempt/rollback progress as existing restart does and resets instance status/output/error in one transaction. A concurrent control invalidating the token makes replacement fail rather than overwrite its state. No prior-run archive. A full restart uses `null`.
- `removeOwnedState` is the shared complete cleanup primitive for the **existing explicitly configured** cleanup path; stage 3 uses it for deletion. It adds no scheduler or expiry rule. It removes identity/legacy/inbox/rollback records and the instance atomically, without relying on foreign-key cascades.
- Name-only testing hooks continue their existing first-matching behavior. Optional typed selectors distinguish repeated occurrences; avoid a test-helper redesign. Dashboard legacy rows remain inspectable; disable precise restart only where identity/order is unresolved, with the migration reason.

The sleep/sleepUntil normalization must be checked against released behavior at the start of implementation because the public restart union exposes only `sleep`. If contrary evidence appears, stop and report that narrow contract mismatch; it does not authorize another migration model.

### Completion checks

1. Loop over repeated do names; assert distinct outputs and counts, persisted failed-attempt isolation, final forward context in compensation and reverse invocation order under parallel completion.
2. Mix identical names across do/sleep/sleepUntil/wait; verify saved deadlines, independent timers, one durable inbox event per occurrence and restart by name/count/type despite tied completion times. Existing sleeps remain excluded from `maxStepsPerWorkflow`.
3. Reopen file-backed storage in a fresh process and reload a real user worker. Committed callbacks and completed compensation do not rerun; unfinished attempts recover with their own counters. Retain the accepted indefinitely blocked rollback test.
4. Migrate twice and interrupt adoption. Cover pre-history checkpoints, SQL NULL versus JSON null, retries, partial rollback, literal prefixed do names and detectable legacy collisions/order ambiguity. Raw legacy payloads remain intact; ambiguity fails explicitly and no completed effect is silently repeated.
5. Verify full/partial restart clears the intended suffix only; dashboard/thread controls select the exact occurrence; stale callbacks cannot write through old tokens.
6. Assert unchanged defaults and explicit custom `maxStepsPerWorkflow`, `maxStepOutputBytes`, retry/timeout and retention settings. Ordinary create introduces no cleanup policy; an existing configured cleanup removes the new storage family too.

The leader gates this single unit's file ownership before implementation. No further decision about plans, subscriptions, definition identity or quotas is a prerequisite.

## Stage 2: F04 stream step results

Simplified for local development. When a step returns a `ReadableStream`, the engine reads it fully into memory within the step timeout, rejects non-`Uint8Array` chunks, and stores the bytes in the occurrence checkpoint (`output_kind = 'stream'`, `output_bytes` BLOB). Replay, rollback and the testing helpers each get a new `ReadableStream` over the stored bytes. Streams bypass the nonstream result cap. There are no chunk tables, attempt tokens or interrupted-write cleanup: a step either commits its full bytes or fails like any other attempt.

## Deferred design: F10a durable subscription log

The following is a proposal for a separate future unit, **not approved implementation territory** for stages 1–3. Its schema, historical coverage, restart lifetime and output references need their own contract decision. Do not retain prior runs or add log tables in anticipation of it.

Add `workflow_event_log(event_id INTEGER PRIMARY KEY AUTOINCREMENT, incarnation, run, occurrence_id, type, timestamp, payload_version, payload_json, output_ref)` with an `(incarnation, event_id)` index. Keep the inbox name/semantics unchanged. Event IDs are numeric, monotonically increasing commit order, never timestamps or step counts; gaps are valid. Validate cursors as safe nonnegative integers and query only the handle's incarnation.

- Use the documented `WorkflowInstanceEvent` discriminated union and `subscribe({ cursor?, filter? }) -> { next(), [Symbol.dispose]() }` contract. Keep occurrence identity internal unless released public types expose it. Dynamic retry delay appears as `"[dynamic]"`, not a serialized callback.
- Each lifecycle, step, attempt, sleep, wait and rollback transition commits its event in the **same transaction** as state. Replays do not emit fresh start/completion events for checkpoints already committed. A unique transition key prevents duplicate event insertion on recovery.
- `next()` scans bounded pages after its cursor, including nonmatching events for cursor advancement and terminal detection. Register a wake listener before querying and requery before sleeping; notifications are hints. Use bounded polling while a read is pending to detect commits from another process/connection. Never hold a read transaction open while awaiting.
- Stop after `workflow_completed`, `workflow_errored` or `workflow_terminated`, even if filtered out. A disposed subscription resolves pending reads as done and removes listeners/timers. Serialize concurrent `next()` calls in caller order. Slow consumers use the durable log, with no unbounded push queue; deletion/expiry ends existing subscriptions and future `get` fails.
- Main/worker subscription transport should use handle IDs with pull-next/dispose messages, owned by the connection/generation, rather than trying to structured-clone methods. Add messages only for paths that cross that boundary; Workflow calls within the user worker need no bridge. Release resources on disconnect/reload. Do not depend on the unrelated F16 general RPC redesign.
- Store stream output references, not bytes in JSON events. Same-realm `next()` can supply a fresh stream; any cross-thread event output needs a pull/cancel byte channel. Confirm stream-event output representation against released implementation before finalizing the public encoder; the docs only say `output?: unknown`.
- Keep logs through instance retention, including prior runs. A subscription stops at the first terminal event after its cursor; following a restart requires a new subscription/cursor. Exact restart subscription behavior needs a pinned contract test before claiming parity.
- Legacy data lacks past events/attempt timings. Start truthful logging at upgrade and mark history coverage internally; do not synthesize a fake complete history. Approval is needed for this explicit old-instance coverage limit.

## Stage 3: F10b cooperative deletion

Extend `workflow.ts`, `workflow-store.ts`, the control protocol and its concrete callers only after stream cleanup lands. Add `tests/workflow-deletion.test.ts` and a real shared-worker self-delete fixture. No subscription implementation, definition mapping or new retention policy is a dependency.

Deletion is separate from rollback termination. It removes state and runs **no compensation**. Before any await, validate binding ownership, fence/invalidate the execution token, abort engine waits/readers, and transactionally remove all owned records. Every subsequent store write must require the live incarnation/epoch; no upsert may recreate it. A new instance with the same public ID gets a different incarnation, so a late callback cannot mutate it. Publish in-memory deletion notifications after commit. On process recovery an absent instance is never resumed.

**Awaited self-delete in the existing worker:** use `AsyncLocalStorage<WorkflowExecutionToken>` around the actual `instance.run` and its callbacks. If the deleting caller's token matches the target, commit deletion and trigger the outer engine abort path, then return a never-settling promise to that user invocation. Do not throw a sentinel: user `catch`/`finally` could continue. The engine's own abort race must exit without waiting for the parked callback, remove its registry references, release its queue slot, and skip rollback. A normal external caller receives a resolved deletion result. Do not wait on the workflow execution promise from its own delete operation. Test calls through a freshly retrieved handle, inside a step callback and directly inside `run`.

This stops code after **an awaited own delete**, including a surrounding `finally`, without terminating the shared worker or unrelated HTTP requests/workflows. It does not cancel already-scheduled sibling work, an ignored delete promise, a user-created `Promise.race`, arbitrary `fetch`, or an infinite loop. ALS identifies context; it is not a cancellation sandbox. Engine fences prevent durable resurrection, not arbitrary external effects.

For external deletion, engine timers/waits/stream checkpoints stop, but a currently running arbitrary callback can continue its external work. Terminating the generation worker would also kill unrelated requests and instances. The user approved this cooperative limitation. Per-instance execution isolation/routing is outside this unit; do not implement a shared-worker kill or call cooperative cancellation full hosted execution preemption.

The previously accepted rollback rule is unchanged: a timed-out forward callback that never settles can hold rollback indefinitely. Stream draining is forward work too. Deletion bypasses compensation; it must not inherit that indefinite drain. Restart in the same realm waits for real forward settlement unless an isolation design replaces that policy.

`deleteBatch` validates the entire 1–100 input list before mutation; duplicate positions count toward 100. Delete each unique ID once and repeat that result for every input occurrence in documented `deleted`/`errors` arrays. Missing IDs produce per-ID errors; invalid IDs fail the whole request before any deletion. Pin stable error codes from released types/implementation. If a batch includes the currently executing instance, apply other requested deletions before parking the self-caller; confirm this edge contract before promising it.

Acceptance: awaited self-delete in run and step (including surrounding catch/finally), no compensation, queue-slot release, unrelated request survives, sleeping/waiting/streaming state is removed, stale writers cannot resurrect a reused public ID, and batch validation/duplicate results match the contract. Verify process restart never resumes deleted state. Tests must acknowledge rather than conceal the arbitrary-callback limitation.

## Deferred design: F07b declarations and identity

Basic declaration wiring remains independent of F04. The identity mapping below is **unapproved**, and stages 1–3 continue using the existing Workflow storage name and globally unique instance IDs.

Proposed normalization: legacy bindings and `exports.<Class> = { type: 'workflow', name }` resolve to one `ResolvedWorkflowDefinition` per configured Workflow name. Fields: public name, class name, stable storage key, binding aliases and export class alias. Equal declarations share a binding; differing classes/settings are startup errors. Workflow loopbacks return binding objects, not callable WorkerEntrypoint/cache proxies. Imported `exports` and `ctx.exports` resolve the same owner in CLI, Vite and test environments. All definitions retain existing local defaults and configured overrides.

Possible mapping, requiring separate approval: persist `workflow_definitions` mapping public Workflow name to the existing storage key. For a currently configured legacy binding, adopt its binding-key storage identity without rewriting instances. For a new declaration-only definition, allocate a stable key. If the old config was removed before this mapping existed, class name alone does not prove ownership: require an explicit migration mapping rather than guessing. Removing a declaration does not delete data; changing its name creates another definition unless an explicit identity migration is approved. Duplicate historical binding namespaces cannot be merged automatically.

This mapping can land without F04. It must coordinate `src/config.ts`, `src/env.ts`, `src/worker-thread/thread-env.ts`, `src/worker-thread/wire-handlers.ts`, dispatcher construction/loopbacks, virtual modules, Vite module integration, dashboard listing and `src/testing/env-builder.ts`/`types.ts`/`index.ts`. Preserve existing cache/WorkerEntrypoint behavior. Basic declaration acceptance must not silently claim schedules or policy fields work: expose the tested subset and give a specific unsupported-setting diagnostic until their unit lands.

## F11 disposition: preserve existing local behavior

The user removed new Paid/Free limits and enforcement from this work. Preserve existing defaults and explicitly configured limits for **every** definition, including newly created ones. No account-plan selector, new instance-storage quota, standard-field policy expansion, policy snapshot migration or new retention enforcement belongs to stages 1–3.

Existing `maxRetentionMs` behavior remains enabled only when explicitly configured, with its current trigger and eligible states. Extending that existing cleanup transaction to remove new occurrence/chunk rows is necessary storage maintenance, not permission to add startup/periodic expiry or reinterpret zero as immediate deletion. Preserve current zero/disabled semantics.

Standard `limits.steps`, separate success/error retention and schedules are not silently implemented by this document. Any future addition needs a separately bounded contract without reopening the rejected plan/default proposal. Schedules additionally need persistent fire identity, missed-fire policy, reload ownership and cancellation; ordinary Worker cron does not establish that behavior.

## Staged gates

1. **Identity:** implement only the stage 1 territory and pass its six completion checks. Leader confirms this decomposition; approved storage choices do not need another architecture vote.
2. **Streams:** extend that verified identity store with chunks/commit manifests and the stage 2 acceptance cases. Do not bundle subscription output transport or quotas.
3. **Cooperative deletion:** integrate the verified cleanup/fencing paths and pass stage 3 acceptance. Do not bundle worker isolation or automatic retention.

Subscription and declaration units have separate design gates. They do not block this sequence and are not implicitly assigned by it.

Implementation verification: focused tests, Bun 1.4.2 typecheck/lint/dprint and coordinator full suite under `cpu-lease`. The design probe is not a conformance or performance result. No new dependencies are needed by the recommended storage/subscription design.

## Remaining decisions, outside the first unit

- F10a: approve durable-log design and legacy history coverage; pin stream-event encoding, restart cursor behavior and any prior-run preservation policy.
- F07b: decide whether/how to persist the definition-to-legacy-binding mapping. No class-name guessing or automatic namespace merge is authorized.
- Schedules and global-to-per-Workflow instance-ID migration require their own designs. Neither belongs to identity/checkpoint implementation.

Approved cooperative deletion and rejected account-plan defaults/limits are settled decisions, not questions to ask again.

## Contract references checked

- [Workers API](https://developers.cloudflare.com/workflows/build/workers-api/): occurrence context, restart selector, declarations, retention object, self-delete and duplicate batch behavior.
- [Subscription events](https://developers.cloudflare.com/workflows/build/subscribe-to-instance-events/): numeric exclusive cursor, disposal, event union, filtered terminal completion.
- [Limits](https://developers.cloudflare.com/workflows/reference/limits/): nonstream 1 MiB, Free/Paid storage and step bounds, sleeps excluded.
- [September 10 retention change](https://developers.cloudflare.com/changelog/post/2026-09-10-paid-retention-default/): seven days only for new Paid Workflow definitions; existing defaults preserved.

These pages were read on October 5, 2026. Unsettled details above are implementation gates, not established Cloudflare behavior.

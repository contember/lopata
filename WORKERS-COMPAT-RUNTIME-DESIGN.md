# Compatibility selection and tracing runtime design

October 5, 2026. **Proposal for approval, not an implementation or compatibility claim.** Scope: F09a and F05 from [the backlog](WORKERS-COMPAT-BACKLOG.md), following [the execution rules](WORKERS-COMPAT-PROGRESS.md). No source changes were made for this note.

The user excluded new Free/Paid plan selection and plan-derived limit enforcement. Preserve existing local defaults and limits. This does not remove API-specific validation or settle the compatibility/tracing architecture proposed here.

The user subsequently approved the five-rule selector foundation (explicit overrides, conflict errors, preserved no-date behavior, retained unimplemented flags and opt-in crypto) and staged tracing implementation (captured handles, completion after handler/body/background drain, existing transport, no-op outside invocations). Scoped crypto facades and other unasked architecture details remain proposals, not blanket approval.

## Recommended decisions

1. Introduce a pure compatibility selector with five feature rules: modern crypto, DO alarm deletion, and three WebSocket rules. Resolve once per worker configuration. Carry the resolved value explicitly; never select a callee's behavior from its caller's flags.
2. Preserve the existing local baseline when no date and no relevant override is supplied. Do not substitute today's date. Modern crypto remains explicit opt-in, at every date.
3. Validate input shape, real calendar dates, duplicate flags, and contradictory registered flags. Preserve unimplemented flags as uninterpreted input. A small supported registry cannot reject every unknown flag without breaking existing applications.
4. Keep Node host behavior in this series. Node opt-out enforcement requires a separate feasibility/approval unit. Bun deliberately provides working host APIs; missing Workers stubs is not the diagnosis.
5. Implement public tracing handles over the existing TraceStore operations. A handle captures its store, IDs, lifecycle and end state at creation; later annotations/end must never look up whichever invocation happens to be active.
6. Give each actual invocation a trace lifetime that finishes after its handler, returned stream and registered background work finish. Close forgotten manual spans at that boundary. Forced termination closes only spans owned by that executor/generation.
7. Vite's named tracing import must call the native runtime singleton through the existing global-bridge pattern. Do not import a second tracing module graph into the SSR runner.
8. Extend the existing DO command envelope with parent context and reuse the existing trace-message union. Do not introduce a second trace backend, stream protocol or trace RPC service.

Approval is required for the policies in sections 2–4 and the lifecycle ownership below. The proposed PR sequence is deliberately gated before shared-source work starts.

## 1. Evidence from current code

### Compatibility entry paths

| Path                                 | Current input and behavior                                                                                                                                                                                     | Required seam                                                                                                                                                        |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config.ts:136–146`              | Parses TOML/JSONC by assertion, shallow env override, validates Worker cache only. Date and flags are optional fields; no compatibility validation.                                                            | Validate the effective, env-overridden compatibility fields at this boundary. Also validate programmatic runtime construction.                                       |
| CLI / multi-worker / service targets | GenerationManager passes each worker's config to its executor; `worker-thread/entry.ts:167` reads flags for crypto. Date is unused.                                                                            | Each target resolves its own config. Queue, scheduled, email, fetch, RPC and Workflow code in that thread share that worker's selection.                             |
| DO / Container worker                | `do-worker-entry.ts:71–73` prefers the already-overridden `wranglerConfig`; standalone factories reload `configPath` without an environment override. Reads crypto flags.                                      | Use the passed target selection; standalone fallback selects from the config it actually loads. Preserve that fallback, rather than reloading normal DO configs.     |
| Dynamic worker                       | `WorkerCode` requires a truthy `compatibilityDate`; `worker-loader.ts` forwards only flags to `LoaderInitMessage`. `worker-loader-entry.ts:73` configures crypto; date is discarded.                           | Validate the dynamic descriptor before writing/spawning its module; send the descriptor's selection, not the parent's. Keep date required here.                      |
| Vite main worker                     | `dev-server-plugin.ts:426–431` loads its config and mutates host crypto once. User code runs in the SSR graph; the runtime is imported natively.                                                               | Resolve before module evaluation; isolate configuration between server instances and reloads.                                                                        |
| Vite auxiliary workers               | Existing auxiliary path uses GenerationManager/native worker threads, not the main SSR transform graph.                                                                                                        | Use the normal thread selection. F14's transformed auxiliary graph is separate.                                                                                      |
| `createTestEnv()`                    | `testing/index.ts:47–59` optionally loads Wrangler config, but `setupTestEnv()` has already installed globals. No config-specific crypto selection. Inline worker objects are already evaluated by the caller. | Scope string-module import and dispatch to the selected test worker. Do not promise control over inline objects' earlier module evaluation.                          |
| Direct test/setup/plugin imports     | `testing/setup.ts` and `plugin.ts` register globals/modules without worker configuration.                                                                                                                      | Retain the no-date local baseline outside a configured worker. Direct binding constructors remain local baseline until supplied a selection by their owning runtime. |

`setup-globals.ts:13–15` delegates to `configureModernCrypto(boolean)`. That function mutates methods on the single native `crypto.subtle` and `SubtleCrypto.supports` (`crypto-modern.ts:675–730`). It is safe per dedicated thread; toggling it between concurrent same-isolate invocations would leak configuration. This is an actual shared-process constraint, not solved by merely adding a date field.

### Tracing and completion hooks

| Owner                                       | What is already available / what is missing                                                                                                                                                                                                                                                                                               |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tracing/span.ts`                           | Internal `startSpan(opts, fn)` and `startSyncSpan` are callback runners used throughout instrumentation. Public `tracing` currently has only `enterSpan`. Its handle lacks chaining/end and remains mutable after completion.                                                                                                             |
| `tracing/context.ts`                        | One native ALS instance; parent adoption carries only `traceId`/`spanId`, reseeding local refs. There is no invocation lifetime/root handle.                                                                                                                                                                                              |
| TraceStore / RemoteTraceStore               | Insert, end, attributes, status, events and error operations already exist. RemoteTraceStore mirrors status locally. No new storage schema is needed for manual spans.                                                                                                                                                                    |
| `worker-thread/executor.ts:184–192,340–370` | Receives trace writes even after disposal. It does not track ownership of open remote spans for forced finalization.                                                                                                                                                                                                                      |
| Normal worker context                       | `WorkerExecutionContext` has no `tracing`. `waitUntil` has generation-wide add/settle IDs, but no per-invocation ownership.                                                                                                                                                                                                               |
| Normal fetch dispatch                       | `entry.ts:351–357` awaits the handler, posts headers, then starts a pump outside `runWithParentContext`. `pumpResponseBody` already accepts an `onComplete` callback. The context must be captured and restored around pump work.                                                                                                         |
| Shared pump                                 | `stream-shared.ts:343–412` invokes `onComplete` in `finally` for EOF/error/cancel/teardown, including a locked body's `getReader()` error. Callback has no outcome argument today. Some source cancellation promises are deliberately not awaited.                                                                                        |
| Generation drain                            | `generation.ts:280–306` consults pending handlers, fetches, background work and open streams. `activeRequests` alone is insufficient (and its `return startSpan(...)` runs the `finally` before the returned promise settles). Graceful drain and force-stop are already distinct.                                                        |
| ExecutionContext                            | `_awaitAll()` drains newly added background promises in a loop. Vite calls it detached. Queue consumption already awaits it.                                                                                                                                                                                                              |
| DO commands                                 | `do-protocol.ts:169–191` has a command ID and command but no parent. `do-worker-entry.ts:368–375` posts a result and then invokes `afterPost` for the response pump. That pump supports the shared completion hook but does not supply one.                                                                                               |
| DO reverse RPC                              | `do-worker-env.ts:32–37` already captures the active parent in RpcClient. Installing incoming context completes this existing propagation path.                                                                                                                                                                                           |
| DO state                                    | `DurableObjectStateImpl.waitUntil()` is a no-op (`durable-object.ts:707`). `_enter/_exit` cover the handler, not its stream or background work. DO executor activity already includes open response streams.                                                                                                                              |
| Vite HTTP                                   | `handleWorkerFetch` ends its span and decrements generation activity before detached `writeResponse` finishes. `writeResponse:1178–1199` swallows body errors and does not cancel its reader on client close. Socket `finish`/`close` must be observed, not guessed from handler return.                                                  |
| Vite imports                                | Native `span.ts` is loaded at startup; `__lopata_startSpan` already bridges React Router instrumentation. Generated `cloudflare:workers` has no tracing export and its `waitUntil` is a no-op. A direct SSR re-export would instantiate another ALS/store.                                                                                |
| Service calls                               | Thread targets use the existing executor parent envelope. In-process targets use WorkerDispatcher, with a fallback direct invocation and detached `_awaitAll` in `service-binding.ts`. Target-local invocation ownership is needed on both paths.                                                                                         |
| Queue / Workflow                            | `queue.ts:336–352` already wraps consumption in a span and awaits background work. `wire-handlers.ts` attaches its ExecutionContext. `workflow.ts:1657–1665` starts a fresh trace and awaits `instance.run` through the existing abort/timeout wrapper. These are actual event boundaries, not the earlier Workflow control RPC response. |

## 2. Compatibility selector contract

Add `src/compatibility.ts`. This is an internal runtime API, not a new `lopata` package export.

```ts
export interface CompatibilityInput {
	readonly date?: string
	readonly flags?: readonly string[]
}

export type CompatibilityMode = 'enabled' | 'disabled' | 'legacy-local'

export interface CompatibilitySelection {
	readonly date: string | null
	readonly flags: readonly string[]
	readonly unimplementedFlags: readonly string[]
	readonly modernCrypto: boolean
	readonly deleteAllDeletesAlarm: CompatibilityMode
	readonly websocketCloseReasonByteLimit: CompatibilityMode
	readonly websocketStandardBinaryType: CompatibilityMode
	readonly websocketAutoReplyToClose: CompatibilityMode
}

export function parseCompatibility(input: unknown): CompatibilityInput
export function resolveCompatibility(
	input: CompatibilityInput,
): CompatibilitySelection
```

`parseCompatibility` accepts an object with `date`/`flags`, rejects wrong types, null, empty flags and duplicates, and returns a copied representation. Config parsing maps snake_case fields into this boundary; the dynamic loader maps camelCase. `resolveCompatibility` also validates its input so typed programmatic callers cannot bypass the boundary. Freeze the result and its arrays locally; structured cloning removes freezing, so thread entry re-resolves/validates the received input rather than trusting a mutable selection received from outside the process.

### Registry

Pin rule metadata to released workerd `v1.20261005.1`, not announcement publication dates.

| Selection key                   | Enable flag                         | Disable flag                           | Default date        |
| ------------------------------- | ----------------------------------- | -------------------------------------- | ------------------- |
| `modernCrypto`                  | `webcrypto_modern_algorithms`       | None                                   | None; always opt-in |
| `deleteAllDeletesAlarm`         | `delete_all_deletes_alarm`          | `delete_all_preserves_alarm`           | `2026-02-24`        |
| `websocketCloseReasonByteLimit` | `websocket_close_reason_byte_limit` | `no_websocket_close_reason_byte_limit` | `2026-03-03`        |
| `websocketStandardBinaryType`   | `websocket_standard_binary_type`    | `no_websocket_standard_binary_type`    | `2026-03-17`        |
| `websocketAutoReplyToClose`     | `web_socket_auto_reply_to_close`    | `web_socket_manual_reply_to_close`     | `2026-04-07`        |

The binary-type flag's date is March 17 even though the backlog cites the April 21 announcement. Do not derive its threshold from that announcement.

Only crypto has an implemented behavior consumer in F09a. The other four are **selection seams reserved for F03/F08**, not implemented API claims. F03/F08 own the modern and explicit historical behaviors. Do not add speculative F07/F12 flags before their owners pin the relevant contract.

### Concrete policies

- Date syntax: exactly `YYYY-MM-DD`, year 2000–2999, valid Gregorian calendar day. Reject whitespace, timestamps, impossible dates and wrong field types. This is intentionally stricter than released workerd's basic month/day parser, which accepts February 30; document that local validation choice.
- Future dates: accept valid dates and select only known rules. No comparison to wall clock, no release-date ceiling, no automatic feature enablement beyond the registry. Lopata is not a deployment validator. This avoids an arbitrary server-build cutoff in a partial emulator and makes tests deterministic.
- No date: `date: null`; each non-crypto rule is `legacy-local` unless explicitly overridden. This preserves current behavior, rather than pretending the current implementation faithfully matches old workerd. For example current pair close dispatch can expose OPEN to the peer listener and CLOSED to self; it is not an accurate historical CLOSING contract.
- Explicit enable/disable wins over date. Both members of a registered pair are an error, regardless of array order. Duplicate strings are an error. Redundant enable after the default date is allowed; no new mandatory warning flow.
- Unknown/unimplemented strings are retained in `flags` and `unimplementedFlags`, with no effects. Do not invent a `no_webcrypto_modern_algorithms` flag: the pinned schema has no such flag. It is unimplemented input, not an override of the real crypto enable flag.
- No implicit Node enable/disable rule in this registry. `nodejs_compat`, `no_nodejs_compat`, v2 and individual module flags remain uninterpreted pending the separate boundary decision. Do not apply guessed prefix-based conflicts to unknown flags.
- `legacy-local` is stable behavior, not a moving latest-version default. F03/F08 must preserve the pre-change local code path for that value. An explicitly supplied date selects the corresponding historical/modern contract once its consumer is implemented.

These local policies require approval. They preserve working applications while making the supported subset deterministic and inspectable.

## 3. Compatibility wiring and same-isolate crypto

Normal/DO/dynamic worker initialization owns a `CompatibilitySelection`. Resolve before importing application code. Keep the raw config for other consumers; avoid changing binding storage identities or adding selection to persisted records.

Freeze these internal additions:

```ts
// WorkerInitConfig, ExecutorConfig and LoaderInitMessage additions
compatibility: CompatibilitySelection

// Same-process scope, in a new src/compatibility-context.ts
export function runWithCompatibility<T>(
	selection: CompatibilitySelection,
	callback: () => T,
): T
export function getActiveCompatibility(): CompatibilitySelection
```

`getActiveCompatibility` returns the frozen no-date baseline outside a scope. The same native module instance must serve Vite imports and dispatch. Dedicated worker entry wraps module loading and callback registration/dispatch so asynchronous descendants inherit the target selection. A callee always enters its own scope, even when it inherits trace context from the caller. DO objects and WebSockets eventually capture selection when constructed, so later methods do not consult an unrelated caller's scope.

For same-process dispatch, add a required `compatibility: CompatibilitySelection` parameter to WorkerDispatcher's constructor immediately before its existing optional legacy-fetch callback. Its `fetch`, RPC and property dispatch enter the stored selection. Add `compatibility: CompatibilitySelection` to the existing in-process resolved service-target variant so the direct fallback can do the same. Update the existing target factories and test fixtures together. Do not infer a target's flags from whichever context calls `_resolve()`. Thread targets need no per-call compatibility field: their initialization owns it.

For Vite and `createTestEnv`, approve a separate, small crypto isolation PR rather than changing global descriptors per invocation:

- Refactor the existing crypto adapter installation to produce two stable facades: legacy-restricted and modern. Reuse ModernCryptoAdapter and the existing native-modern rejection logic. Capture native methods once before installing any facade.
- Install one `crypto.subtle` accessor that chooses the facade from native compatibility ALS. Install a scoped `SubtleCrypto.supports` accessor that returns the matching function or the legacy absent value. Preserve existing non-modern functions, method receivers and crypto extras.
- A retrieved facade is bound to its worker's selection. A cached reference continues to behave according to that selection; obtaining a later global reference in another worker gives that worker's facade. This is a compatibility mechanism, not a security membrane between same-process code.
- Do not invoke the old toggling installer on each request. All applicable entry paths use the same selector and installation code; existing direct crypto unit tests can use the scoped runner.
- Scope Vite SSR module loading and reload, string-module test imports, all handler dispatch, in-process service targets and their asynchronous continuations. Inline pre-imported test modules cannot have earlier top-level crypto use retroactively scoped.

The factory seam is internal to `crypto-modern.ts`:

```ts
export interface CryptoFacades {
	readonly legacy: SubtleCrypto
	readonly modern: ModernSubtleCrypto
}

export function createCryptoFacades(): CryptoFacades
export function installCompatibilityCrypto(): void
```

Keep `installCompatibilityCrypto` in `setup-globals.ts`; it consumes the factory and native compatibility context. `SubtleCrypto.supports` uses the existing `modernCryptoSupports` contract, not a new signature. Probe configurable property behavior on Bun 1.4.2 before this PR's implementation; if a native accessor cannot support this design, stop and return to the approval gate rather than silently serializing requests or toggling process-wide state.

F09a is not complete until two differently configured workers, including overlapping same-isolate test dispatch, show no crypto leakage. The pure-selector PR can land earlier but must be labelled selection-only.

### Approved bounded F09a.3 scope

The user approved scoped facades for same-process dispatch and transformed Vite SSR evaluation after Bun 1.4.2 probes. Compatibility uses its own native ALS singleton, independently of tracing lifetime. Dedicated threads retain F09a.2's isolate-local installer so native top-level imports keep their selected behavior.

The user subsequently approved raising the supported minimum to **Bun 1.4.2**, including package metadata, documentation and CI/release verification. On Bun 1.3.14, `crypto.subtle` is a non-configurable own data property and cannot become an accessor. On Bun 1.4.2 it is inherited, so the scoped own accessor can shadow it. Older Bun versions are no longer supported; no alternate interception design or facade fallback is introduced. Both workflows pin Bun 1.4.2, and affected Vite subprocess tests use the parent executable rather than a bare `bun` resolved from PATH. Historical older-version probe results remain valid evidence for their recorded versions.

- Vite transformed module evaluation, Worker fetch/scheduled/email/queue dispatch, in-process services/loopbacks, returned RPC capabilities, and configured DO/Workflow helper execution use the owning worker's selection. Dispatchers are associated with both the module and its environment.
- Native test-module imports and Vite externalized dependencies are **not scoped at top level**. Bun native module evaluation does not inherit the importing ALS context. They see the legacy fallback when using the scoped installer; later runtime-managed dispatch is scoped. Inline modules' earlier evaluation and shared module-cache captures are not retroactively changed.
- Legacy `SubtleCrypto.supports` has value `undefined`, but `in` and `Object.hasOwn` report the installed accessor. This reflection difference is accepted.
- Captured facades, bound methods and modern references retain their selected behavior across calls from another scope. This is a compatibility mechanism, not a security boundary. Native prototype calls are not facade methods; native keys, usages and extractability retain their existing contracts.
- Outside configured same-process dispatch, the selector uses the frozen no-date baseline. Node's `webcrypto` alias shares the same crypto object. Node API enforcement is not part of this unit.
- Socket-event scope restoration remains a separate approval gate. EventTarget dispatch does not inherit listener registration scope; HTTP upgrade coverage does not establish socket-event compatibility.

### Node restriction feasibility: separate unit

The pinned schema enables `nodejs_compat` by date on August 4, 2026, but Lopata currently intentionally runs applications and its own runtime on Bun. Native filesystem, networking, process APIs and Node modules can be functional where Workers exposes a stub or a different virtual resource. Do not report them as missing APIs.

Recommend a read-only feasibility PR/note before enforcement: probe application and dependency `node:` imports, bare builtins, dynamic import, `require`, `process.getBuiltinModule`, globals, Bun APIs, native externalized Vite dependencies and top-level code. Distinguish application modules from Lopata internals, which require Node APIs regardless of user flags. A resolver-only deny list is not a complete boundary. No Node restrictions, sandbox claims or changes to host filesystem/network behavior in F09a. Human approval is needed to proceed from probes to any enforcement design.

## 4. Public tracing and captured ownership

Keep existing internal `startSpan(opts, fn)` / `startSyncSpan` names and signatures. Add distinct public functions (for example internal `startCustomSpan`) to the `tracing` object. Do not alias public `startSpan(name)` to the internal callback runner.

```ts
export type SpanAttribute = string | number | boolean | undefined
export type SpanException =
	| string
	| { code: string | number; name?: string; message?: string; stack?: string }
	| { code?: string | number; name: string; message?: string; stack?: string }
	| { code?: string | number; name?: string; message: string; stack?: string }

export interface SpanHandle {
	readonly isTraced: boolean
	setAttribute(key: string, value: SpanAttribute): this
	setAttributes(attributes: Record<string, SpanAttribute>): this
	recordException(exception: SpanException): void
	end(): void
}

export interface Tracing {
	enterSpan<T, A extends unknown[]>(
		name: string,
		callback: (span: SpanHandle, ...args: A) => T,
		...args: A
	): T
	startActiveSpan<T, A extends unknown[]>(
		name: string,
		callback: (span: SpanHandle, ...args: A) => T,
		...args: A
	): T
	startSpan(name: string): SpanHandle
	getActiveSpan(): SpanHandle | undefined
}

export const tracing: Tracing
```

`Error` structurally satisfies the exception union. Runtime calls still validate exception field types and ignore an object with none of code/name/message. Both setters are chainable; undefined values are ignored. `recordException` records an event and does not end the span or force an error status. Internal thrown-error behavior remains separate.

- `enterSpan` preserves sync return/sync throw and async fulfillment/rejection, forwards arguments, and auto-ends exactly once. An explicit early end disables later annotations and the automatic end is harmless.
- `startActiveSpan` activates only inside the callback's async context. It does not auto-end on return or throw. Caller context restores normally; async work created inside the callback retains its captured parent. No `enterWith` or process-global active span.
- `startSpan` creates a child of the current active span (or invocation root) without activation. Platform spans created afterward are siblings.
- `getActiveSpan` returns a cached handle for the actual current span, including internal instrumentation spans. If none is active within a live invocation, return that invocation's root handle. Outside an invocation, return undefined even if a diagnostic-only internal span happens to be active.
- Public `end` on runtime-owned handles is a no-op; only the runtime closes root/platform spans. This protects a root returned through `getActiveSpan`. Root annotations remain supported while the invocation is live.
- Public creation outside an invocation returns an untraced no-op handle and callback methods still call their callback with forwarded arguments. Do not create an orphan trace or lazily open a database just to supply a no-op handle.
- Ended handles report `isTraced: false` and ignore all later annotations. Captured handles from invocation A cannot annotate invocation B, even when used inside B or after an await with no active ALS.
- Retain current dev policy: invocations are locally traced by default. This PR does not add hosted sampling/config parity. The no-op behavior is exercised outside invocations and after completion.

Expose a structural store contract rather than expanding current casts:

```ts
export type TraceWriter = Pick<
	TraceStore,
	| 'insertSpan'
	| 'endSpan'
	| 'setSpanStatus'
	| 'getSpanStatus'
	| 'updateAttributes'
	| 'addEvent'
	| 'insertError'
>
export function getTraceWriter(): TraceWriter
export function setTraceStoreOverride(store: TraceWriter | null): void
```

Keep `getTraceStore(): TraceStore` for main-side querying/dashboard access. Move write-only call sites to `getTraceWriter`; both local and remote handles capture that writer once. A test changing the global writer after handle creation must not redirect that handle.

### Limits

Names truncate to a valid UTF-8 prefix of 64 bytes. Recommend a deterministic local 65,536-byte budget per public span: count UTF-8 keys/string values and exception code/name/message/stack strings; numeric values count 8 bytes and booleans 1 byte. Count accepted annotation writes cumulatively, including overwrites. Ignore undefined. Once a write would exceed the budget, drop that write, freeze subsequent annotation writes, and emit the documented `cloudflare.warning.type` and `cloudflare.warning.message` outside the budget. `setAttributes` processes entries in enumeration order, like repeated setters.

This specifies a local interpretation of the documented **approximately** 64 KB bound, not exact workerd allocator accounting. Approve this policy; if exact accounting is a requirement, pin its implementation first. Do not limit internal diagnostic attributes as an incidental consequence.

## 5. Invocation lifetime and completion

Add `src/tracing/invocation.ts`. Use the existing native tracing ALS, extended with `invocation?: InvocationTrace`. Internal child spans preserve this reference; adopting a remote parent creates a fresh local invocation lifetime, never shares a mutable lifetime across threads.

```ts
export type TraceCompletion =
	| { kind: 'complete' }
	| { kind: 'error'; error: unknown }
	| { kind: 'cancelled'; reason?: string }
	| { kind: 'terminated'; reason: string }

export interface InvocationTrace {
	readonly root: SpanHandle
	readonly completed: Promise<void>
	readonly closed: boolean
	run<T>(callback: () => T): T
	retain(
		kind: 'handler' | 'response-body' | 'wait-until',
	): (completion?: TraceCompletion) => void
	finishHandler(completion?: TraceCompletion): void
	terminate(reason: string): void
}

export function createInvocationTrace(options: SpanOptions): InvocationTrace
export function getActiveInvocation(): InvocationTrace | undefined
```

`createInvocationTrace` starts with one handler hold. `finishHandler` releases it once. Additional releases are idempotent. A failure/cancellation outcome is remembered while other holds drain. At zero holds: finalize still-open custom spans, end the runtime root, mark the lifetime closed and settle `completed`. No finalization registry, timeout heuristic or object-GC dependency. Manual span existence itself does not keep a worker alive indefinitely.

Runtime boundary ownership must be singular. The outer worker/Vite/DO event adapter creates the invocation before constructing its execution context; WorkerDispatcher reuses that explicitly supplied context for the same event. A nested service/loopback dispatch creates a fresh target invocation even in the same ALS tree. Internal instrumentation runners inherit the lifetime, but never create or finish an invocation merely because they have no parent. Internal span completion updates the same captured handle state used by `getActiveSpan`, so platform handles also become untraced after their runtime owner ends them. The DO `cleanup` command is infrastructure teardown, not a new user invocation.

Each worker invocation gets its own local runtime span parented to the received span ID. This is the **invocation root**, not necessarily the trace's `parentSpanId: null` span. It is inserted through existing trace operations, so it can own its complete lifetime without remote root-ID/status lookups. Existing main request wrappers can remain delegation/HTTP-header-duration parents in the first PR; document the extra invocation span and its full duration. They must not be presented as the full invocation duration. Vite can use the invocation root directly because dispatch and transport live in the same process.

### Exact hook placement

| Event / terminal path                   | Required ownership and completion                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker fetch                            | Create scope before dispatcher/context construction, run handler in it. Reserve the body hold before releasing the handler hold. Post headers as today; run the existing response pump in the captured scope. Release its hold from the existing completion hook. Bodyless responses release only the handler hold.                                                                                                       |
| Stream EOF/error                        | Pump completion is the source-body terminal boundary; it need not await consumption of bytes already copied to main. Preserve error outcome rather than calling every exit success. Returned streams must not be eagerly consumed or teed by tracing.                                                                                                                                                                     |
| Client cancel / fetch abort             | Cancel/abort through the existing channels. Mark cancellation and release the corresponding body hold on actual pump exit. Already registered `waitUntil` work may continue; cancellation alone does not kill its scope. Detached unregistered work does not prolong the invocation.                                                                                                                                      |
| Source cancellation callbacks           | Existing pump may fire completion before a user cancellation promise settles. Release the tracing body hold only after that cancellation cleanup settles when such a promise exists; retain force-termination as the escape hatch. This is a local pump callback change, not a new transport. Test an async cancel callback explicitly.                                                                                   |
| Worker scheduled/email/RPC/property-get | Own handler lifetime and context-specific background holds. Return the existing RPC result when the handler settles; do not block result delivery on background work. Finalize asynchronously when those holds drain. Cover getters and constructors throwing before handler entry.                                                                                                                                       |
| `waitUntil`                             | Capture the lifetime from context construction, acquire before attaching settlement handlers, log rejection once, release in `finally`. Preserve existing add/settle messages for reload accounting. `_awaitAll` remains available; nested registration while a hold is alive must be counted.                                                                                                                            |
| Queue                                   | Replace the existing queue invocation wrapper with the lifetime-aware root at the existing consume boundary. Preserve its batch/background drain and ack/retry semantics. `trackBackgroundWork` still represents the in-flight batch to main.                                                                                                                                                                             |
| Workflow                                | Use the existing `newTrace: true` run boundary, not the create/control command response. Finish on actual `instance.run` settlement under its existing cancellation controller. Preserve callback-settlement and persistence policy; do not redesign steps or timeouts.                                                                                                                                                   |
| DO fetch/RPC/alarm                      | Create a lifetime for each incoming command; adopt incoming parent first. Keep its `afterPost` continuation in the same scope. Attach body release to `pumpFetchBody`. `_exit()` remains concurrency accounting, not trace completion.                                                                                                                                                                                    |
| DO `state.waitUntil`                    | Track against the currently active invocation at the call, since state is instance-scoped and shared by concurrent commands. Replace the current no-op with background tracking and existing-style add/settle notifications; include pending background count in executor activity so idle eviction cannot immediately defeat tracing lifetime. This is bounded waitUntil ownership, not F12's general pending-I/O model. |
| In-process service call / loopback      | WorkerDispatcher creates a target invocation scope for a new dispatch, including RPC/property dispatch. Its context factory captures that lifetime. Fallback direct service invocation uses the same helper. Return headers/results immediately; wrap returned body with a lazy reader/cancel wrapper only on paths lacking an existing pump. No buffering or shared new stream protocol.                                 |
| Vite HTTP                               | Create native invocation before dispatch. Track `_awaitAll` and the actual body writer; observe `res.finish` and premature `res.close`, cancel the reader on close, preserve body error outcome. Keep generation activity until lifetime completion, not the detached write call. Register listeners before write/end, including bodyless/error responses.                                                                |
| Vite scheduled/email/service            | Same native lifetime, context and background holds. Capture the generation owning the invocation; later reload must not reassign it to the newest module.                                                                                                                                                                                                                                                                 |
| Test helper                             | Establish an invocation for each dispatch. Keep existing background-await contract. Returned body is lazy and holds its scope until EOF/error/cancel; test-env disposal forcibly finalizes remaining scopes.                                                                                                                                                                                                              |
| Graceful reload                         | Stop new work using existing drain hooks. Let existing handlers/body/background holds finish. Do not finalize at module replacement or header return.                                                                                                                                                                                                                                                                     |
| Force-stop/crash/DO abort               | Main executor closes its owned open spans with a terminal error reason before/alongside teardown; worker `finally` is not guaranteed to run after `terminate()`. Vite terminates generation-owned scopes on forced retirement/server close, not every ordinary HMR invalidation.                                                                                                                                          |

The pump's only shared signature adjustment is its last callback:

```ts
onComplete?: (completion: TraceCompletion) => void
```

Existing zero-argument callbacks remain assignable. Capture cancellation outcome in OutboundStreamRegistry locally; do not add stream messages. Hold acquisition, completion and registry cleanup must work for locked bodies, early cancellation while awaiting credit, and postMessage failures.

`TraceStore.evictStaleSpans` currently removes start-time cache entries after ten minutes without ending their rows. Later `endSpan` then silently returns. Fix this in the lifecycle PR: do not age-evict active invocation spans. Retain explicit lifecycle cleanup and startup crash recovery. If a cache entry is absent, `endSpan` can recover start time/end state from the existing row and complete it once. Live SSE/Workflow spans must remain endable after ten minutes. This needs a fake-clock/seeded-time regression test, not a ten-minute sleep.

### Thread termination without a new control plane

Extract the existing trace message union and main application switch into a small reusable receiver. Each executor owns one receiver and an in-memory set of span IDs **inserted by that thread**. An adopted parent's ID is not owned. On dispose/error, end outstanding owned spans. Do not close a whole trace: it may contain live spans from another worker or generation.

```ts
export type TraceMessage = Extract<WorkerMessage, { type: `trace-${string}` }>

export class RemoteTraceReceiver {
	constructor(writer: TraceWriter)
	handle(message: TraceMessage): void
	terminate(reason: string): void
}
```

Move the union definition out of WorkerMessage rather than creating a recursive type when DO reuses it. RemoteTraceStore's constructor narrows to `(post: (message: TraceMessage) => void)`. Both protocol unions include TraceMessage unchanged. The receiver preserves diagnostic error isolation.

After termination, queued end operations remain idempotent; queued inserts are inserted and immediately finalized with the termination reason. Ignore subsequent attribute/status/event writes to spans finalized by this receiver. Maintain source-channel ownership for the receiver's lifetime. Do not let late messages resurrect spans or close a replacement worker's IDs. Preserve writes to a live adopted parent while the sender itself is live.

### DO protocol seam

```ts
// Existing DOWorkerMessage member, with one optional field added
{ type: 'command'; id: number; command: DOCommand; parent?: ParentSpanContext }

// DOMainMessage reuses these existing user-worker members
TraceMessage
| { type: 'wait-until-add'; id: number }
| { type: 'wait-until-settle'; id: number }
```

Capture parent at `_sendCommand` entry before asynchronous readiness/disposal gates, then include it when posting. DO entry installs RemoteTraceStore before application import and runs each command under its parent plus a new invocation scope. Existing DO reverse RpcClient then propagates the correct child parent without any extra RPC envelope.

WebSocket upgrade is the end of the fetch event after its background work drains, not the lifetime of the socket. A later socket event needs its own invocation scope. The current bridge dispatch APIs do not expose aggregate asynchronous handler completion. Recommend a separate F05 event-adapter PR after the HTTP/RPC/alarm slice, covering plain socket listeners and DO hibernation handlers with their actual callback settlement rules. Do not claim full WebSocket-event tracing from a successful upgrade test. Dynamic-worker tracing/stream/context integration remains F16; F09a only carries its compatibility selection.

## 6. Vite singleton seam

Publish the native `spanMod.tracing` alongside the existing native bridges before `ensureWorkerModule` evaluates user code. Add a typed global declaration (in the existing Vite runtime-global declaration owner, or a new `src/vite-plugin/runtime-globals.d.ts` if none exists):

```ts
declare global {
	var __lopata_tracing: Tracing | undefined
}
```

The generated virtual module exports a forwarding object with the exact public Tracing methods. It resolves `globalThis.__lopata_tracing` at call time and never imports `tracing/span.ts` through Vite. Development startup guarantees installation; an absent bridge should produce an explicit initialization error rather than a second runtime or an apparently traced fallback. Production build behavior follows the existing virtual-module packaging policy; do not inject a persistent SQLite runtime into browser output.

Both ExecutionContext implementations expose `readonly tracing = tracing`. Named Vite import and `ctx.tracing` must find the same active span and store. Forward Vite's named `waitUntil` to the native active ExecutionContext bridge as part of lifecycle wiring; its current no-op would otherwise lose ownership for documented imported background work. Keep React Router's internal callback-runner bridge separate from public `tracing.startSpan`.

## 7. Small PR sequence and exclusive territories

Stack each verified PR on the previous published unit. Freeze the listed interfaces before dependent work. Shared files are handed off sequentially, not edited concurrently. The active Email/AI/Images/Hyperdrive agents retain their current territories; none of these designs needs edits in `email.ts`, `ai.ts`, `images.ts` or `stateless-env.ts`.

| PR     | Deliverable and owned files                                                                                                                                                                                                                                            | Gate / freeze                                                                                                                                                                       |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F09a.1 | Pure selector, config boundary, unit tests: new `compatibility.ts`, `config.ts`, dedicated compatibility tests.                                                                                                                                                        | Approve local date/no-date/unknown policies. Freeze selection shape and rule table. No behavior claim for reserved rules.                                                           |
| F09a.2 | Isolate wiring: `generation-manager.ts`, `worker-thread/protocol.ts`, `entry.ts`, `bindings/do-executor.ts`, `do-worker-entry.ts`, `worker-loader.ts`, `worker-loader-entry.ts`, `setup-globals.ts`; dedicated real-thread fixtures.                                   | Sequential shared-owner handoff. Freeze init selection field. Keep crypto's existing per-thread behavior while consuming selector.                                                  |
| F09a.3 | Same-isolate selection/crypto: new `compatibility-context.ts`, `crypto-modern.ts`, `setup-globals.ts`, `testing/index.ts`, Vite `dev-server-plugin.ts`, minimal WorkerDispatcher/service scope wiring.                                                                 | Approve scoped facade architecture and pass native-descriptor probe. Freeze native scope bridge before F05 Vite work.                                                               |
| F05.1  | Captured public handles and lifetime primitive: `tracing/span.ts`, `context.ts`, new `invocation.ts`, `store.ts` writer seam, write-only tracing consumers, focused tracing tests.                                                                                     | Approve root/no-op/byte-budget policy. Internal callback APIs retain their contracts. Test primitive through an explicitly constructed invocation; not yet normal-runtime coverage. |
| F05.2  | Trace receiver reuse and DO parent/trace wiring: `worker-thread/protocol.ts`, `do-protocol.ts`, `remote-trace-store.ts`, new receiver, both executors and both worker entries.                                                                                         | Handoff from F09a.2. Freeze trace union, ownership and optional DO parent field. No lifecycle completion claim merely from parent propagation.                                      |
| F05.3  | Ordinary worker event/stream/background lifecycle: `worker-thread/entry.ts`, `execution-context.ts`, `worker-thread/execution-context.ts`, `stream-shared.ts`, `generation.ts`, queue consume and Workflow run wrappers, `wire-handlers.ts`; TraceStore stale-end fix. | F05.1/2 frozen. This PR owns shared pump outcome hook. Preserve Queue and Workflow storage/settlement semantics.                                                                    |
| F05.4  | DO lifetime: `do-worker-entry.ts`, `do-executor-worker.ts`, `do-protocol.ts`, narrowly `DurableObjectStateImpl.waitUntil`, DO lifecycle/stream tests.                                                                                                                  | F05.3's hooks frozen. Approve bounded DO waitUntil activity; F03 and F12 must receive a sequential owner handoff afterward.                                                         |
| F05.5  | In-process/Vite/testing wiring: `worker-cache.ts` dispatch boundaries, `service-binding.ts`, `testing/index.ts`, `virtual-modules.ts` only if bridge helper is shared, Vite `modules-plugin.ts`, `dev-server-plugin.ts`, runtime-global types and fixtures.            | F09a.3 + F05.3 interfaces frozen. Real SSR import and network lifecycle checks required.                                                                                            |
| F05.6  | Socket event adapters and precise remaining F05 disposition, with bridge/DO listener owners assigned after inspecting their async callbacks.                                                                                                                           | Separate approval on event scope; do not conflate F08 wire semantics with callback lifetime.                                                                                        |

F09a.1 and F05.1 can be developed in parallel after approval because their source territories do not overlap. Runtime wiring PRs should be sequential. F03/F08 can consume the frozen selector after F09a.2 but must not write the worker-entry/pump seam concurrently with F05.

## 8. Meaningful acceptance tests

### Compatibility

- Table tests immediately before/at each pinned date; explicit enable before date and disable after it; contradiction in both orders; duplicate strings; leap-day validity; malformed JSON/TOML compatibility fields. Env override replaces the effective flags/date before validation.
- Unknown real application flags survive unchanged and do not enable features. Missing date preserves `legacy-local`, including no accidental crypto enablement at a future date.
- Dynamic descriptor rejects missing/invalid date before worker/module creation and uses its own flags when the parent differs.
- Real user-worker and DO fixtures perform a modern crypto operation with/without the flag; alternate two targets with opposite settings and assert bytes/errors, not selector snapshots alone.
- Same-isolate overlapping test workers and Vite reload exercise crypto under opposite settings across awaits and retained facade references. Named modern-only method visibility and `SubtleCrypto.supports` must not leak.
- Exercise standalone DO config fallback, normal env-overridden DO config, Vite auxiliary worker and string-module test setup. No-date inline test behavior remains baseline.

### Tracing

- Persisted span tree/event assertions for sync/async enterSpan, forwarded arguments, throws/rejections, active-parent restoration and non-activating manual spans. Returned values/errors remain identical to caller-visible behavior.
- Capture a manual handle in A, annotate/end it while B is active and after the writer singleton changes. Only A's captured backend/IDs receive operations; end is idempotent; late annotations are ignored.
- Root lookup before custom span, root end no-op, undefined outside invocation, no-op callback behavior, `isTraced` after explicit/finalizer end. Record string/Error/object exceptions without forcing end/status.
- UTF-8 multibyte boundary names and cumulative attributes/exceptions crossing the budget; warning fields survive and later writes are dropped. Do not assert JavaScript string length as byte size.
- Thread fetch returns headers before a delayed final chunk. A manual span remains open after handler return, records flush annotations, then ends. Separate case never calls end and verifies automatic finalization only after body/background completion.
- Cancellation while awaiting stream credit, locked returned body, async source cancel cleanup, body error, and waitUntil added by another waitUntil. Assert no dangling rows and no early closing of independent background work.
- Worker → DO → service nested call persists one trace with correct parent chain; two concurrent commands on one DO do not share invocation root/handles. Include DO streamed response and state.waitUntil.
- Graceful reload preserves old-generation spans until drain; forced reload and worker crash finalize owned spans, including late inserts. A concurrently live target sharing the trace remains open. No full-trace bulk ending.
- Real Vite SSR named import and ctx import share active span across awaits. Send a streamed HTTP request over the actual server, disconnect a client, and inspect persisted spans after finish/close. Repeat across HMR; a module-level import must not instantiate another database/store.
- Queue finalization occurs after existing batch/background settlement; Workflow trace lifetime follows actual run/abort settlement, not create/control return. Long-lived active spans remain endable beyond the old ten-minute cleanup threshold.

Run focused tests, typecheck, lint, dprint and the coordinator's full suite on Bun 1.4.2 under the required CPU lease. No tests were run for this design-only note; only its Markdown formatting is checked. Native accessor feasibility and socket-event callback behavior remain explicit pre-implementation checks.

## 9. Human approval checklist

The leader should ask for approval of these concrete defaults before assigning implementation:

1. Five-rule registry; real-calendar validation; future dates accepted; unimplemented flags retained; no-date `legacy-local`; no invented crypto disable flag.
2. Scoped crypto facades for Vite/testing rather than per-request global mutation, subject to the Bun descriptor probe.
3. Invocation-local runtime root spans (additional child spans under current main wrappers), always-on local tracing, no-op outside invocation, and the specified approximate byte-budget accounting.
4. Forgotten spans end at handler/body/background drain; cancellation permits registered background drain; forced termination marks only executor-owned spans errored. DO waitUntil contributes to activity, without taking on all of F12.
5. Separate Node enforcement feasibility and socket-event tracing follow-up. Dynamic tracing remains coordinated with F16. These dispositions must remain visible instead of marking the entire backlog item complete early.

## Sources

- [Custom spans contract](https://developers.cloudflare.com/workers/observability/traces/custom-spans/) — retrieved October 5, 2026; page updated September 25. Public methods, root/no-op end, manual lifetime, forwarding, exception types and approximate byte bounds.
- [Released compatibility metadata](https://github.com/cloudflare/workerd/blob/v1.20261005.1/src/workerd/io/compatibility-date.capnp) — exact flag spellings/default dates, crypto without default date/disable flag, Node default date.
- [Released compatibility compiler](https://github.com/cloudflare/workerd/blob/v1.20261005.1/src/workerd/io/compatibility-date.c++) — duplicate/conflict errors, explicit override semantics, redundant enable acceptance, upstream date parser and validation policies. The local deviations proposed above are intentional and approval-gated.

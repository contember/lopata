# Dynamic Workers, RPC ownership and facets design

Revision 2, November 2, 2026. **Approved on November 3, 2026: every item of the section 10 checklist, with the recommended option for each open decision. It is a design, not an implementation or compatibility claim.** Scope: F16 from [the backlog](https://github.com/contember/lopata/blob/d1b88a1/WORKERS-COMPAT-BACKLOG.md#f16--dynamic-workers-rpc-ownership-and-facets). It follows the structure of the [runtime design](https://github.com/contember/lopata/blob/d1b88a1/WORKERS-COMPAT-RUNTIME-DESIGN.md). Revision 1 (October 12) was reviewed in round 1 on this PR. The [revision notes](#revision-notes) at the end map each finding to the section that answers it.

**Baseline.** Lopata references point to `origin/main` at `beb5fe0`. [PR #49](https://github.com/contember/lopata/pull/49) merged as `3f4f3d9` and [PR #53](https://github.com/contember/lopata/pull/53) as `def925c`; neither needs to land first any more. [PR #69](https://github.com/contember/lopata/pull/69) is the first slice of this design (section 9) and is assumed merged. It pins Bun 1.4.4, the version `main`'s CI already ran. Revision 1's probes ran on Bun 1.3.14; two of them changed on 1.4.4, and this revision follows 1.4.4. workerd references name files and symbols on workerd `main` as of November 1, 2026. Most of the loader and facet server code moved from `server.c++` to Rust (`src/workerd/server/server/loader.rs`, `actor.rs`); line numbers are not given because they move. Cloudflare documentation was checked on November 2, 2026.

**Direction.** Keep the Cloudflare APIs. Make each documented contract observable locally with the smallest mechanism. Do not simulate hosted guarantees that local development does not need, and name them as accepted limits. Where Lopata deliberately differs from Cloudflare, the difference is documented and tested.

**Not a sandbox.** Dynamic Workers run in Bun worker threads in the Lopata process. They can use `node:fs`, `node:net`, `Bun.spawn` and every other host API. `globalOutbound` controls `fetch()`. It does not isolate the host. A platform that hosts untrusted agent code must not rely on Lopata for containment. This statement ships in the documentation with the feature. It does not excuse incorrect application-level semantics: RPC visibility, disposal and facet revocation must still behave as on Cloudflare.

## Recommended decisions

1. **The owning thread spawns its dynamic threads; Bun ends them with it.** On Bun 1.4.4, terminating a Worker also terminates the Workers it spawned (pinned by a test in #69). Owner dispose, crash teardown and `ctx.abort()` therefore end every dynamic thread without extra protocol. Revision 1's main-owned threads are withdrawn: on 1.4.4 they add a spawn round trip and ownership bookkeeping for no gain. A handshake tried in #69 for 1.3.14 was dropped after review: it delayed the owner's termination, so a DO transaction could commit after dispose.
2. **One transport.** The loader channel moves onto `RpcClient` / `RpcHostChannel` (`src/worker-thread/rpc-shared.ts`), made generic over the target type and running in both directions over one port. It replaces `LoaderCommand` / `LoaderResult` and the ad hoc `env-call` / `env-get` / `env-fetch` channel.
3. **Two serialization policies.** Loader `env` and entrypoint `props` accept data and persistent capabilities only, and reject everything else with `DataCloneError`, as `main` already does. Call arguments and results additionally carry functions, `RpcTarget`s and stubs by reference.
4. **Cloudflare disposal semantics.** Each call has a disposal group. Stubs received as parameters are disposed when the call returns unless `dup()`'d. Non-primitive results carry a disposer. Stubs created in an execution context are disposed when it ends. Each send exports a new entry. Garbage-collection release is the only accepted gap.
5. **RPC visibility is enforced where calls are served,** by target kind, as Cloudflare documents. Client-side proxy filtering is not relied on.
6. **The codec has an explicit envelope.** Capabilities travel out of band, cycles and aliases survive, and exports are allocated transactionally and rolled back on failure.
7. **Load like workerd.** `get()` starts loading when it creates a name. A failed load stays cached for the life of the binding. No retry.
8. **Facets run one thread per facet generation and store everything in one SQLite file per facet.** Terminating the thread revokes the facet's continuations, timers, storage handles and exported capabilities. One file gives Cloudflare's single-database atomicity and avoids lock interaction with the host's `data.sqlite`.
9. **Omitted `globalOutbound` inherits the caller's effective outbound policy.** `null` denies. A Fetcher receives every `fetch()`.
10. **Slice the work.** Fix (#69) → (a1) runtime init → (a2) thread ownership and streamed transport → (a3) codec and disposal → (b) modules → (c) egress → (d) facets.

Section 10 collects the open decisions.

## 1. Evidence from current code

### Loader binding and entry (`main` at `beb5fe0` plus #69)

| Location                                                     | Current behavior                                                                                                                                                                                                  | Consequence for F16                                                                                     |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `src/bindings/stateless-env.ts` `addStatelessBindings`       | Each env builder (main, user-worker thread, DO thread) creates its own `WorkerLoaderBinding`.                                                                                                                     | A host DO's `env.LOADER` runs in that DO's thread. The `get()` cache is per binding instance.           |
| `worker-loader.ts` `WorkerStub`                              | After #69: random per-stub directory, validated module names, cleanup of failed boots and of a stub disposed while loading.                                                                                       | The id is a cache key only. Path safety is done.                                                        |
| `worker-loader.ts` `get()`                                   | Lazy: the callback runs on the first request. A failed load stays cached.                                                                                                                                         | Loading must become eager (decision 7). Caching the failure already matches workerd.                    |
| `worker-loader.ts:311–360` `encodeLoaderEnv`                 | Strict env policy: cloneable data plus Fetchers (service bindings and specialized `ctx.exports` loopbacks). Functions, class instances, proxies and unspecialized loopbacks throw `DataCloneError` with the path. | The env policy is the base to extend, not to replace. Tests: `tests/worker-loader.test.ts` (env block). |
| `worker-loader.ts:363–400`, `worker-loader-entry.ts:110–131` | Env Fetcher calls go over an ad hoc `env-call` / `env-get` / `env-fetch` channel. Bodies are buffered with `arrayBuffer()`.                                                                                       | Replaced by the generic transport in (a2).                                                              |
| `worker-loader-entry.ts`                                     | Does not import `../plugin`. No `setGlobalEnv` / `setGlobalExports`. `ctx` is `{ waitUntil() {}, passThroughOnException() {} }`. A throwing entrypoint constructor falls back to the class (`catch {}`).          | No `cloudflare:workers`, no `ctx.props`, no `ctx.exports`, lost background work, hidden errors. (a1).   |
| `worker-loader-entry.ts`                                     | `globalOutbound: null` replaces `fetch` with a thrower; anything else keeps native `fetch`.                                                                                                                       | A gateway is never called. (c).                                                                         |
| `worker-loader-entry.ts`                                     | Responses and RPC results go through `postMessage`.                                                                                                                                                               | No streaming. A returned `RpcTarget` or function fails with `DataCloneError`. (a2), (a3).               |

### Context, exports and props

- `ctx.exports` exists in all three contexts: `src/execution-context.ts:38`, `src/worker-thread/execution-context.ts:47` and `DurableObjectStateImpl` (`src/bindings/durable-object.ts:903`). All read the per-thread `globalExports` (`src/worker-exports.ts:6`).
- `buildLoopbackExports` (`src/bindings/loopback-exports.ts:41`) builds `WorkerEntrypoint` and DO-class loopbacks. The worker thread (`src/worker-thread/entry.ts:233`) and the DO thread (`src/bindings/do-worker-entry.ts:121`) publish them before importing user code.
- The dynamic thread publishes no env and no exports. That is the whole remaining "F07" gap; the separate F07 slice of revision 1 is dropped.
- Lopata does not gate `ctx.exports` on a compatibility date. Dynamic workers should gate it on their own selection (`enable_ctx_exports` or date ≥ 2025-11-17, workerd `compatibility-date.capnp`).

### RPC and transport

| Location                         | Available                                                                                                                           | Missing for F16                                                                                                                                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rpc-stub.ts` `makeBindingProxy` | `fetch`, method calls, thenable property reads, per-prop callables.                                                                 | Dispose is a no-op. No capability brand.                                                                                                                                                                    |
| `rpc-stub.ts` local RPC stubs    | In-process `RpcTarget` / function stubs with `dup()` and `_`-prefixed filtering.                                                    | Dispose is a no-op. No cross-thread form. Filtering happens on the client side.                                                                                                                             |
| `rpc-shared.ts:55–76`            | `registerCloneable` / `tagCloneable` / `reifyArgs` revive class identity across `postMessage`.                                      | Data only.                                                                                                                                                                                                  |
| `rpc-shared.ts:91–125`           | `dispatchRpcCall` / `dispatchRpcGet` resolve members with an indexed read on the target.                                            | No visibility check: instance fields such as `env`, `ctx` or arrow functions are reachable.                                                                                                                 |
| `rpc-shared.ts:242` / `:368`     | `RpcHostChannel` (serving) and `RpcClient` (calling) with streamed bodies, early headers, cancellation and one backpressure window. | One direction per channel. `RpcClient` has no `dispose` or reject-all. A pending call stays registered when `postMessage` throws. `dispatchRpcFetch` carries `CFWebSocket` handling the loader must bypass. |
| `src/worker-thread/protocol.ts`  | Shared, defensive error serializer.                                                                                                 | The loader entry keeps only `name` / `message` / `stack`.                                                                                                                                                   |

### Durable Object storage and lifecycle

| Location                                              | Behavior                                                                                                                                                                                        |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `durable-object.ts:303`, `:404`                       | Sync and async KV use `do_storage (namespace, id, key, value)` in the shared `.lopata/data.sqlite`. SQL is a separate file `.lopata/do-sql/<namespace>/<id>.sqlite` (WAL, `busy_timeout=5000`). |
| `durable-object.ts:95–108`, `:545–620`                | Async `transaction()` holds a savepoint on the thread's `data.sqlite` connection across `await`s, serialized per connection by `dbTxnLocks`. After its first write it holds the write lock.     |
| `durable-object.ts:500–510`                           | `deleteAll()` refuses inside a transaction and deletes the alarm according to `deleteAllDeletesAlarm`.                                                                                          |
| `durable-object.ts:1285–1305`                         | `do_instances` rows are written only when an executor is created.                                                                                                                               |
| `durable-object.ts:1562–1600`                         | `deleteInstance()` removes the rows, the alarm and `<id>.sqlite` with `-wal` / `-shm`.                                                                                                          |
| `durable-object.ts` `durableObjectIdFromString` (#69) | `idFromString` accepts hex ids only. Host ids cannot contain `/` or `..`.                                                                                                                       |
| `src/api/handlers/do.ts`                              | The dashboard lists instances from `do_instances` and builds `do-sql` paths from request parameters without validation. (Outside F16; reported on #69.)                                         |

### Bun behavior (pinned by tests)

PR #69 pins Bun 1.4.4 in CI through `.bun-version` and turns every probe the design relies on into `tests/bun-runtime-assumptions.test.ts`:

| Assumption                                                                                                          | Used by                      |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Terminating a `Worker` also terminates the Workers it spawned. (On 1.3.14 they kept running.)                       | Decision 1, facet revocation |
| Runtime plugins are per thread.                                                                                     | (a1) plugin import           |
| A bare specifier does not resolve to a file next to the importer.                                                   | (b) bare specifiers          |
| A runtime `onResolve` hook sees relative specifiers but not bare ones.                                              | (b)                          |
| A `node_modules` symlink to an extensionless module loads it as JS, sharing one instance with `./name`.             | (b)                          |
| A runtime `onLoad` filtered on a directory runs for files with an extension, not extensionless ones.                | (b)                          |
| A `MessagePort` pair handed to two workers carries messages directly, keeping `Map` and `ArrayBuffer`.              | (a2)                         |
| `structuredClone(WebAssembly.Module)` copies the module. (On 1.3.14 it threw `DataCloneError`.)                     | (b) Wasm                     |
| `Transpiler#scanImports` reports static imports, re-exports, literal `import()` and `require()`, not computed ones. | (b)                          |

## 2. Target contract

| Surface                                                        | Contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Source                                                                                                                                                      |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOADER.get(name, getCode)`                                    | Returns a `WorkerStub` synchronously. A new name starts loading eagerly. A failed load is cached for the life of the binding; no retry. `null` / `undefined` mean "no name" (uncached). Any other value is string-coerced, so `get(123)` is `"123"`. Requests wait for the load; a load failure fails each request.                                                                                                                                                                                | workerd `worker-loader.c++` `WorkerLoader::get`, `server/loader.rs`; [API reference](https://developers.cloudflare.com/dynamic-workers/api-reference/)      |
| `LOADER.load(code)`                                            | `get(null, () => code)`. Validates synchronously. Never cached.                                                                                                                                                                                                                                                                                                                                                                                                                                    | `worker-loader.c++` `WorkerLoader::load`                                                                                                                    |
| `WorkerCode`                                                   | `compatibilityDate`, `compatibilityFlags?`, `allowExperimental?`, `limits?`, `mainModule`, `modules`, `env?`, `globalOutbound?: Fetcher \| null`, `tails?`, `streamingTails?`. "Dynamic Worker code must contain at least one module." `allowExperimental` throws unless the calling worker has the `experimental` flag.                                                                                                                                                                           | `worker-loader.c++`                                                                                                                                         |
| Modules                                                        | A string is valid only for names ending in `.js` or `.py`. An object has exactly one of `js`, `cjs`, `text`, `data`, `json`, `py`, `wasm`. `wasm` accepts bytes or a `WebAssembly.Module`. A `.ts` / `.tsx` / `.jsx` name gets workerd's hint error.                                                                                                                                                                                                                                               | `worker-loader.c++` `extractSource`                                                                                                                         |
| Size limits                                                    | Code ≤ 64 MiB in total. Env ≤ 1 MiB (estimate). `get()` checks env inside the callback and fails the request; `load()` throws synchronously.                                                                                                                                                                                                                                                                                                                                                       | `worker-loader.c++`                                                                                                                                         |
| `env` and `props`                                              | Serialized when the code (env) or handle (props) is created, by the loader's value serializer, not by RPC argument serialization. Allowed: cloneable data, service stubs (Fetchers, specialized loopbacks), `DurableObjectClass` handles. Rejected: functions and `RpcTarget`s ("Remote RPC references can only be serialized for RPC."), non-persistent stubs, entrypoints of dynamic workers ("Entrypoints to dynamically-loaded workers cannot be transferred…"), class instances.              | `worker-loader.c++`, `frankenvalue.c++`, `worker-rpc.c++`, `server.c++`; [env](https://developers.cloudflare.com/dynamic-workers/api-reference/#env-object) |
| `WorkerStub.getEntrypoint(name?, { props?, limits? })`         | Returns a `Fetcher`. Props are serialized when the handle is created and reach the entrypoint as `ctx.props`. Omitted, `null` and `"default"` name the default export. Errors: "Worker has no such entrypoint: X", "Worker has no default entrypoint."                                                                                                                                                                                                                                             | `worker-loader.c++`, `server/loader.rs`                                                                                                                     |
| `WorkerStub.getDurableObjectClass(name?, { props?, limits? })` | Returns a `DurableObjectClass`. Serializable in env, props and RPC.                                                                                                                                                                                                                                                                                                                                                                                                                                | `worker-loader.c++`; `actor.c++`                                                                                                                            |
| `limits: { cpuMs?, subRequests? }`                             | Per invocation. In `WorkerCode` and entrypoint options; the lower value applies.                                                                                                                                                                                                                                                                                                                                                                                                                   | [limits](https://developers.cloudflare.com/dynamic-workers/usage/limits/)                                                                                   |
| Platform limits                                                | At most 4 dynamic workers in flight per request and 10 per Durable Object.                                                                                                                                                                                                                                                                                                                                                                                                                         | [platform limits](https://developers.cloudflare.com/dynamic-workers/platform/limits/)                                                                       |
| `globalOutbound`                                               | Omitted: inherit the caller's outbound. `null`: `fetch()` and `connect()` throw "This worker is not permitted to access the internet via global functions like fetch(). It must use capabilities (such as bindings in 'env') to talk to the outside world." A Fetcher receives every `fetch()` with the original URL, and `connect()` through its `connect(socket)` handler ("Handler does not export a connect() function." without one).                                                         | `worker-loader.c++`; [egress](https://developers.cloudflare.com/dynamic-workers/usage/egress-control/)                                                      |
| RPC lifecycle                                                  | Stubs received as parameters are disposed when the call returns unless `dup()`'d. A non-primitive result gets a disposer that disposes the stubs in it. Stubs created in an execution context are disposed when it ends; an RPC-invoked worker's context is extended while stubs it passed are alive. Each send of one `RpcTarget` creates a new stub; its disposer runs once per send, after the last duplicate. "RPC stub used after being disposed." / "RPC promise used after being disposed." | [RPC lifecycle](https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/); `worker-rpc.c++`                                                    |
| Parameter ownership                                            | Since `rpc_params_dup_stubs` (default from 2026-01-20), a stub passed as a parameter is duplicated: the caller's stub stays usable. Before it (`rpc_params_transfer_stubs`), ownership transfers and the caller's stub is disposed. Results always transfer. The lifecycle page still describes the old rule.                                                                                                                                                                                      | `compatibility-date.capnp` `rpcParamsDupStubs`; `js-rpc-params-ownership-test.js`                                                                           |
| RPC visibility                                                 | On `RpcTarget`, `WorkerEntrypoint` and `DurableObject` instances only prototype methods and class getters are reachable; instance properties, arrow-function fields and `#` fields are not. Plain objects are copied by value. A function's own properties are readable.                                                                                                                                                                                                                           | [RPC visibility](https://developers.cloudflare.com/workers/runtime-apis/rpc/visibility/)                                                                    |
| `ctx.facets.get(name, getStartupOptions)`                      | Returns a `Fetcher` synchronously. The callback runs only when the facet is not running. It returns `{ class, id? }`; `class` is a `DurableObjectClass` or a DO class from `ctx.exports`. A stub binds to a facet instance on its first call. "The request which initiated this facet startup has already completed."                                                                                                                                                                              | `actor-state.c++`; [facets](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/)                                                 |
| Facet `ctx.id`                                                 | Inherits the parent's id and name by default. A `DurableObjectId` override is visible as such. A string override makes `ctx.id` that plain string.                                                                                                                                                                                                                                                                                                                                                 | `actor-state.c++` `DurableObjectState::getId`                                                                                                               |
| Facet names and depth                                          | Name ≤ 256 UTF-8 bytes, empty allowed. Tree depth ≤ 4 including the root.                                                                                                                                                                                                                                                                                                                                                                                                                          | `actor-state.c++`, `server/actor.rs`                                                                                                                        |
| `ctx.facets.abort(name, reason)`                               | Aborts the facet and its descendants. Calls through stubs bound to that instance throw the reason (converted like any exception). Storage is kept. A later `get()` may use another class.                                                                                                                                                                                                                                                                                                          | `actor-state.c++`, `server/actor.rs`                                                                                                                        |
| `ctx.facets.delete(name)`                                      | Aborts with "Facet was deleted." and deletes the facet's database and every descendant's. Durability is tied to the output gate. Returns `void`.                                                                                                                                                                                                                                                                                                                                                   | `server/actor.rs`, `worker-factory-actor.c++`                                                                                                               |
| Facet storage                                                  | One SQLite database per facet. The parent's `deleteAll()` aborts running child facets with "Facet was deleted." and deletes all descendant storage. The documentation requires a SQLite-backed parent; workerd local does not check.                                                                                                                                                                                                                                                               | `server/actor.rs`; [facets](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/)                                                 |
| Facet alarms and transfer                                      | "Facets currently cannot set alarms.", raised when the write commits, not synchronously. Facet stubs are not serializable; class handles are.                                                                                                                                                                                                                                                                                                                                                      | `actor-sqlite.c++` `FacetAlarmHooks`; `server/actor.rs`                                                                                                     |
| `ctx.facets.clone()`                                           | In `@cloudflare/workers-types`. Lopata throws "not supported by Lopata".                                                                                                                                                                                                                                                                                                                                                                                                                           | `@cloudflare/workers-types`                                                                                                                                 |

A consuming application expects module specifiers, including bare ones, to resolve relative to the importing module. Pin this with a workerd fixture in (b) before relying on it.

## 3. Consumer scenario

A platform that hosts agent code runs this flow in a SQLite-backed host Durable Object:

```js
const worker = env.LOADER.get(id, () => ({
	compatibilityDate,
	compatibilityFlags: ['nodejs_compat'],
	mainModule: 'main.js',
	modules: {
		'main.js': '...',
		'some-bare-name': { js: '...' },
		'sdk/chunk-x.js': '...',
	},
	env: { HOST: ctx.exports.RuntimeHost({ props: { instance } }) },
	globalOutbound: ctx.exports.EgressGateway({ props: { instance } }),
}))
const facet = ctx.facets.get(
	'runtime',
	() => ({ class: worker.getDurableObjectClass('Runtime') }),
)
await facet.fetch(request)
await facet.someMethod(args)
// Inside the facet: ctx.storage.sql, ctx.storage.kv, env.HOST.setAlarm(...)
ctx.facets.abort('runtime', reason) // the next get() restarts the facet with its storage intact
```

| #  | Step                                                                                  | Today on `main` (+ #69)                                                     | Lands in                                      |
| -- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------- |
| 1  | `env.LOADER.get()` from a DO thread                                                   | Works. The dynamic thread ends with the DO thread (Bun 1.4.4).              | —                                             |
| 2  | `compatibilityFlags: ['nodejs_compat']`                                               | Selection resolved per dynamic worker. `nodejs_compat` stays uninterpreted. | —                                             |
| 3  | `'main.js'` and `'sdk/chunk-x.js'` strings, relative imports                          | Works.                                                                      | —                                             |
| 4  | `'some-bare-name': { js }` imported as a bare specifier                               | Fails: "Cannot find package".                                               | (b)                                           |
| 5  | Loaded code imports `DurableObject` from `cloudflare:workers`                         | Fails: the plugin is not loaded in the dynamic thread.                      | (a1)                                          |
| 6  | `env.HOST = ctx.exports.RuntimeHost({ props })`                                       | Works for fetch and cloneable RPC over the env channel.                     | (a2) moves it onto the transport              |
| 7  | `globalOutbound = ctx.exports.EgressGateway({ props })`                               | Treated as "allow". The gateway is never called.                            | (c)                                           |
| 8  | `worker.getDurableObjectClass('Runtime')` and `ctx.facets.get()`                      | Neither exists.                                                             | (d)                                           |
| 9  | `facet.fetch(request)` and RPC methods with callback arguments                        | —                                                                           | (d) on (a3)                                   |
| 10 | Facet `ctx.storage.sql` and `ctx.storage.kv`                                          | —                                                                           | (d)                                           |
| 11 | Facet calls `env.HOST.setAlarm(t)`                                                    | —                                                                           | (a2). Facet `ctx.storage.setAlarm` fails (d). |
| 12 | Host `alarm()` later uses the facet                                                   | —                                                                           | (d)                                           |
| 13 | Every `fetch()` from loaded code reaches `EgressGateway`                              | Bypassed.                                                                   | (c)                                           |
| 14 | `ctx.facets.abort('runtime', reason)`; storage intact after abort, reload and restart | —                                                                           | (d)                                           |

Step 11 is reentrant: `RuntimeHost` calls the host DO through main while the host may still await the facet. Lopata's input gate waits only for `blockConcurrencyWhile`, so the call completes unless the host awaits the facet inside `blockConcurrencyWhile`, which deadlocks in Lopata. Facet storage in its own file (section 7) removes the second hazard of revision 1: a host `transaction()` holding the `data.sqlite` write lock while it awaits a facet that writes KV.

Route matrix for the scenario. The capability codec covers the loader channel (dynamic thread ↔ owning thread). Other hops keep the structured-clone transport:

| Route from the dynamic worker                   | Cloneable args/results | Callbacks, `RpcTarget`s, stubs                                                  |
| ----------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------- |
| Loopback of the owning worker (`ctx.exports.X`) | Works                  | Works: served in the owning thread, one hop.                                    |
| Service binding to another worker               | Works                  | Fails at the owning thread → main hop with a `DataCloneError` naming the route. |
| DO stub of another Durable Object               | Works                  | Same as above.                                                                  |

The scenario uses only the first route. Extending the codec to the main ↔ worker channels is a follow-up with its own design. The SDK gate (section 8) checks which routes each SDK uses.

## 4. PR (a): runtime init, transport, ownership and disposal

### (a1) Runtime init in the dynamic thread

- The dynamic entry imports `../plugin`, registers module rules, and calls `setGlobalEnv(env)` and `setGlobalExports(buildLoopbackExports(module, env, []))` before importing user code, as `do-worker-entry.ts` does. `cloudflare:workers`, `caches`, `HTMLRewriter` and `WebSocketPair` then exist.
- `ctx.exports` follows the dynamic worker's own compatibility selection (`enable_ctx_exports` or date ≥ 2025-11-17).
- Each invocation gets a real execution context: `props`, a tracked `waitUntil`, `passThroughOnException`, `exports`. Entrypoints are constructed with `resolveEntrypointHandler` / `constructEntrypoint` (`src/entrypoint-handler.ts`). A throwing constructor fails the call; the fallback to the class is removed. Missing entrypoints throw workerd's texts.
- `getEntrypoint(name, { props, limits })` and `getDurableObjectClass` validate and serialize props and limits immediately with the env policy (section 4, "Serialization policies") and bind an immutable snapshot to the handle. Mutating the props object later has no effect. Invalid props throw at handle creation.
- `get()` invokes the callback when it creates a name (decision 7). The returned promise gets a handler, so a failure surfaces on requests, not as an unhandled rejection.
- Fetch and cloneable RPC still use the existing loader channel. This slice is small and independently testable.

### (a2) Thread ownership and the shared transport

**Ownership.**

- The thread that holds the loader binding spawns the dynamic `Worker`, as today, and talks to it over the `Worker` port. Bun 1.4.4 terminates the dynamic thread with its owner (decision 1), on dispose, crash teardown and `ctx.abort()`.
- A failed boot terminates the thread it created before reporting the error (#69). A stub disposed while loading spawns nothing (#69).
- The owner observes the dynamic thread's `error` and `close` events. It rejects pending calls with a channel-closed error and closes its tables.
- **Directories.** A terminated owner cannot remove its stub directories. Stub directories are named `<pid>-<ownerThreadId>-<uuid>`. When main terminates a runtime thread, it removes that thread's directories. At startup Lopata removes only directories whose process is no longer alive, so two runtimes sharing one data directory do not delete each other's files.
- When the loader runs on main (Vite, `createTestEnv`, in-process DOs), the binding owner's teardown disposes the stubs.
- **Idle eviction.** A dynamic thread with no in-flight invocation, no live exported capability and no running facet is terminated after the DO idle timeout. The stub stays; the next request boots a fresh thread. Module state is lost, as when workerd evicts an idle isolate. This bounds threads for a long-lived DO that loads many code versions.
- **Platform limits.** Lopata does not enforce the 4-per-request and 10-per-DO in-flight caps (open decision A4).

**Channel.** `RpcClient` and `RpcHostChannel` become generic over the target type. Existing channels keep `BindingTarget`. The loader's `Worker` port runs one instance of each in both directions. New API: `RpcClient.close(reason)` rejects every pending call; a failed `postMessage` removes the pending entry and rejects the call. The loader target bypasses the `CFWebSocket` handling in `dispatchRpcFetch`; a `101` from a dynamic worker fails with "WebSocket upgrades from dynamic workers are not supported by Lopata" until bridged.

```ts
// src/bindings/worker-loader-protocol.ts (new)
export type LoaderTarget =
	| { kind: 'entrypoint'; handle: number } // snapshot of name, props and limits, registered when the handle is created
	| { kind: 'capability'; id: number }
	| { kind: 'facet'; key: string; generation: number } // (d)
```

Props never travel per call; the target names a handle registered once.

**Errors.** Every error crossing the port goes through the shared serializer in `protocol.ts`, the same as other channels, with its compatibility-dependent own-property handling. Encode and decode failures produce one response type that rejects the call and rolls back allocated capabilities (section "Codec"). An unserializable thrown value becomes an `Error` that says so; it never strands the call or terminates a worker.

**Acceptance (a2).** Streamed request and response bodies with backpressure and cancellation, including cancellation before headers and mid-body. Owner dispose, crash and `ctx.abort()` stop a dynamic timer that writes a file (#69 covers dispose and abort). A dynamic thread that exits abnormally rejects the owner's pending calls. Main removes a terminated owner's stub directories. Two runtimes sharing a data directory keep each other's stub directories. Idle eviction ends the thread and the next request boots again.

### (a3) Codec, serialization policies, visibility and disposal

**Serialization policies.** One graph walker, two modes:

| Value                                                                             | `env` / `props` mode                                                      | RPC mode (args and results)                                     |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Structured-cloneable data (`Map`, `Set`, `Date`, `ArrayBuffer`, views, …)         | Copied                                                                    | Copied                                                          |
| Plain objects and arrays                                                          | Walked                                                                    | Walked                                                          |
| Service bindings, specialized `ctx.exports` loopbacks                             | Capability                                                                | Capability                                                      |
| `DurableObjectClass` (from `getDurableObjectClass` or `ctx.exports.X({ props })`) | Capability                                                                | Capability                                                      |
| Unspecialized `ctx.exports` loopback                                              | `DataCloneError` (as today)                                               | Capability                                                      |
| Functions, `RpcTarget`s                                                           | `DataCloneError`: "Remote RPC references can only be serialized for RPC." | Capability (transient)                                          |
| Stubs received over RPC (non-persistent)                                          | `DataCloneError`                                                          | Capability                                                      |
| Entrypoints of dynamic workers                                                    | `DataCloneError` (workerd's text)                                         | Capability                                                      |
| DO stubs and namespaces, other bindings (KV, R2, …)                               | `DataCloneError` until a workerd fixture shows otherwise                  | DO stubs: capability; others: `DataCloneError`                  |
| Facet stubs                                                                       | `DataCloneError`                                                          | "Stubs pointing to Durable Object facets are not serializable." |
| User class instances                                                              | `DataCloneError` (as today)                                               | `DataCloneError`                                                |
| `WebAssembly.Module`                                                              | Copied; pin against workerd with a fixture                                | Copied                                                          |

The walker extends today's `encodeEnvValue`. Errors keep `DataCloneError` and name the path (`env.HOST.x`). The env is encoded once per boot and its 1 MiB estimate is checked on the encoded form. Differential fixtures against workerd pin each row before the row ships.

**Envelope.** A message carries `{ value, caps }`. The encoder walks the value with an identity map, so cycles and shared objects are copied once and stay aliased. Each capability position is replaced by a fresh placeholder object, and `caps[i]` holds `{ placeholder, id, kind }` for the same placeholder. Structured clone preserves the identity between the placeholder in `value` and in `caps`. The decoder walks the clone with an identity map and swaps placeholders for proxies, including `Map` keys and `Set` values. User data cannot forge a capability: only objects listed in `caps` are swapped, and ids are channel-local, monotonic and never reused.

**Transactional export.** Exports created while encoding go into a pending batch. The batch commits only after `postMessage` succeeds. A throwing getter, a size check, a `DataCloneError` or a failed post rolls the batch back and rejects the call. A call or release on an unknown id rejects with "RPC stub used after being disposed."; a duplicate release is ignored.

**Visibility at the serving boundary.** The serving side resolves every call and property read by target kind before touching the target:

| Target                                                    | Callable / readable                                                                                                                                                                                |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkerEntrypoint`, `DurableObject`, `RpcTarget` instance | Methods and getters on the prototype chain below the base class. Not own instance properties, arrow-function fields or `#` fields. `constructor` and the base-class internals are never reachable. |
| Plain object (inside a result)                            | Copied by value; it is never a call target.                                                                                                                                                        |
| Function                                                  | The call itself and its own properties.                                                                                                                                                            |
| Service binding, loopback, DO stub                        | Delegated to the binding, which applies its own rules.                                                                                                                                             |

Protocol operations (`fetch`, release, `dup`) are separate message types, never member names. Client-side filtering stays only as a convenience.

**Disposal model.** One invocation scope per served call (fetch, RPC method, property read, scheduled) carries: the parameter disposal group, transient exports created during the call, the `waitUntil` set, the abort signal, the `subRequests` budget and the compatibility selection.

| Event                                                    | Effect                                                                                                                                                                                   |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Call arrives with stubs in its parameters                | The callee's proxies join the call's parameter group. When the call settles (success or error), the group is disposed. `dup()` creates an independent handle outside the group.          |
| Caller passes a stub as a parameter                      | Caller compatibility selects the rule. `rpc_params_dup_stubs` (date ≥ 2026-01-20): the caller's stub stays usable. Earlier dates: ownership transfers and the caller's stub is disposed. |
| Callee returns a non-primitive value containing stubs    | The caller receives the value with a `[Symbol.dispose]` that disposes every stub in it. The callee's references transfer with the result.                                                |
| Exporter sends an `RpcTarget` or function                | A new table entry per send. The target's own `[Symbol.dispose]` runs once per send, after the last handle from that send is disposed. Its exceptions are logged, not propagated.         |
| `stub[Symbol.dispose]()` / `using` exit                  | Posts a release. Later use rejects with "RPC stub used after being disposed." Other duplicates keep working.                                                                             |
| Execution context of the importer ends                   | Every stub created in that context and not `dup()`'d past it is disposed. The client captures the active context when it starts a call and registers decoded result stubs there.         |
| Exporter's invocation passed stubs that are still alive  | The exporter's context is extended until they are released, so `waitUntil` accounting keeps the parent alive.                                                                            |
| Invocation cancelled (client disconnect, owner teardown) | Transient exports of that invocation are revoked; their calls reject with the cancellation reason.                                                                                       |
| Channel close                                            | Both sides reject pending calls and empty their tables.                                                                                                                                  |
| Garbage collection of an unreferenced proxy              | Not handled (no `FinalizationRegistry`). Accepted gap: a stub kept past its context without `dup()` is still disposed at context end, so leaks are bounded by context lifetime.          |

**Invocation end.** The invocation completes when the handler has settled, the response body has finished or been cancelled, its `waitUntil` set is empty, and no stub it exported is alive. Concurrent invocations have separate scopes and budgets. A target returned by one invocation and called later runs under the caller's new invocation, with that invocation's budget. Each outbound operation counts once: the egress seam counts `fetch()`, the capability seam counts capability calls, and a capability `fetch` is counted by the capability seam only.

### Open decisions (a)

- A1. Owner-spawned dynamic threads that Bun terminates with their owner, pinned by a test (recommended). Main-owned threads are withdrawn. If a future Bun stops terminating nested Workers, the pinned test fails and main ownership comes back.
- A2. Two serialization policies as in the table (recommended). Rows without a workerd fixture stay rejected until one exists.
- A3. Cloudflare disposal semantics with per-call groups, result disposers, context-end disposal and compat-selected parameter ownership; no GC release (recommended).
- A4. Platform in-flight caps (4 per request, 10 per DO): document and do not enforce (recommended), or enforce with Cloudflare's error.
- A5. Idle eviction of dynamic threads after the DO idle timeout (recommended).

### Acceptance (a3)

- Round trip of `Map`, `Set`, `ArrayBuffer`, typed arrays, `Date`, nested data, a self-cycle, a shared object and a `Map` key that holds a capability. Token-shaped user data stays data.
- Env and props: every row of the policy table, with `DataCloneError` and the path. Props are snapshotted: mutation after `getEntrypoint()` is invisible, invalid props throw at creation, two handles of one export with different props stay isolated.
- Visibility: positive tests for prototype methods and getters; negative tests for `env`, `ctx`, an own data field, an arrow-function field, `constructor` and base-class internals on an entrypoint and on an `RpcTarget`.
- Disposal: a callback parameter called after the call returns rejects with "RPC stub used after being disposed."; with `dup()` it works. The same with a failing call. `using result = await stub.method()` disposes the stubs inside `result`. A caller's parameter stub survives the call with date ≥ 2026-01-20 and is disposed with an earlier date. Forwarding a parameter to a second call works. An `RpcTarget` sent twice has its disposer called twice. The exporter's table returns to zero after 1000 callback calls.
- Failure paths: a throwing getter mid-encode, an oversized value and a failed post leave no table entry and no pending call. A stale id and a duplicate release behave as specified.
- Errors: `Error` with `cause` and `code`, a primitive throw, a non-cloneable field and a throwing getter on the error all reach the caller without stranding the call.
- Routes: dynamic → host loopback with a callback and a returned target works; dynamic → other worker and dynamic → other DO with cloneable values work and with a callback fail with the route-naming error.

## 5. PR (b): modules, compatibility and limits

**Identity.** `get(name, cb)`: `null` / `undefined` create an uncached stub; anything else is string-coerced and cached per binding. Loading is eager; failures are cached (section 2). Directories are random per stub (#69).

**Module validation.** Names are already contained (#69). (b) adds workerd's rules: a string body requires a `.js` name; `.py` and `{ py }` fail with "Python Dynamic Workers are not supported by Lopata"; an object has exactly one known key; `.ts` / `.tsx` / `.jsx` get workerd's hint; at least one module; total code ≤ 64 MiB. Names whose path would collide on disk (`pkg` and `pkg/sub.js`), and names with a `node_modules` or `.lopata-` segment, are rejected with an explicit error, so generated files never collide with user modules.

**Materialization.** Every module file on disk is JavaScript. The virtual module name is the identity; the physical path is derived from it.

| Descriptor                     | File content at `<name>`                                                                                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `js`                           | The source.                                                                                                                                                          |
| `cjs`                          | The source. Pin `require()` between descriptor modules with a fixture first.                                                                                         |
| `text`                         | `export default <JSON string>`                                                                                                                                       |
| `json`                         | `export default <JSON value>`                                                                                                                                        |
| `data`                         | Through the existing typed-module loader (`src/module-rules.ts`): an `ArrayBuffer` with exact bytes, honouring view offsets.                                         |
| `wasm` from bytes              | Through the typed-module loader: a `WebAssembly.Module` compiled from the bytes.                                                                                     |
| `wasm` as `WebAssembly.Module` | The module object is structured-cloned to the dynamic thread and exported through the typed-module loader. Its bytes are not recovered (pinned by #69's probe test). |

- A runtime `onLoad` in the dynamic thread forces `loader: 'js'` for files with an extension under the stub directory. Extensionless files already load as JS.
- **Bare specifiers.** At write time, `Bun.Transpiler#scanImports` lists every static edge. Each edge must resolve to a module in the map: relative and absolute specifiers against the importer, bare ones to `join(dirname(importer), specifier)`. For a bare edge, `<dirname(importer)>/node_modules/<specifier>` becomes a symlink to the module file. A missing target fails the load: `No such module "<specifier>" imported from "<importer>"`. `cloudflare:`, `node:` and Node built-in names are exempt.
- **Computed `import()`** cannot be validated at write time (open decision B2).

**Compatibility.** Each dynamic worker uses its own selection, also when the parent's differs. `allowExperimental` follows workerd: it throws unless the calling worker has `experimental`. `nodejs_compat` stays uninterpreted.

**Limits.** Validate `{ cpuMs?, subRequests? }` as non-negative integers; the effective value is the per-field minimum. `subRequests` is counted per invocation (section 4) and throws `Error('Too many subrequests.')`; this text is Lopata's own, because neither the docs nor workerd name one. `cpuMs` is accepted and not enforced, with a one-time warning: Bun's `process.cpuUsage()` is process-wide.

### Open decisions (b)

- B1. Materialization as above: JS files, typed-module loader for data and Wasm, `onLoad` forcing, `node_modules` symlinks and full static-edge validation (recommended). The alternative rewrites specifiers in the source and needs a lexer dependency.
- B2. Computed `import()`: stub directories live under `.lopata`, so Bun's resolution can fall back to the project's `node_modules` and a missing worker module can silently resolve to a host package. Options: (i) document it (recommended for (b), smallest); (ii) place stub directories outside the project, which avoids host packages but exposes Bun's auto-install unless it is disabled for the thread. Decide with a fixture of workerd's behavior for a computed import of a map module.
- B3. Enforce `subRequests`; accept `cpuMs` unenforced (recommended).
- B4. Load eagerly and cache failures, as workerd (recommended). Revision 1's retry is withdrawn. If a retry is wanted later for hot edits, it is a documented difference behind an explicit option.

### Acceptance (b)

- `get(null, cb)` twice gives two stubs with separate state; `get('x')` twice gives one; `get(123)` caches under `"123"`. The callback runs at `get()`. A failed callback fails every request and is not retried.
- Every descriptor imports with the right type, including extensionless and mismatched-extension names and `ArrayBufferView` offsets. A precompiled `WebAssembly.Module` instantiates in the dynamic worker.
- Rejected with workerd's texts: a string module without `.js`, `.py`, two keys, `.ts`, no modules, oversized code and env, a missing static import, a `pkg` / `pkg/sub.js` collision.
- `'some-bare-name'` from `main.js` resolves to the root module; the same specifier from `sdk/chunk-x.js` resolves to `sdk/some-bare-name`; one instance per file.
- Crypto and `ctx.exports` follow the dynamic worker's own compatibility selection.

## 6. PR (c): egress, streaming acceptance and tails

**Egress.** Parsed at the API boundary into three distinct states:

| `globalOutbound` | `fetch()` in the dynamic worker                                                                                                                  | `connect()` from `cloudflare:sockets`                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| omitted          | The calling runtime's effective policy. Host threads have unrestricted outbound today, so this is Bun's `fetch`.                                 | Throws "TCP sockets are not supported by Lopata" (documented divergence: Cloudflare connects).                              |
| `null`           | Throws workerd's no-internet text (section 2), at top level and in handlers.                                                                     | Same text.                                                                                                                  |
| Fetcher          | `new Request(input, init)` goes to the capability's `fetch` with the original URL, method, headers and streamed body; the response streams back. | Throws "TCP sockets are not supported by Lopata" (Cloudflare calls the gateway's `connect(socket)`; documented divergence). |

- Inheritance is computed from the effective policy of the thread that calls `get()` / `load()`. Only host threads hold a loader today: a dynamic worker cannot receive a loader in `env` (the env policy rejects it). If recursive loading becomes possible (a facet of a DO-class loopback that has `env.LOADER`), the facet's thread passes its own policy down; a test covers allow, deny and gateway inheritance then.
- The dynamic thread registers a `cloudflare:sockets` module only to make these errors explicit.
- `node:http`, `node:https`, `node:net`, `node:tls`, `Bun.connect`, the `WebSocket` client and `Bun.spawn` are not intercepted. The "Not a sandbox" statement applies.

**Streaming.** (a2) already streams. (c) adds the remaining end-to-end tests through the CLI.

**Tails.** For each finished invocation (section 4, "Invocation end"), call `tail([traceItem])` on each `tails` capability with a documented local subset of `TraceItem` (entrypoint, event, timestamp, outcome, logs, exceptions). Console output is captured per invocation with `AsyncLocalStorage`. A failing tail is logged and never fails the invocation. `streamingTails` requires `allowExperimental` (as workerd) and then fails the first request with "not supported by Lopata".

### Open decisions (c)

- C1. TCP denied in every mode until Lopata has sockets (recommended), documented as a divergence for the gateway case.
- C2. Egress interception covers `fetch()` only (recommended). The documentation states that this is not a security boundary.
- C3. Local `TraceItem` subset; `streamingTails` rejected (recommended).

### Acceptance (c)

- `null`: `fetch()` throws the exact text at top level and in a handler; `connect()` throws.
- A gateway with props receives every `fetch()`, including top-level ones, sees its own `ctx.props`, and its streamed response reaches the dynamic code. Omitted `globalOutbound` reaches a local HTTP fixture.
- A streamed response arrives chunk by chunk; a slow reader holds the producer within the window; cancelling the reader cancels the source; a streamed upload arrives incrementally.
- Each tail receives one item per invocation after `waitUntil` settles. A throwing tail does not fail the invocation.

## 7. PR (d): DO class handles and facets

### Class handles

`getDurableObjectClass(name?, { props?, limits? })` returns a `DynamicDurableObjectClass` holding the stub, the class name and an immutable snapshot of props and limits (section 4). It is serializable under both policies. `ctx.exports.X({ props })` DO classes (`loopback-exports.ts`) are accepted as facet classes too; they run the host worker's module.

### Execution unit: one thread per facet generation

A facet generation runs in its own dynamic thread, spawned by the host DO thread:

- For a `DynamicDurableObjectClass`, the thread imports the stub's materialized modules (shared directory, separate module instance).
- For a DO-class loopback, the thread imports the host worker module, like a DO thread.

Terminating that thread is the revocation mechanism. It stops pending continuations, timers and `waitUntil` work, closes the facet's storage connection, and invalidates every capability the facet exported, because they are served by that thread. A shared thread could not revoke a paused continuation that later writes through a retained `storage.kv` handle. Cost: one thread per running facet. Cloudflare caps a DO at 10 dynamic workers in flight, so the count stays small.

### Facet manager (host DO thread)

```ts
export interface FacetStartupOptions {
	class: DynamicDurableObjectClass | DurableObjectClassLoopback
	id?: DurableObjectIdImpl | string
}

export class FacetManager {
	get(
		name: string,
		getStartupOptions: () => FacetStartupOptions | Promise<FacetStartupOptions>,
	): FacetStub
	abort(name: string, reason: unknown): void
	delete(name: string): void
	clone(): never // "not supported by Lopata"
}
```

- **Names.** A string of at most 256 UTF-8 bytes (`TextEncoder` length); empty is allowed. Depth ≤ 4 including the root.
- **Stubs.** `get()` returns a stub synchronously, without `id` or `name`. A stub binds to the facet's current generation on its first call, as in workerd. A stub created before `abort()` that never called routes to the new generation.
- **Startup.** On a call with no running generation, the manager awaits the callback, validates `{ class, id? }`, spawns the facet thread and sends `facet-start`. Concurrent first calls share one startup. A running facet ignores later callbacks. If the request that started the startup has completed, the startup fails with "The request which initiated this facet startup has already completed." A constructor error fails the startup and the calls waiting on it; the next call runs the callback again (pin against workerd with a fixture).
- **`abort(name, reason)`.** Normalizes `reason` with the shared error serializer, stores it on the generation, increments the generation and terminates the facet thread; Bun ends its descendants with it. Every later call through a stub bound to the old generation rejects with a reconstructed copy of the reason; object identity is not preserved. A facet's own `ctx.abort()` does the same for itself.
- **`delete(name)`.** Aborts with "Facet was deleted.", waits for the facet thread's `close` event, then removes the facet's file and its descendants. A deletion barrier makes later `get()` calls wait. If removal fails, the facet stays in a "deletion failed" state: the next `get()` retries the removal and fails with the cause if it fails again. No new generation starts while an old one can still write.
- **Host lifecycle.** Host `ctx.abort()`, eviction, reload and crash terminate the host thread and with it every facet thread (A1). Facets restart lazily on the next call. Facets have no lifetime of their own (D4).
- **Parent.** A facet requires a SQLite-backed parent, as the documentation states; otherwise `ctx.facets` throws an explicit error.

### Facet execution (facet thread)

`facet-start { generation, className, props, limits, id, storagePath }` constructs:

```ts
const state = new DurableObjectStateImpl(ctxId, storage, hostNamespace, {
	compatibility,
	facet: { alarms: false, props, exports, limits },
})
const instance = new Cls(state, env)
```

- `DurableObjectStateImpl` gets one options object instead of a seventh positional argument.
- `ctxId` is the host id and name by default, the given `DurableObjectId`, or the given string as a plain string (`typeof ctx.id === 'string'`). Storage identity never derives from `ctx.id`.
- `alarms: false`: `storage.setAlarm()` and `txn.setAlarm()` fail with "Facets currently cannot set alarms." when the write commits; `getAlarm()` returns `null`. Pin the timing with a workerd fixture before asserting it.
- Commands target `{ kind: 'facet', key, generation }` and pass through `_enter` / `_exit`, so `blockConcurrencyWhile` works. Limits from the class handle apply per invocation.

### Persistence

One SQLite file per facet holds both its SQL tables and its KV:

| Store  | Host DO (unchanged)                              | Facet `runtime` of host `H` of class `C`       |
| ------ | ------------------------------------------------ | ---------------------------------------------- |
| SQL    | `.lopata/do-sql/C/H.sqlite`                      | `.lopata/do-sql/C/facets/H/<k>.sqlite`         |
| KV     | `do_storage(namespace=C, id=H)` in `data.sqlite` | Internal table `_cf_KV` inside the facet file  |
| Alarms | `do_alarms(namespace=C, id=H)`                   | none                                           |
| Nested | —                                                | `.lopata/do-sql/C/facets/H/<k1>.d/<k2>.sqlite` |

- `k` is the first 32 hex digits of SHA-256 over the UTF-8 facet name. It is path-safe for any valid name.
- **Disjoint identity.** Facet files live under `facets/`, and host ids are hex only since #69, so no host id can alias a facet path. Ids that predate #69 cannot contain `/` either, because `idFromString` never produced them as paths that were reachable through a facet. Nothing in `data.sqlite` refers to facets, so host data and queries are untouched.
- **Atomicity.** `transactionSync` and `transaction()` in a facet cover KV and SQL in one file, as on Cloudflare. The facet never touches `data.sqlite`, so a host `transaction()` holding that file's write lock cannot block a facet write.
- **Internal table.** `_cf_KV` is hidden from `sql.exec`, following workerd's `_cf_` prefix rule; pin the exact error with a fixture.
- **Name metadata.** The facet file stores its name in an internal `_cf_lopata_meta` row, so the dashboard can list facets under their host by scanning `facets/H/` without a schema change in `data.sqlite`.
- **Removal, two operations.**
  - _Reset_ (host `deleteAll()` on a live object): keeps its transaction guard, alarm compatibility selection and scheduler cancellation; aborts running child facets with "Facet was deleted."; then removes `facets/H/`.
  - _Destroy_ (`deleteInstance()` and `facets.delete()`): terminates the owner's threads first, then removes files. `deleteInstance()` removes `facets/H/` with the host's own files; `facets.delete()` removes one facet's file and `.d` subtree.
  - Files are removed with `-wal` and `-shm`. Partial failure follows the deletion-failed state above.
- `renamed_classes` and `deleted_classes` (`src/env.ts`) already move or delete the whole `do-sql/<class>` directory, so facets follow their host class.

### Open decisions (d)

- D1. Facet persistence: one file per facet with KV inside (recommended). Revision 1's composite-id layout in `data.sqlite` is withdrawn: it splits KV and SQL across files, contends with host transactions on `data.sqlite` and aliases ids.
- D2. Host `deleteAll()` deletes facet storage and aborts running facets, as workerd (recommended).
- D3. Facet classes from `getDurableObjectClass` and from DO-class loopbacks; nested facets designed (paths, depth check) and enabled in a follow-up; `clone()` throws.
- D4. Facets share the host executor's lifetime; no independent eviction; no F12 work (recommended).
- D5. One thread per facet generation as the revocation unit (recommended). The alternative, shared threads with per-generation guards at every storage and RPC boundary, cannot stop a paused continuation and is not recommended.

### Acceptance (d)

- `get()` returns synchronously; the callback is not invoked before the first call; sync and async callbacks work; concurrent first calls start one instance; a startup whose request completed fails with workerd's text.
- `typeof ctx.id` is `object` by default and for a `DurableObjectId` override, and `string` for a string override; storage follows the facet name in every case. Names: empty accepted, 256 bytes accepted, 257 bytes (including a multibyte boundary) rejected; depth 5 rejected.
- Isolation: host, facet `a`, facet `b` and facet `a` of another host never see each other's KV or SQL. `transactionSync` in a facet rolls back KV and SQL together. A host awaiting a facet inside `transaction()` does not stall facet writes.
- Data survives `abort`, host reload, host eviction and a process restart.
- Revocation: after `abort()`, a continuation paused in the old generation never writes; a capability the old generation exported rejects; a stub bound to the old generation rejects with the reason; an unbound stub reaches the new generation; a facet's own `ctx.abort()` behaves the same; two facets of one class restart independently.
- `delete()` removes the file with `-wal` / `-shm`; the next `get()` starts empty; an injected removal failure blocks restart until removal succeeds. Host `deleteAll()` and `deleteInstance()` remove every facet. Class rename keeps facet data; class deletion removes it.
- `storage.setAlarm()` and `txn.setAlarm()` in a facet fail with workerd's text at the pinned time. A host alarm set through a capability fires on the host.
- Passing a facet stub over RPC fails with the "not serializable" error; passing a class handle in `env`, `props` and RPC works.

## 8. End-to-end scenario test and SDK gate

A fixture worker under `tests/fixtures/` has a SQLite-backed host DO, `RuntimeHost` and `EgressGateway` entrypoints and a local HTTP target. It runs through the real CLI DO thread and performs every step of section 3: boot with the module map above, facet `fetch` with a streamed response, an RPC call with a callback (including the late-call rejection), facet SQL and KV writes, `env.HOST.setAlarm` firing the host alarm, an outbound `fetch()` observed by the gateway with its props, `abort` with the reason at an old stub, and data intact after `abort`, reload and process restart. The fixture contains no names of real products or consumers.

**SDK gate.** After the primitives pass, run pinned Code Mode and Dynamic Workflows examples. For each, list the routes from the section 3 matrix it uses; support is claimed only for SDKs whose routes are covered.

## 9. PR sequence and territories

| Unit | Deliverable and owned files                                                                                                                                                                                                                                          | Gate                                                                             |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Fix  | [#69](https://github.com/contember/lopata/pull/69): random stub directories, module-name and `mainModule` containment, opaque ids, hex-only DO ids, cleanup of partial materialization, owner-teardown tests, Bun 1.4.4 pinned with probe tests.                     | Review and CI. Independent of this design.                                       |
| (a1) | Runtime init in the dynamic thread: plugin, env and exports publication, execution context, entrypoint construction, eager load, props snapshot. `worker-loader.ts`, `worker-loader-entry.ts`.                                                                       | A2 for props; B4.                                                                |
| (a2) | Generic two-way `RpcClient` / `RpcHostChannel` on the loader port, streaming, close and failed-post semantics, idle eviction, owner-scoped stub directories and their removal by main. `rpc-shared.ts`, `executor.ts`, `do-executor-worker.ts`, `worker-loader*.ts`. | A1, A4, A5.                                                                      |
| (a3) | Codec with envelope and transactional export, both serialization policies, serving-side visibility, invocation scope and disposal. New `capability.ts`; `rpc-stub.ts`; `worker-loader*.ts`.                                                                          | A2, A3; workerd fixtures per policy row.                                         |
| (b)  | Module rules, materialization, bare specifiers, limits. `worker-loader.ts`, `worker-loader-entry.ts`, new `worker-loader-modules.ts`.                                                                                                                                | B1–B4.                                                                           |
| (c)  | Egress, sockets module, tails, console capture, streaming end-to-end tests. `worker-loader-entry.ts`.                                                                                                                                                                | C1–C3.                                                                           |
| (d)  | Class handles, `FacetManager`, facet threads, per-facet storage, reset and destroy paths, dashboard listing. New `facets.ts`; `durable-object.ts`; `worker-loader*.ts`; `do-worker-entry.ts`; `src/api/handlers/do.ts`.                                              | D1–D5; workerd fixtures for alarm timing, constructor failure and `_cf_` access. |

`worker-loader-entry.ts` is shared by (a1)–(d); hand it off sequentially. Only (a2) and (a3) change `rpc-shared.ts`. Order for the scenario: Fix → (a1) → (a2) → (a3) → (b) → (c) egress → (d). Tails and the remaining (b) descriptors can follow (d). Nested facets, `clone()` and codec support on the main ↔ worker channels come after (d).

Each PR runs focused tests, typecheck, lint, dprint and the full suite under `cpu-lease`. This revision changed no source code.

## 10. Human approval checklist

1. Baseline: `main` at `beb5fe0` with #69 and Bun 1.4.4; no F07 slice; reuse `buildLoopbackExports`, `setGlobalEnv`, `setGlobalExports`.
2. Scope statement: Dynamic Workers in Lopata are not a security boundary; egress control covers `fetch()` only; RPC visibility, disposal and facet revocation still follow Cloudflare.
3. A1: the owner thread spawns dynamic threads and Bun 1.4.4 ends them with it (pinned by a test); main removes a terminated owner's directories and reclaims only dead processes' directories at startup.
4. A2: separate env/props and RPC serialization policies; `DataCloneError` with paths; props snapshotted at handle creation.
5. A3: Cloudflare disposal (per-call groups, result disposers, context end, compat-selected parameter ownership); no GC release.
6. A4/A5: in-flight caps documented, not enforced; idle eviction of dynamic threads.
7. Codec: placeholder envelope with aliasing and cycles; transactional export; serving-side visibility.
8. B1/B2: materialization and static-edge validation; computed `import()` limitation documented.
9. B3/B4: `subRequests` enforced, `cpuMs` not; eager load, cached failure, no retry.
10. C1–C3: TCP denied (documented divergence for gateways); outbound inheritance; local `TraceItem` subset.
11. D1/D5: one SQLite file per facet with internal KV; one thread per facet generation.
12. D2–D4: host `deleteAll()` cascades and aborts; facet classes from the loader and DO-class loopbacks; nested facets later; facet lifetime equals host lifetime.
13. Order: Fix → (a1) → (a2) → (a3) → (b) → (c) → (d).

## Revision notes

Round 1 review: [combined comment](https://github.com/contember/lopata/pull/50#issuecomment-6581801044).

| Finding                                                                                                                                                                                                                                                             | Where it is answered                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Stub ownership inverts Cloudflare's (critical)                                                                                                                                                                                                                      | Section 2 RPC lifecycle and parameter ownership rows; section 4 (a3) disposal model and acceptance.        |
| Stale baseline                                                                                                                                                                                                                                                      | Header, section 1, section 9; F07 slice dropped.                                                           |
| Env policy too loose / wrong serializer                                                                                                                                                                                                                             | Section 2 `env` row; section 4 serialization policies.                                                     |
| Facet lifecycle and storage                                                                                                                                                                                                                                         | Section 7: execution unit, manager, persistence, reset vs destroy, acceptance.                             |
| Path safety in the loader                                                                                                                                                                                                                                           | PR #69.                                                                                                    |
| RPC visibility at the serving boundary                                                                                                                                                                                                                              | Section 4 (a3) visibility.                                                                                 |
| Codec envelope, cycles, rollback                                                                                                                                                                                                                                    | Section 4 (a3) envelope and transactional export.                                                          |
| Multi-hop capability transparency                                                                                                                                                                                                                                   | Section 3 route matrix; (a3) acceptance; section 8 SDK gate.                                               |
| Boot/disposal races, unbounded live workers                                                                                                                                                                                                                         | Decision 1 (Bun 1.4.4 ends nested workers with the owner); section 4 (a2) ownership, idle eviction, A4/A5. |
| Entrypoint props captured at handle creation                                                                                                                                                                                                                        | Section 4 (a1), `LoaderTarget` handle.                                                                     |
| Module map closure and namespace collisions                                                                                                                                                                                                                         | Section 5 validation, materialization, B2.                                                                 |
| Invocation end conditions, error semantics                                                                                                                                                                                                                          | Section 4 (a2) errors, (a3) invocation end.                                                                |
| Eager load and no retry                                                                                                                                                                                                                                             | Section 2 `get` row; B4.                                                                                   |
| Bun not pinned                                                                                                                                                                                                                                                      | PR #69; section 1 Bun table.                                                                               |
| Outbound inheritance; compiled Wasm                                                                                                                                                                                                                                 | Section 6 egress; section 5 materialization (Bun 1.4.4 clones a `WebAssembly.Module`).                     |
| Facet id/name rules, alarm timing, startup error text                                                                                                                                                                                                               | Sections 2 and 7.                                                                                          |
| Minor: error texts, `allowExperimental`, `connect()` gateway, `ctx.exports` date gate, `get(123)`, subrequest text, in-flight caps, env size timing, entrypoint errors, `RpcClient` close, state options object, `clone()`, workerd Rust move, SQLite-backed parent | Sections 1, 2, 4, 5, 6 and 7 at the respective rows.                                                       |

## Sources

- workerd `main` (November 1, 2026): `src/workerd/api/worker-loader.h` / `.c++`, `src/workerd/api/worker-rpc.c++`, `src/workerd/io/frankenvalue.c++`, `src/workerd/io/compatibility-date.capnp` (`rpcParamsDupStubs`, `enable_ctx_exports`), `src/workerd/api/actor-state.h` / `.c++`, `src/workerd/io/actor-sqlite.c++`, `src/workerd/server/server/loader.rs`, `src/workerd/server/server/actor.rs`, `src/workerd/server/factory/worker-factory-actor.c++`, tests `worker-loader-test.js` and `js-rpc-params-ownership-test.js`.
- Cloudflare documentation, retrieved November 2, 2026: [Dynamic Workers API reference](https://developers.cloudflare.com/dynamic-workers/api-reference/), [bindings](https://developers.cloudflare.com/dynamic-workers/usage/bindings/), [egress control](https://developers.cloudflare.com/dynamic-workers/usage/egress-control/), [limits](https://developers.cloudflare.com/dynamic-workers/usage/limits/), [platform limits](https://developers.cloudflare.com/dynamic-workers/platform/limits/), [Durable Object facets](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/), [RPC lifecycle](https://developers.cloudflare.com/workers/runtime-apis/rpc/lifecycle/), [RPC visibility](https://developers.cloudflare.com/workers/runtime-apis/rpc/visibility/), [RPC error handling](https://developers.cloudflare.com/workers/runtime-apis/rpc/error-handling/).

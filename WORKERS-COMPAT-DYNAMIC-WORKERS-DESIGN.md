# Dynamic Workers, RPC ownership and facets design

October 12, 2026. **Proposal for approval, not an implementation or compatibility claim.** Scope: F16 from [the backlog](https://github.com/contember/lopata/blob/d1b88a1/WORKERS-COMPAT-BACKLOG.md#f16--dynamic-workers-rpc-ownership-and-facets). It follows the structure of the [runtime design](https://github.com/contember/lopata/blob/d1b88a1/WORKERS-COMPAT-RUNTIME-DESIGN.md). No source changes were made for this note.

**Baseline.** Code references point to `origin/main` at `99ae836`. The backlog and the earlier design notes live only on the closed stacked branches. [PR #49](https://github.com/contember/lopata/pull/49) replaces that stack with simpler local behavior: compatibility selection, `ctx.exports` loopbacks in `WorkerDispatcher`, `ctx.abort()`, and tracing that ends when its callback settles. This design assumes PR #49 merges first. Where #49 changes an F16-owned file, the note says so. PR #49 states its direction: keep the Cloudflare APIs, and do not simulate production guarantees that local development does not need. This design follows that direction. It proposes the smallest mechanism that makes each documented contract observable. Hosted-only guarantees are named as accepted limits.

**Not a sandbox.** Dynamic Workers run in Bun worker threads in the Lopata process. They can use `node:fs`, `node:net`, `Bun.spawn` and every other host API. `globalOutbound` controls `fetch()`. It does not isolate the host. A platform that hosts untrusted agent code must not rely on Lopata for containment. This statement must ship in the documentation with the feature.

## Recommended decisions

1. Keep one transport. Move the loader channel onto the existing `RpcClient` / `RpcHostChannel` machinery (`src/worker-thread/rpc-shared.ts`). It already streams request and response bodies with backpressure and cancellation. Make it generic over its target type. Run one instance in each direction over a single `MessagePort`.
2. Pass capabilities by reference. A small codec replaces functions, `RpcTarget`s and branded binding proxies with numeric tokens. The owning side keeps an export table. The other side receives proxies. Everything else uses structured clone, so `Map`, `ArrayBuffer` and `Date` survive. A value that is neither cloneable nor a capability throws a `TypeError` that names its path. The JSON round-trip that silently drops values is removed.
3. Ownership is explicit and channel-scoped. `[Symbol.dispose]`, `using` and `dup()` count references. Closing the channel releases every export and rejects pending calls. No `FinalizationRegistry` and no automatic disposal of call parameters.
4. Main owns every dynamic worker thread. The calling thread asks main to spawn the thread. Main transfers a `MessagePort` pair, so traffic stays direct. Main terminates dynamic threads together with their owner. A Bun 1.3.14 probe shows that terminating a parent worker does **not** terminate its nested workers.
5. Materialize modules as JavaScript files in a random per-stub directory. Validate module names. Force the JS loader with a runtime `onLoad` plugin. Resolve bare specifiers relative to the importer through generated `node_modules` symlinks. Validate statically known imports at load time.
6. Facet storage reuses the existing DO stores with a composite storage identity: `<hostId>/facets/<key>`. No schema change. Rename and delete-class migrations keep working. Facets cannot set alarms, which matches workerd.
7. Accept `limits`. Enforce `subRequests` per invocation. Do not enforce `cpuMs`: Bun has no per-thread CPU clock. Enforce workerd's 1 MiB env and 64 MiB code limits.
8. Intercept `fetch()` only. Deny TCP `connect()` in every mode, because Lopata has no socket implementation.

Sections 4–7 list the open decisions for each PR. Section 10 collects them.

## 1. Evidence from current code

### Loader binding and entry

| Location                                | Current behavior                                                                                                                                   | Consequence                                                                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `src/bindings/stateless-env.ts:183–190` | Each env builder (main, user-worker thread, DO thread) creates its own `WorkerLoaderBinding`. Not instrumented.                                    | A host DO's `env.LOADER` runs in that DO's thread. The `get()` cache is per thread.                                                 |
| `worker-loader.ts:20–26`                | `WorkerCodeModule` has `string`, `js`, `cjs`, `text`, `data`, `json`. No `wasm`.                                                                   | `{ wasm }` and plain `WebAssembly.Module` values are rejected.                                                                      |
| `worker-loader.ts:34–37`                | `globalOutbound?: unknown \| null`. `tails` and `limits` are typed but never read.                                                                 | A Fetcher in `globalOutbound` acts as "allow". Tails and limits are silently ignored.                                               |
| `worker-loader.ts:64`                   | `workDir = join(baseDir, id)`.                                                                                                                     | Two threads that call `get('same-id')` write to the same directory concurrently. An id with `../` escapes `.lopata/worker-loader/`. |
| `worker-loader.ts:78–82`                | `_ready` caches the first boot promise, including a rejection.                                                                                     | One failed code callback breaks the stub permanently.                                                                               |
| `worker-loader.ts:102–107`              | Init message carries `sanitizeEnv(code.env)` and `'allow' \| 'block'`.                                                                             | No capability crosses the thread boundary.                                                                                          |
| `worker-loader.ts:166–182`              | `_fetch` reads the request with `arrayBuffer()`. The entry reads the response with `arrayBuffer()` (`worker-loader-entry.ts:117`).                 | No streaming in either direction. Server-sent events never reach the client until the stream ends.                                  |
| `worker-loader.ts:218–238`              | `getEntrypoint(name?)` takes no options. No `getDurableObjectClass`.                                                                               | No props, no per-entrypoint limits, no DO class handles.                                                                            |
| `worker-loader.ts:249–264`              | `load()` validates and creates an uncached stub. `get(id: string, cb)` caches by id.                                                               | `get(null, cb)` is not supported.                                                                                                   |
| `worker-loader.ts:266–269`              | `disposeAll()` exists. No runtime path calls it.                                                                                                   | Stub directories and threads live until process exit.                                                                               |
| `worker-loader.ts:279–287`              | `sanitizeEnv` does `JSON.parse(JSON.stringify(env))` and returns `{}` on failure.                                                                  | Functions and stubs vanish. `Map` becomes `{}`. One bad value empties the whole env. The backlog forbids this pattern.              |
| `worker-loader.ts:289–308`              | `join(workDir, name)` with no validation.                                                                                                          | A module name such as `../../x.js` writes outside the stub directory.                                                               |
| `worker-loader.ts:312–325`              | Strings are accepted for any name. Data modules are written as raw bytes.                                                                          | workerd rejects string modules whose name does not end in `.js` or `.py`. An imported data module is not an `ArrayBuffer`.          |
| `worker-loader-entry.ts:15`             | The entry does not import `../plugin`. `do-worker-entry.ts:58` does.                                                                               | Probe: `import ... from 'cloudflare:workers'` fails inside a dynamic worker.                                                        |
| `worker-loader-entry.ts:70–81`          | `block` replaces `globalThis.fetch` with a thrower. Anything else keeps the native fetch.                                                          | `globalOutbound: ctx.exports.Gateway` is never called.                                                                              |
| `worker-loader-entry.ts:83–102`         | A named class export is constructed with `{ waitUntil() {}, passThroughOnException() {} }`. A throwing constructor falls back to the class itself. | No `ctx.props`, no `ctx.exports`. Constructor errors are hidden.                                                                    |
| `worker-loader-entry.ts:115, 130`       | `waitUntil` is a no-op.                                                                                                                            | Background work is not awaited and its errors are lost.                                                                             |
| `worker-loader-entry.ts:134–139`        | RPC results go through `postMessage`.                                                                                                              | A returned `RpcTarget` or function fails with `DataCloneError`.                                                                     |

PR #49 adds `validateCode(): CompatibilitySelection` and passes the selection to the entry (`worker-loader.ts` +7 lines, `worker-loader-entry.ts` +7 lines). The lines above shift by about three in that branch.

### RPC and transport

| Location                       | Available                                                                                                     | Missing for F16                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rpc-stub.ts:60–103`           | `makeBindingProxy`: `fetch`, method calls, thenable property reads, cached per-prop callables.                | No brand that identifies the proxy as a capability. Dispose is a no-op (`:74`).                                                                                  |
| `rpc-stub.ts:116–254, 329–343` | In-process `RpcTarget` / function stubs with `dup()`, `_`-prefixed filtering and return wrapping.             | Dispose is a no-op. No cross-thread form.                                                                                                                        |
| `rpc-shared.ts:46–76`          | `registerCloneable` / `tagCloneable` / `reifyArgs` revive class identity across `postMessage`.                | Data-only. Revival applies only to arguments on the host side.                                                                                                   |
| `rpc-shared.ts:91–207`         | `dispatchRpcCall`, `dispatchRpcGet`, `dispatchRpcFetch` with streamed bodies, early headers and cancellation. | Targets are `BindingTarget { binding, instanceId? }` (`protocol.ts:207–222`). Results must be cloneable; `:113–115` documents this as a cross-thread limitation. |
| `rpc-shared.ts:242–502`        | `RpcHostChannel` (serving side) and `RpcClient` (calling side) with one shared backpressure window.           | Each channel is one-directional: worker calls main. The loader needs both directions on one port.                                                                |

### Context, exports and props

- `src/execution-context.ts:23–45` and `src/worker-thread/execution-context.ts:75–98` carry `props` and `waitUntil`. Neither has `exports` on `main`.
- PR #49 adds `exports` to both classes. `WorkerDispatcher.loopbacks()` (`src/bindings/worker-dispatcher.ts` in #49) builds `ctx.exports.<WorkerEntrypoint>(opts?)` loopbacks with props. Only the dispatcher paths use it: Vite, testing and in-process services. CLI worker threads and DO threads keep `exports = {}`.
- `DurableObjectStateImpl` (`durable-object.ts:618–648`) has no `exports`, `props` or `facets`.

### Durable Object storage and lifecycle

| Location                             | Behavior                                                                                                                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `durable-object.ts:288–361`          | Sync and async KV use the `do_storage (namespace, id, key, value)` table in the shared `.lopata/data.sqlite`.                                                                    |
| `durable-object.ts:107–136, 385–394` | SQL storage is a separate file: `.lopata/do-sql/<namespace>/<id>.sqlite`, WAL, `busy_timeout=5000`. The file is opened lazily.                                                   |
| `durable-object.ts:557–578`          | Alarms are rows in `do_alarms (namespace, id)`.                                                                                                                                  |
| `durable-object.ts:467–471`          | `deleteAll()` deletes KV rows only (#49 also deletes the alarm). The SQL file is untouched.                                                                                      |
| `durable-object.ts:1328–1367`        | `deleteInstance()` removes rows, the alarm and the SQL file with `-wal` / `-shm`.                                                                                                |
| `src/env.ts:140–166`                 | `renamed_classes` updates rows by namespace and renames `do-sql/<from>`. `deleted_classes` removes rows and `do-sql/<class>`.                                                    |
| `do-worker-entry.ts:56–113`          | Each DO instance runs in its own Bun worker. It builds env through `buildWorkerEnv` (`do-worker-env.ts:202` adds the loader), imports the user module, and constructs the class. |
| `do-executor-worker.ts:544–576`      | Dispose sends `cleanup` only for container DOs, then calls `terminate()`.                                                                                                        |

### Egress and sockets

- `src/plugin.ts:166–257` wraps `globalThis.fetch` with tracing in host threads.
- No `cloudflare:sockets` module exists (`src/virtual-modules.ts:18–50` registers the others). Service-binding `connect()` throws "not supported in local dev mode" (`service-binding.ts:35–37, 196`).
- Lopata has no Tail Worker support.

### Probes (Bun 1.3.14, scratch directory, no repository changes)

| Probe                                                                                                                   | Result                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Nested `Worker` imports `cloudflare:workers` after the parent ran `src/plugin.ts`                                       | Fails: "Cannot find package 'cloudflare:workers'". Runtime plugins are per thread.                                       |
| `import x from 'some-bare-name'` with the file on disk next to the importer                                             | Fails: "Cannot find package".                                                                                            |
| `Bun.plugin` `onResolve` for a bare specifier, both a catch-all and an exact filter, in the main thread and in a worker | Not invoked for bare specifiers. Invoked for relative ones.                                                              |
| `<dir>/node_modules/<name>` symlink to the extensionless module file                                                    | Resolves. Bun loads the extensionless file as JS. `'./some-bare-name'` and `'some-bare-name'` yield one module instance. |
| Runtime `onLoad` filtered on the stub directory                                                                         | Invoked for files with an extension (it can force `loader: 'js'`). Not invoked for extensionless files.                  |
| Parent worker terminated while its nested worker runs a timer                                                           | The nested worker keeps running.                                                                                         |
| `MessageChannel` port transferred from main to two workers                                                              | Direct messaging works. `Map` and `ArrayBuffer` survive.                                                                 |

Re-run these probes on the Bun versions that CI pins before implementation. A different result changes the module design in section 5, not its contract.

## 2. Target contract

Pinned to [workerd `fe4ed9a`](https://github.com/cloudflare/workerd/tree/fe4ed9aeb1ce9ace2c789d71a19727c692746033) and the Cloudflare documentation retrieved on October 12, 2026.

| Surface                                                        | Contract                                                                                                                                                                                                                                                                                                                                         | Source                                                                                                                                         |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOADER.get(name: string \| null, getCode)`                    | Returns a `WorkerStub` synchronously. `getCode` may be async and runs lazily. It may run more than once. The same name must return identical code. Requests wait for the load. A load failure fails the request.                                                                                                                                 | `worker-loader.h` `WorkerLoader::get`; [API reference](https://developers.cloudflare.com/dynamic-workers/api-reference/)                       |
| `LOADER.load(code)`                                            | Shortcut for `get(null, () => code)`. Validates synchronously. Never cached.                                                                                                                                                                                                                                                                     | `worker-loader.c++` `WorkerLoader::load`                                                                                                       |
| `WorkerCode`                                                   | `compatibilityDate`, `compatibilityFlags?`, `allowExperimental?`, `limits?`, `mainModule`, `modules`, `env?` ("any RPC-serializable value"), `globalOutbound?: Fetcher \| null`, `tails?: Fetcher[]`, `streamingTails?: Fetcher[]`.                                                                                                              | `worker-loader.h` `WorkerCode`                                                                                                                 |
| Modules                                                        | A string is valid only for names ending in `.js` (ES module) or `.py`. A plain `WebAssembly.Module` is a Wasm module. An object must have exactly one of `js`, `cjs`, `text`, `data`, `json`, `py`, `wasm`. `wasm` accepts `ArrayBuffer`, an `ArrayBufferView` or a `WebAssembly.Module`. Python modules are invalid when the main module is JS. | `worker-loader.h` `Module`; `worker-loader.c++` `extractSource`                                                                                |
| Size limits                                                    | Code ≤ 64 MiB in total. Env ≤ 1 MiB (estimate).                                                                                                                                                                                                                                                                                                  | `worker-loader.c++:18–22`                                                                                                                      |
| `WorkerStub.getEntrypoint(name?, { props?, limits? })`         | Returns a `Fetcher`. Props reach the entrypoint as `ctx.props`.                                                                                                                                                                                                                                                                                  | `worker-loader.h` `EntrypointOptions`                                                                                                          |
| `WorkerStub.getDurableObjectClass(name?, { props?, limits? })` | Returns a `DurableObjectClass` handle.                                                                                                                                                                                                                                                                                                           | `worker-loader.h`                                                                                                                              |
| `limits: { cpuMs?, subRequests? }`                             | Allowed in `WorkerCode` and in the entrypoint options. The lower value applies. Exceeding a limit throws immediately.                                                                                                                                                                                                                            | `io-channels.h:546–555`; [limits](https://developers.cloudflare.com/dynamic-workers/usage/limits/)                                             |
| Bindings                                                       | `env` carries data and service stubs, including `ctx.exports` loopbacks with props. Props stay with the loader. The dynamic worker sees only methods. Each call is an RPC into the loader.                                                                                                                                                       | [bindings](https://developers.cloudflare.com/dynamic-workers/usage/bindings/)                                                                  |
| `globalOutbound`                                               | Omitted: inherit the parent's outbound. `null`: `fetch()` and `connect()` throw. A Fetcher receives every outbound request through its `fetch` handler, with the original URL.                                                                                                                                                                   | `worker-loader.c++:185–202`; [egress](https://developers.cloudflare.com/dynamic-workers/usage/egress-control/)                                 |
| `ctx.facets.get(name, getStartupOptions)`                      | Returns a `Fetcher` synchronously, without `id` or `name`. The callback may be async. It runs only when the facet is not running. It returns `{ class, id? }`. `class` is a `DurableObjectClass` or a DO loopback namespace from `ctx.exports`. Without `id`, the facet inherits the parent's id.                                                | `actor-state.h:451–516`; `actor-state.c++:1073–1146`; [facets](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/) |
| `ctx.facets.abort(name, reason)`                               | Stops the facet and invalidates its stubs; later calls throw `reason`. Storage is kept. A later `get()` may use a different class.                                                                                                                                                                                                               | same                                                                                                                                           |
| `ctx.facets.delete(name)`                                      | Aborts the facet with "Facet was deleted." and deletes its database and every descendant database.                                                                                                                                                                                                                                               | `server.c++:767–786, 945–966`                                                                                                                  |
| Facet storage                                                  | One SQLite database per facet, isolated from the parent. The parent's `deleteAll()` deletes every descendant facet's storage.                                                                                                                                                                                                                    | `server.c++:934–966, 1296–1307`                                                                                                                |
| Facet limits                                                   | Name ≤ 256 characters. Tree depth ≤ 4 including the root. Facet stubs are not serializable. Facets cannot set alarms: "Facets currently cannot set alarms."                                                                                                                                                                                      | `actor-state.c++:1000–1011, 1080–1082`; `server.c++:820, 1800–1811`                                                                            |

Two observations from a consuming application are recorded as target behavior. Module specifiers, including bare ones, resolve relative to the importing module's directory. A module name without `.js` needs an explicit type such as `{ js }`. The second observation matches the workerd source above. The first one should be pinned with a workerd fixture during PR (b).

`ctx.facets.clone()` exists in workerd but is not documented. It is out of scope. Python modules remain F20 scope; they fail with an explicit error.

## 3. Consumer scenario

A platform that hosts untrusted agent code runs this flow in a SQLite-backed host Durable Object:

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

| #  | Step                                                                                  | Today on `main`                                                                                                      | Lands in                                                                                                                            |
| -- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1  | `env.LOADER.get()` from a DO thread                                                   | Works. The nested thread outlives DO eviction and reload.                                                            | (a) thread ownership                                                                                                                |
| 2  | `compatibilityFlags: ['nodejs_compat']`                                               | Date is required. #49 resolves the selection. `nodejs_compat` stays uninterpreted; Bun Node APIs are always present. | (b), consumes #49                                                                                                                   |
| 3  | `'main.js'` and `'sdk/chunk-x.js'` strings, relative imports                          | Works.                                                                                                               | —                                                                                                                                   |
| 4  | `'some-bare-name': { js }` imported as a bare specifier                               | Fails: "Cannot find package".                                                                                        | (b)                                                                                                                                 |
| 5  | Loaded code imports `DurableObject` from `cloudflare:workers`                         | Fails: virtual modules are not registered in the loader thread.                                                      | (b), first commit                                                                                                                   |
| 6  | `env.HOST = ctx.exports.RuntimeHost({ props })`                                       | DO state has no `ctx.exports`. If it had, `sanitizeEnv` would drop the value.                                        | F07 slice + (a)                                                                                                                     |
| 7  | `globalOutbound = ctx.exports.EgressGateway({ props })`                               | Treated as "allow". The gateway is never called.                                                                     | F07 slice + (a) + (c)                                                                                                               |
| 8  | `worker.getDurableObjectClass('Runtime')` and `ctx.facets.get()`                      | Neither exists.                                                                                                      | (d)                                                                                                                                 |
| 9  | `facet.fetch(request)` and RPC methods, including callback arguments                  | —                                                                                                                    | (d), on the (a) channel                                                                                                             |
| 10 | Facet `ctx.storage.sql` and `ctx.storage.kv`                                          | —                                                                                                                    | (d) persistence                                                                                                                     |
| 11 | Facet calls `env.HOST.setAlarm(t)`                                                    | —                                                                                                                    | (a). `RuntimeHost` runs in the host DO thread and reaches the host DO through its own env. Facet `ctx.storage.setAlarm` throws (d). |
| 12 | Host `alarm()` later uses the facet                                                   | —                                                                                                                    | (d): `get()` restarts the facet lazily                                                                                              |
| 13 | Every `fetch()` from loaded code reaches `EgressGateway`                              | Bypassed.                                                                                                            | (c)                                                                                                                                 |
| 14 | `ctx.facets.abort('runtime', reason)`; storage intact after abort, reload and restart | —                                                                                                                    | (d)                                                                                                                                 |

Step 11 is a reentrant call. `RuntimeHost` calls the host DO through main while the host may still await the facet. Lopata's DO input handling (`_enter`, `durable-object.ts:667–677`) only waits for `blockConcurrencyWhile`. The call therefore completes unless the host awaits the facet inside `blockConcurrencyWhile`. That case deadlocks in Lopata. Document it.

**Earliest working order:** #49 → F07 slice (`ctx.exports` WorkerEntrypoint loopbacks in DO and worker-thread contexts) → (a) → (b) minimum (runtime globals, module materialization, context) → (c) egress → (d). After these, the scenario runs end to end through real CLI threads. Streaming acceptance, tails, Wasm/CJS coverage and limits can follow without blocking it. (c) egress and (d) both edit `worker-loader-entry.ts`, so they hand off sequentially. Egress goes first because it is small.

## 4. PR (a): capability transport, RPC ownership and disposal

### Proposed design

**Thread ownership.** Add one internal request from any runtime thread to main: `loader-spawn { stubKey }`. Main creates the dynamic `Worker` and a `MessageChannel`. It transfers `port1` to the requesting thread and `port2` to the dynamic thread. Main records the dynamic thread under the requesting executor. `WorkerThreadExecutor` teardown and `WorkerExecutor._teardown` (`do-executor-worker.ts:559`) terminate the recorded threads. When the loader runs on main (Vite, `createTestEnv`, in-process DOs), it spawns directly and the binding owner disposes it. The alternative is a heartbeat: the child terminates itself when its parent stops answering. It needs no main involvement. It leaves an orphan running for one interval and two writers on facet storage during that interval. Recommend main ownership.

**Channel.** Make `RpcClient` and `RpcHostChannel` generic over their target type. Existing channels keep `BindingTarget`. The loader port carries both instances in each direction, so either side can call the other:

```ts
// src/worker-thread/rpc-shared.ts
export class RpcClient<Target = BindingTarget> {/* unchanged behavior */}
export class RpcHostChannel<Target = BindingTarget> {/* unchanged behavior */}

// src/bindings/worker-loader-protocol.ts (new)
export type LoaderTarget =
	| {
		kind: 'entrypoint'
		name: string | null
		props: unknown
		limits: ResourceLimits | null
	}
	| { kind: 'capability'; id: number }
	| { kind: 'facet'; key: string; generation: number } // PR (d)
```

The codec runs where arguments and results cross the port: the existing `reifyArgs` seam and the result post. Add two optional hooks to `RpcDispatchHooks`: `decodeArgs(args)` and `encodeResult(value)`. The client side gets the matching `encodeArgs` / `decodeResult`.

**Codec.**

```ts
// src/worker-thread/capability.ts (new)
export const CAPABILITY_BRAND = Symbol.for('lopata.Capability')
export interface CapabilityToken {
	readonly __lopata_cap: number
	readonly kind: 'object' | 'function'
}

export class CapabilityTable {
	export(value: object): CapabilityToken // refcount +1
	resolve(id: number): object // throws a disposed or aborted error
	release(id: number): void // refcount −1; drop at zero
	closeAll(reason: Error): void
}

export function encodeForPeer(
	value: unknown,
	table: CapabilityTable,
	path: string,
): unknown
export function decodeFromPeer(value: unknown, peer: CapabilityPeer): unknown
```

- `encodeForPeer` walks arrays, plain objects, `Map` and `Set` values. It exports functions, `RpcTarget`-branded objects and objects that answer `true` for `CAPABILITY_BRAND`. `makeBindingProxy`, service-binding proxies, DO stubs and loader entrypoint stubs gain that brand. Other values stay as they are for structured clone. A value that fails `structuredClone` throws `TypeError: Cannot serialize value at env.HOST.x: <reason>`.
- `decodeFromPeer` turns tokens into proxies. Object tokens use `makeBindingProxy` with `call`, `getProperty` and `fetch` bound to `{ kind: 'capability', id }`. Function tokens become callable stubs.
- Facet stubs refuse export: "Stubs pointing to Durable Object facets are not serializable."
- `env` is encoded once per boot, and the 1 MiB estimate is checked on the encoded form (PR (b) enforces it).

**Ownership.**

| Event                                                     | Effect                                                                                                                                                          |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Value exported (env, argument or result)                  | Exporter refcount +1. The importer holds one reference.                                                                                                         |
| `stub.dup()`                                              | Importer asks the exporter for +1 and receives a new proxy.                                                                                                     |
| `stub[Symbol.dispose]()`, `using` exit                    | Importer posts `cap-release`. Later calls on that proxy reject with "RPC stub was disposed". Other duplicates keep working.                                     |
| Exporter drops the last reference                         | The table entry is removed. An `RpcTarget` with its own `[Symbol.dispose]` is called once.                                                                      |
| Channel close (owner disposal, thread crash, termination) | Both sides call `closeAll(reason)`. Pending calls reject with `reason`.                                                                                         |
| Call parameter that holds a capability                    | Kept until disposed or until the channel closes. Cloudflare disposes parameters when the call returns unless they are duplicated. Lopata does not emulate this. |

`env` capabilities are held by the dynamic worker for its lifetime. They are released when the channel closes.

**Entrypoint dispatch.** The dynamic side serves `{ kind: 'entrypoint' }` targets. It uses `resolveEntrypointHandler` / `constructEntrypoint` (`src/entrypoint-handler.ts`) with a context that carries `props` and a tracked `waitUntil`. A throwing constructor fails the call. The current fallback to the class itself (`worker-loader-entry.ts:93–95`) is removed. Main-thread `WorkerStub` methods (`_fetch`, `_rpcCall`, `_scheduled`) become thin calls on the client. `LoaderCommand` and `LoaderResult` are deleted.

**Scope boundary.** The codec lives in the shared transport so that service-binding and DO channels can adopt it later. This PR wires only the loader channel. Returned capabilities on the main ↔ worker channels remain the existing documented limitation.

### Open decisions (a)

- A1. Main-owned dynamic threads with transferred ports (recommended) or a child heartbeat.
- A2. Strict env policy: data plus branded capabilities, otherwise `TypeError` (recommended). The alternative wraps any non-cloneable object as a generic capability. It is more permissive than Cloudflare, which requires resources such as KV to be wrapped in an entrypoint.
- A3. Explicit and channel-scoped disposal, no garbage-collection release, no automatic parameter disposal (recommended). This accepts unbounded growth within one dynamic worker's lifetime when code never disposes.

### Acceptance (a)

- `Map`, `Set`, `ArrayBuffer`, typed arrays, `Date` and nested data round-trip through `env`, arguments and results.
- From the dynamic worker: call a `ctx.exports` loopback with props, a service binding, a DO stub and an `RpcTarget`. Two loopbacks of one class with different props in one env stay isolated.
- A host method returns an `RpcTarget` and a function. Both are callable from the dynamic worker. A dynamic-worker callback passed as an argument is invoked by the host after the call returns.
- After `dispose()` a call rejects. A `dup()` survives disposal of the original. `using` releases. The exporter's table returns to zero entries.
- Closing the channel rejects pending calls in both directions and empties both tables.
- A non-cloneable, non-capability env value fails `get()`'s first request with a `TypeError` that names the path. No empty env.
- DO idle eviction, `ctx.abort()` and hot reload terminate the dynamic thread. A timer in the dynamic thread stops writing a file after teardown. This is the probe from section 1, as a regression test.

## 5. PR (b): identity, props, context, modules, compatibility and limits

### Proposed design

**Identity.**

- `get(name: string | null, cb)`. `null` creates an uncached stub each call. A string caches per binding instance, as today. Any other type throws `TypeError`.
- `load(code)` validates synchronously and calls the same constructor as `get(null, () => code)`.
- A failed code callback or boot clears `_ready`. The next request runs the callback again and the failed request rejects.
- Each stub gets a random directory: `.lopata/worker-loader/<uuid>/`. The id never becomes a path. Directories are removed on stub disposal and on owner teardown. Startup removes leftover directories from crashed runs.

**Module validation.** Each module name must be non-empty, relative, without `.` or `..` segments, without empty segments and without a backslash. A string body requires a `.js` name. `.py` names and `{ py }` fail with "Python Dynamic Workers are not supported by Lopata". An object descriptor must have exactly one known key. The workerd error texts from section 2 are reused. Total code size is checked against 64 MiB.

**Module materialization.** Every module file on disk is JavaScript:

| Descriptor                         | File content at `<name>`                                                                                                                                                                                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `js`                               | The source.                                                                                                                                                                                                                                                           |
| `cjs`                              | The source. Bun's JS loader detects CommonJS. Probe `require()` between descriptor modules before relying on it.                                                                                                                                                      |
| `text`                             | `export default <JSON string>`                                                                                                                                                                                                                                        |
| `json`                             | `export default <JSON value>`                                                                                                                                                                                                                                         |
| `data`                             | Bytes go to a sidecar file in `.lopata-bytes/`. The wrapper is `export default await Bun.file(<sidecar>).arrayBuffer()`.                                                                                                                                              |
| `wasm`, plain `WebAssembly.Module` | Bytes go to a sidecar. The wrapper is `export default new WebAssembly.Module(await Bun.file(<sidecar>).arrayBuffer())`. A `WebAssembly.Module` value is accepted only if Bun can structured-clone it to the spawning side; otherwise it fails with an explicit error. |

- A runtime plugin in the dynamic thread registers `onLoad` for the stub directory and returns `loader: 'js'`. A JS module named `code.txt` and a text module named `notes.md` both load as JS. Extensionless files already load as JS.
- **Bare specifiers.** At write time, `Bun.Transpiler#scanImports` lists static imports, re-exports, literal dynamic imports and `require()` calls. For each specifier that is not relative, absolute or a runtime scheme (`cloudflare:`, `node:`, Node built-in names), the target is `join(dirname(importer), specifier)`. If that module exists in the map, create `<dirname(importer)>/node_modules/<specifier>` as a symlink to it. If not, fail the load: `No such module "<specifier>" imported from "<importer>"`.
- Dynamic `import()` with a computed specifier falls back to Bun resolution. Bun can then find host packages through the project's `node_modules`. This is a documented limitation.

**Runtime globals.** The dynamic thread imports `../plugin` before user code, as `do-worker-entry.ts:58` does. `cloudflare:workers`, `caches`, `HTMLRewriter` and `WebSocketPair` then exist.

**Context.** The dynamic context exposes `props`, a tracked `waitUntil`, `passThroughOnException` and `exports`: loopbacks for the dynamic worker's own `WorkerEntrypoint` exports, reusing #49's `WorkerDispatcher.loopbacks()`. `tracing` uses #49's API. Spans from a dynamic thread are not persisted until a trace transport is wired; this is a documented limit. `getEntrypoint(name, { props, limits })` forwards props and limits in the `entrypoint` target. Props never cross in the other direction: the host's loopback props stay in the host's export table.

**Compatibility.** Consume #49's `resolveCompatibility` result per dynamic worker. A dynamic worker uses its own selection even when the parent's differs. `allowExperimental` is accepted and ignored. `nodejs_compat` stays uninterpreted, as in F09.

**Limits.** Validate `{ cpuMs?, subRequests? }` as non-negative integers. The effective value is the per-field minimum of the `WorkerCode` and entrypoint values. `subRequests` counts outbound `fetch()` and capability calls per invocation. Exceeding it throws `Error('Too many subrequests.')` before the call. `cpuMs` is accepted and not enforced, with a one-time warning. Bun's `process.cpuUsage()` is process-wide, so any per-thread number would be invented.

### Open decisions (b)

- B1. Module materialization: JS wrappers, `onLoad`, `node_modules` symlinks and load-time import validation (recommended). It rests on Bun behavior verified only on 1.3.14. The alternative rewrites import specifiers in the source text. That needs a lexer dependency.
- B2. Unresolved computed `import()` falls back to Bun resolution (recommended, documented). The alternative places stub directories outside the project, which exposes Bun's auto-install.
- B3. Enforce `subRequests`; accept but do not enforce `cpuMs` (recommended). The alternative ignores both, which leaves "entrypoint limits take the minimum" untestable.
- B4. Retry the code callback after a failed load (recommended). workerd does not document retry.

### Acceptance (b)

- `get(null, cb)` called twice gives two stubs with separate module state. `get('x')` twice gives one stub. A failed callback fails one request and the next request succeeds.
- Entrypoint props reach `ctx.props`. They are isolated between two stubs of one entrypoint. A constructor error fails the call.
- Limits: the lower `subRequests` of `WorkerCode` and `getEntrypoint` applies per field; the counter resets per invocation.
- Every descriptor imports with the correct type: `js`, `cjs` with `require`, `text`, `data` (an `ArrayBuffer` with exact bytes), `json`, `wasm` from bytes (an instantiable module). Include extensionless and mismatched-extension names.
- Rejected: a string module without `.js`, `.py`, a descriptor with two keys, `../` and absolute names, missing imports, oversized code and env.
- `'some-bare-name'` imported from `main.js` resolves to the root module. The same specifier imported from `sdk/chunk-x.js` resolves to `sdk/some-bare-name`. One module instance per file.
- `cloudflare:workers` imports work. Crypto behavior follows the dynamic worker's own compatibility selection when it differs from the parent's.

## 6. PR (c): streamed HTTP, tails and egress

### Proposed design

**Streaming.** PR (a) already moves fetch onto `callFetch` / `dispatchRpcFetch`. Headers arrive before the body. Chunks flow with the shared backpressure window. Consumer cancellation reaches the producing stream. This PR adds the contract tests and removes the remaining buffering. A `101` response with a `webSocket` from a dynamic worker fails with an explicit "not supported" error. Bridging it through `ws-bridge-shared.ts` is a follow-up.

**Egress.** At init, before user code is imported:

| `globalOutbound`   | `fetch()` in the dynamic worker                                                                                                                                      | `connect()` from `cloudflare:sockets`             |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| omitted            | Host network through Bun's fetch.                                                                                                                                    | Throws "TCP sockets are not supported by Lopata". |
| `null`             | Throws workerd's no-internet error. Pin the exact text from source.                                                                                                  | Throws the same no-internet error.                |
| Fetcher capability | `new Request(input, init)` goes to the capability's `fetch` over the channel. The original URL, method, headers and streamed body arrive. The response streams back. | Throws "TCP sockets are not supported by Lopata". |

- The dynamic thread registers a `cloudflare:sockets` module only to make these errors explicit.
- `node:http`, `node:https`, `node:net`, `node:tls`, `Bun.connect`, the `WebSocket` client and `Bun.spawn` are not intercepted. The "Not a sandbox" statement applies.
- The egress seam also increments the `subRequests` counter from PR (b).

**Tails.** For each finished invocation, after its handler, response body and `waitUntil` work settle, call `tail([traceItem])` on each `tails` capability. Each `traceItem` has a documented subset:

```ts
interface LocalTraceItem {
	entrypoint: string | null
	event:
		| {
			request: { url: string; method: string; headers: Record<string, string> }
			response?: { status: number }
		}
		| { cron: string; scheduledTime: number }
		| { rpcMethod: string }
	eventTimestamp: number
	outcome: 'ok' | 'exception' | 'canceled'
	logs: { level: string; message: unknown[]; timestamp: number }[]
	exceptions: { name: string; message: string; timestamp: number }[]
}
```

Console output is captured per invocation through `AsyncLocalStorage` in the dynamic thread. A failing tail call is logged. It never fails the invocation. `streamingTails` fails `get()`'s first request with "not supported by Lopata".

### Open decisions (c)

- C1. TCP is denied in all modes until Lopata has sockets (F20 / F19e) (recommended).
- C2. Egress interception covers `fetch()` only, with no blocking of Node or Bun network APIs (recommended). The documentation states that this is not a security boundary.
- C3. Tails use the local `TraceItem` subset above, and `streamingTails` is rejected (recommended).

### Acceptance (c)

- A dynamic `fetch` handler returns a stream that writes one chunk, waits, then ends. The caller reads the first chunk before the end. A slow reader keeps the producer within the window. Cancelling the reader cancels the producer's source. A streamed upload reaches the dynamic handler incrementally.
- `globalOutbound: null`: `fetch()` throws at top level and inside a handler. `connect()` throws.
- A Fetcher gateway with props receives every `fetch()`, including top-level ones, with the original URL, method and body. It sees its own `ctx.props`. Its streamed response reaches the dynamic code. Omitted `globalOutbound` reaches a local HTTP fixture directly.
- Each configured tail receives one item per invocation after `waitUntil` work settles, with captured logs, the exception and the outcome. A throwing tail does not fail the invocation.

## 7. PR (d): DO class handles and facets

### Class handles

`WorkerStub.getDurableObjectClass(name?, { props?, limits? })` returns an opaque handle:

```ts
export class DynamicDurableObjectClass {
	/** @internal */ constructor(
		readonly stub: WorkerStub,
		readonly className: string | null,
		readonly props: unknown,
		readonly limits: ResourceLimits | null,
	)
}
```

The handle is valid only as `class` in `ctx.facets.get()`. It is not serializable. Loopback DO namespaces from `ctx.exports` as facet classes require F07's DO loopbacks. They are deferred and fail with an explicit error.

### Facet manager (host DO thread)

Add `ctx.facets` to `DurableObjectStateImpl`, backed by a `FacetManager`:

```ts
export interface FacetStartupOptions {
	class: DynamicDurableObjectClass
	id?: DurableObjectIdImpl | string
}

export class FacetManager {
	get(
		name: string,
		getStartupOptions: () => FacetStartupOptions | Promise<FacetStartupOptions>,
	): FacetStub
	abort(name: string, reason: unknown): void
	delete(name: string): void
}
```

- `get` validates the name (a string of 1–256 characters) and returns a stub synchronously. The stub is a `makeBindingProxy` with `fetch`, methods and property reads, and without `id` or `name`. Each stub records the facet's generation at creation.
- On the first call through any stub, if the facet is not running, the manager awaits that stub's callback, validates `{ class, id? }`, boots the class's `WorkerStub` and sends `facet-start` over its channel. Concurrent first calls share one start. Running facets ignore later callbacks.
- `abort(name, reason)` increments the generation, stores `reason` and sends `facet-abort`. Old-generation stubs reject every call with `reason`. A new `get()` starts the facet again and may use another class or another `WorkerStub`.
- `delete(name)` aborts with `Error('Facet was deleted.')`, waits for the dynamic side to confirm closed handles, then removes storage. A `get()` of that name waits for the removal. `delete` itself returns `void`, as in Cloudflare.
- Facets of facets throw "Nested facets are not supported by Lopata". Supporting them later only needs the depth check (< 4) and path nesting below.
- Host `ctx.abort()`, eviction and reload terminate the dynamic threads through PR (a) ownership. Facets restart lazily on the next call. Facets have no lifetime of their own. F12's pending-I/O protection stays out of scope: a facet call from host background work can be cut by host eviction.

### Facet execution (dynamic thread)

`facet-start { key, generation, className, props, id: { hex, name? }, storageId }` constructs:

```ts
const state = new DurableObjectStateImpl(
	ctxId,
	db,
	hostNamespace,
	dataDir,
	limits,
	{ storageId, alarms: false, props, exports },
)
const instance = new Cls(state, env)
```

- `DurableObjectStateImpl` gains an options argument. `storageId` separates the storage identity from `ctx.id`. `alarms: false` makes `setAlarm` throw "Facets currently cannot set alarms." and `getAlarm` return `null`.
- `ctxId` is the host id (and name) by default, or the override. A string override becomes `new DurableObjectIdImpl(string)`.
- `db` is the thread's own connection to `data.sqlite`, opened as `do-worker-env.ts` does. `env` is the dynamic worker's decoded env. `exports` are its own loopbacks.
- Commands target `{ kind: 'facet', key, generation }` and pass through `_enter` / `_exit`, so `blockConcurrencyWhile` works. `facet-abort` rejects in-flight facet commands with the reason, drops the instance and closes its SQL handle.

### Persistence

The backlog requires approval of this design.

| Store                   | Host DO (unchanged)                       | Facet `runtime` of host `H`                            |
| ----------------------- | ----------------------------------------- | ------------------------------------------------------ |
| KV rows (`data.sqlite`) | `do_storage(namespace=<HostClass>, id=H)` | `do_storage(namespace=<HostClass>, id='H/facets/<k>')` |
| SQL file                | `.lopata/do-sql/<HostClass>/H.sqlite`     | `.lopata/do-sql/<HostClass>/H/facets/<k>.sqlite`       |
| Alarms                  | `do_alarms(namespace, H)`                 | none                                                   |

- `k` is the first 32 hex characters of SHA-256 over the UTF-8 facet name. It is path-safe for any name up to 256 characters. A nested facet would extend the path: `H/facets/<k1>/facets/<k2>`.
- `SqliteDurableObjectStorage` already builds the SQL path as `do-sql/<namespace>/<id>.sqlite` (`durable-object.ts:385–394`). The composite id therefore produces the facet layout without storage-class changes.
- No schema change and no data migration. Existing host data is untouched. Rows and files appear only when a facet is first used.
- `renamed_classes` and `deleted_classes` (`env.ts:140–166`) already act on the namespace and on the whole `do-sql/<class>` directory. Facets move or disappear with their host class.
- Removal is a single helper used by `facets.delete(name)`, host `deleteAll()` (workerd parity) and `deleteInstance()`. It runs `DELETE FROM do_storage WHERE namespace = ? AND (id = ? OR id LIKE ? ESCAPE '\')` with the escaped prefix `<id>/`, and removes `<k>.sqlite`, its `-wal` and `-shm` files and the `<k>/` subtree. Running facets are aborted first.
- Facet names are not recoverable from disk. The dashboard shows facet rows under the host namespace with their composite ids.
- Accepted limits: KV and SQL are separate files, as for host DOs today, so `transactionSync` is not atomic across them. Host ids from `idFromString` that contain `/` would collide with this layout. Reject `/` in ids, or accept this as a documented limit.

**Alternative (F2):** one self-contained SQLite file per facet, with KV in an internal table inside the same file. It matches Cloudflare's single database per facet, and deletion is file removal only. It needs storage-class changes (an injected connection and table) and exposes or hides an internal table to `sql.exec`. It also differs from how Lopata stores host DOs. Recommend F1 (the table above).

### Open decisions (d)

- D1. Facet persistence layout F1 (recommended) or F2.
- D2. The host's `deleteAll()` deletes facet storage, as workerd does (recommended).
- D3. Facet classes come from `getDurableObjectClass` only. `ctx.exports` DO classes wait for F07. Nested facets throw. `clone()` is not implemented.
- D4. Facets share the host executor's lifetime, with no independent eviction and no F12 work (recommended).
- D5. Reject `/` in DO ids passed to `idFromString`, or document the collision.

### Acceptance (d)

- `facets.get` returns a stub synchronously. The callback is not invoked before the first call. A sync and an async callback both work. A running facet does not invoke a second callback. Concurrent first calls start one instance.
- `ctx.id` inherits the host id and name. An override id (string and `DurableObjectId`) is visible as `ctx.id`, and storage still follows the facet name.
- Storage isolation: host, facet `a`, facet `b`, and facet `a` of another host never see each other's KV or SQL data.
- Facet KV and SQL data survive `abort`, host hot reload, host eviction and a full process restart.
- After `abort(name, reason)`, every existing stub rejects with `reason`. A new `get()` invokes its callback again, may switch class, and sees the old data.
- `delete(name)` removes rows and files, including `-wal` and `-shm`. The next `get()` starts empty. The host's `deleteAll()` and `deleteInstance()` remove every facet's storage. Class rename keeps facet data. Class deletion removes it.
- `ctx.storage.setAlarm` in a facet throws the workerd message. A host alarm set through a capability fires on the host.
- Passing a facet stub through RPC fails with the "not serializable" error. A 257-character name and a nested facet are rejected.

## 8. End-to-end scenario test and SDK gate

Add a fixture worker (under `tests/fixtures/`) with a SQLite-backed host DO, `RuntimeHost` and `EgressGateway` entrypoints and a local HTTP target. Run it through the real CLI DO thread. It performs every step in section 3: boot with the module map above, facet `fetch` with a streamed response, an RPC call with a callback, facet SQL and KV writes, `env.HOST.setAlarm` firing the host alarm, an outbound `fetch()` observed by the gateway with its props, `abort` with the reason at an old stub, and data intact after `abort`, reload and process restart. The fixture contains no names of real products or consumers.

**SDK gate:** after the primitives pass, run pinned Code Mode and Dynamic Workflows examples. A basic fetch/RPC test does not establish support for either SDK.

## 9. PR sequence and territories

| Unit      | Deliverable and owned files                                                                                                                                                                                                                                                                      | Gate                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| Fix       | Module-name and id path validation, random stub directories (`worker-loader.ts`). Small, independent; can land before (a).                                                                                                                                                                       | None beyond review.                 |
| F07 slice | `ctx.exports` WorkerEntrypoint loopbacks in `DurableObjectStateImpl` and worker-thread contexts, reusing #49's `loopbacks()`.                                                                                                                                                                    | #49 merged; F07 approves the slice. |
| (a)       | `rpc-shared.ts` generics and codec hooks, new `capability.ts`, `rpc-stub.ts` brand and dispose, `worker-loader.ts`, `worker-loader-entry.ts`, new loader protocol, spawn ownership in `executor.ts`, `entry.ts`, `do-executor-worker.ts`, `do-worker-entry.ts`, `protocol.ts`, `do-protocol.ts`. | A1–A3.                              |
| (b)       | `worker-loader.ts`, `worker-loader-entry.ts`, new `worker-loader-modules.ts`.                                                                                                                                                                                                                    | B1–B4; probes on CI's Bun.          |
| (c)       | `worker-loader-entry.ts` (egress, sockets module, tails, console capture).                                                                                                                                                                                                                       | C1–C3.                              |
| (d)       | New `facets.ts`, `durable-object.ts` (state options, `ctx.facets`, removal helper, `deleteAll` and `deleteInstance` cascade), `worker-loader.ts` (`getDurableObjectClass`), `worker-loader-entry.ts` (facet host), `do-worker-entry.ts`.                                                         | D1–D5.                              |

`worker-loader-entry.ts` is shared by (a)–(d). Hand it off sequentially. (a) is the only PR that changes `rpc-shared.ts`. For the scenario, the order is: Fix, F07 slice, (a), (b), (c) egress, (d). Tails, the streaming tests and the remaining (b) descriptors can land after (d).

Run focused tests, typecheck, lint, dprint and the full suite under `cpu-lease` for each PR. No tests were run for this design-only note. The probes in section 1 used a scratch directory.

## 10. Human approval checklist

1. Baseline: #49 merges first; F16 reuses its compatibility selection and `loopbacks()`.
2. Scope statement: Dynamic Workers in Lopata are not a security boundary; egress control covers `fetch()` only.
3. A1: main owns dynamic threads and transfers a `MessagePort` pair.
4. A2: strict env policy with path-named `TypeError`s; no JSON fallback.
5. A3: explicit, refcounted, channel-scoped disposal; no GC release; no automatic parameter disposal.
6. B1/B2: JS-wrapper materialization, `onLoad` loader forcing, `node_modules` symlinks for bare names, load-time import validation, computed `import()` fallback.
7. B3: enforce `subRequests` and the env/code size limits; accept `cpuMs` unenforced.
8. B4: retry the code callback after a failed load.
9. C1–C3: TCP denied everywhere; local `TraceItem` subset; `streamingTails` rejected; WebSocket upgrades from dynamic workers unsupported.
10. D1: facet persistence layout F1 with hashed facet keys and no schema change.
11. D2–D5: host `deleteAll()` cascades; facet classes from the loader only; nested facets and `clone()` unsupported; facet lifetime equals host executor lifetime; `/` in DO ids.
12. Ordering: the Fix and the F07 slice land before (a); (c) egress lands before (d).

## Sources

- [workerd `worker-loader.h`](https://github.com/cloudflare/workerd/blob/fe4ed9aeb1ce9ace2c789d71a19727c692746033/src/workerd/api/worker-loader.h) and [`worker-loader.c++`](https://github.com/cloudflare/workerd/blob/fe4ed9aeb1ce9ace2c789d71a19727c692746033/src/workerd/api/worker-loader.c++): `get`/`load`, `WorkerCode`, module rules, size limits, outbound inheritance, entrypoint and class options.
- [workerd `io-channels.h`](https://github.com/cloudflare/workerd/blob/fe4ed9aeb1ce9ace2c789d71a19727c692746033/src/workerd/io/io-channels.h): `ResourceLimits`.
- [workerd `actor-state.h`](https://github.com/cloudflare/workerd/blob/fe4ed9aeb1ce9ace2c789d71a19727c692746033/src/workerd/api/actor-state.h) and [`actor-state.c++`](https://github.com/cloudflare/workerd/blob/fe4ed9aeb1ce9ace2c789d71a19727c692746033/src/workerd/api/actor-state.c++): `DurableObjectFacets`, startup options, name and depth limits.
- [workerd `server.c++`](https://github.com/cloudflare/workerd/blob/fe4ed9aeb1ce9ace2c789d71a19727c692746033/src/workerd/server/server.c++) and [`facet-tree-index.h`](https://github.com/cloudflare/workerd/blob/fe4ed9aeb1ce9ace2c789d71a19727c692746033/src/workerd/server/facet-tree-index.h): local facet storage, delete and reset cascade, facet alarm error.
- Cloudflare documentation, retrieved October 12, 2026: [API reference](https://developers.cloudflare.com/dynamic-workers/api-reference/), [bindings](https://developers.cloudflare.com/dynamic-workers/usage/bindings/), [egress control](https://developers.cloudflare.com/dynamic-workers/usage/egress-control/), [limits](https://developers.cloudflare.com/dynamic-workers/usage/limits/), [Durable Object facets](https://developers.cloudflare.com/dynamic-workers/usage/durable-object-facets/).

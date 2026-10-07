# Cloudflare Workers compatibility review

Review window: April 2–October 2, 2026. Starting point: `origin/main` at `99ae836` (Lopata 0.24.0).

The review covered the Cloudflare Workers blog archive, both 2026 Agents Week recaps, and the runtime documentation linked from the announcements. Blog announcements describe the motivation; the linked API documentation defines the implementation contracts.

**Current scope (October 5, 2026):** [PR #31](https://github.com/contember/lopata/pull/31) retains the four backports below, with approved additions for shared `exports` parser coexistence and Workers Cache soft invalidation. These additions are complete and verified locally, not yet pushed; see [current verification](#current-verification). The [follow-up backlog](WORKERS-COMPAT-BACKLOG.md) defines the completion boundary and proposed later work. The [annual review](reports/Roční%20přehled%20Workers%20API.md) covers October 5, 2025–October 5, 2026 and describes snapshot head [`8b82801`](https://github.com/contember/lopata/tree/8b82801ac83d4880d64a0cfa948698347ea84f1a), not the current implementation or its verification status.

## Backports selected for this update

| Announcement                                                                                                                                                               | Date                | Local implementation                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------ |
| [Workflow saga rollbacks](https://blog.cloudflare.com/rollbacks-for-workflows/)                                                                                            | June 25             | Extend the existing Workflow engine with per-step compensation and durable rollback state.                   |
| [Workers Cache](https://blog.cloudflare.com/workers-cache/)                                                                                                                | July 6              | Accept the configuration and purge/invalidate API; responses pass through uncached.                          |
| [Third-party AI models](https://blog.cloudflare.com/ai-platform/) and [Workers AI and AI Gateway unification](https://blog.cloudflare.com/workers-ai-gateway-unification/) | April 16 / August 7 | Extend the existing authenticated HTTP proxy to forward gateway options and support the gateway binding API. |
| [Modern Web Crypto](https://blog.cloudflare.com/workers-ml-kem-ml-dsa-support/)                                                                                            | October 1           | Expose Bun's native implementation as-is; available on Bun 1.4.2 and later.                                  |

The modern-crypto target is Cloudflare's shipped subset: ML-KEM-768/1024, ML-DSA-44/65/87, the four encapsulation methods, `getPublicKey()`, static `SubtleCrypto.supports()` and JWK import/export. Lopata relies on Bun's native support; see [Modern Web Crypto](#modern-web-crypto). ML-KEM-512, SHA-3, cSHAKE, TurboSHAKE, ChaCha20-Poly1305 and HPKE are not part of this Cloudflare release.

### AI Gateway

The AI binding uses `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` for authenticated Cloudflare requests. Gateway routing remains remote inference, with local request logs stored in SQLite.

```ts
const result = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
	messages: [{ role: 'user', content: 'Hello' }],
}, {
	gateway: { id: 'my-gateway', skipCache: true },
})
```

`env.AI.gateway(id)` exposes `run()`, `getUrl()`, `getLog()` and `patchLog()`. Universal inference accepts one provider request or an ordered fallback array. Per-provider timeout and retry configuration is forwarded to Cloudflare. Raw responses and streaming bodies are returned without consuming them for local logging.

### Workflow rollbacks

Register compensation with `step.do(name, callback, { rollback, rollbackConfig })`, or add the forward-step config before the callback. The rollback callback receives `{ ctx, error, output }`; `output` is undefined when the forward step did not complete.

On terminal failure, started steps are compensated in reverse start order after the forward work settles. Compensation progress persists in SQLite. Reload recovery replays the workflow to restore handlers while retaining completed forward steps and compensations. Exhausted compensation failure stops the remaining handlers.

`instance.terminate({ rollback: true })` requests compensation before termination. Ordinary termination skips it. `instance.status()` retains the original workflow error and reports compensation separately through `rollback`, whose final outcome is `complete` or `failed`.

**Callback settlement policy:** a timeout rejects the step result but cannot stop JavaScript already running in that callback. Compensation waits for the actual forward callbacks to settle. A callback that never settles can therefore leave rollback waiting indefinitely. This strict ordering policy was explicitly accepted for this backport. Recovery preserves built-in error types and `NonRetryableError` identity; arbitrary custom error subclass prototypes are not restored.

### Workers Cache

Lopata accepts the Workers Cache configuration but never caches entrypoint responses. Every request reaches the Worker, so local edits are visible immediately. Named exports can override the top-level setting:

```json
{
	"cache": { "enabled": true },
	"exports": {
		"Gateway": { "type": "worker", "cache": { "enabled": false } }
	}
}
```

Config loading still validates these keys: `enabled` must be a boolean, `cross_version_cache` is a top-level boolean only, unknown fields are rejected, and `cache` is rejected on Durable Object and Workflow exports.

Loopback entrypoints (`ctx.exports.<Name>.fetch()`, RPC methods and properties) dispatch to the target entrypoint as on Cloudflare. Purge and invalidation are available through the execution context or the module import, and resolve to `{ success: true, errors: [] }` without doing anything:

```ts
import { cache } from 'cloudflare:workers'

await ctx.cache.purge({ tags: ['articles'] })
await cache.invalidate({ purgeEverything: true })
```

Freshness, stale-while-revalidate, revalidation, `cf-cache-status`, custom cache keys and purge option validation are not emulated. The separate `caches` API retains its existing behavior.

#### Shared export declarations

The locally verified parser accepts concrete `worker`, `durable-object` and `workflow` declarations together, with or without Worker cache configuration. Worker cache validation still applies. Accepting these declarations does not implement declarative Durable Object lifecycle, Workflow lifecycle or their binding/loopback wiring. That work remains in [F07 — Declarative exports and complete loopback wiring](WORKERS-COMPAT-BACKLOG.md#f07--declarative-exports-and-complete-loopback-wiring-design-gated-pr-series).

### Durable Object scheduled-alarm deletion

`storage.deleteAll()` removes the scheduled alarm with compatibility dates from `2026-02-24`, or the explicit `delete_all_deletes_alarm` flag. The inverse `delete_all_preserves_alarm` flag preserves it. Without a date or either flag, the existing local alarm-preserving behavior remains. Selection belongs to the target object. Enabled deletion removes persisted alarm state and cancels its armed timer; it does not interrupt an already-dispatched handler or implement abort/retry suppression. Application SQL-table deletion remains a separate compatibility gap.

**Accepted local shared-connection limit:** `deleteAll()` rejects before mutation whenever its SQLite connection has an open transaction. In-process objects can share that connection, so an external call to object B also rejects while object A's transaction is suspended, even though B did not start a transaction. This applies to both enabled and legacy alarm behavior. The conservative guard prevents scheduler cancellation from surviving a database rollback. It is a local limitation, not a claim that Cloudflare rejects independent objects' operations. Transactions on separate connections are not covered by this guard.

### Durable Object abort

`ctx.abort(reason, { retryAlarm })` throws `reason` and rejects the object's pending calls with it. The next request constructs a fresh instance. Omitted `retryAlarm` and `true` retry an interrupted alarm through the normal alarm retry backoff; `false` suppresses that retry. A retry is also skipped when the alarm was set or deleted (including by `deleteAll()`) while the attempt ran. This is tracked in memory per attempt, not persisted.

- Worker-thread objects: main terminates the object's thread. Committed writes survive; the thread's open SQLite transaction rolls back.
- In-process objects (testing helpers): JavaScript cannot be stopped, so the old handler keeps running detached from its callers. Its storage access is not fenced.
- Container-backed objects keep the previous behavior: `abort()` does not throw and the instance is replaced on next access.

### WebSocket close reasons and callback ownership — F08a

`WebSocketPair` sockets enforce the **123 UTF-8-byte** close-reason bound with compatibility dates from `2026-03-03` or `websocket_close_reason_byte_limit`. `no_websocket_close_reason_byte_limit` disables it; explicit flags override dates. With neither a date nor an override, the existing unvalidated local behavior remains. The reference is released workerd [`v1.20261005.1`](https://github.com/cloudflare/workerd/blob/v1.20261005.1/src/workerd/api/web-socket.c++), `LegacyWebSocketAdapter::close`.

Oversized reasons throw a `DOMException` named `SyntaxError` before any ready-state early return, including repeated close calls. Failed validation does not change either socket's state or dispatch close events. This bounded change preserves the existing close handshake and close-code behavior.

Each socket captures its owning compatibility selection at construction. Dedicated user/DO/dynamic threads initialize an immutable isolate fallback before application import; same-process dispatch uses native compatibility ALS. Runtime-delivered message, close, error and open events enter the socket owner's scope for both EventTarget listeners and callback properties. Async descendants retain it, so newly constructed pairs use the owner rather than the delivery caller. Queued events use the same delivery boundary. This does not add socket tracing lifetimes or scope native externalized module evaluation.

Local verification on Bun **1.4.2 (`744846f84`)** covers date/flag selection, ASCII/multibyte/surrogate boundaries, state preservation, repeated close, cross-scope method calls, queued events, overlapping bridge delivery, and two differently configured Vite servers. Real CLI and Vite upgrades cover ordinary Worker, standard DO and hibernation callbacks, including nested sockets. Existing binary echo and close tests pass. Binary selection and the bounded automatic close-event subset are covered below; full close-handshake semantics and network message limits remain F08 follow-ups. These results do not establish hosted parity or durable hibernation.

### WebSocket binary delivery — F08b

Application-facing `WebSocketPair` endpoints expose `binaryType` for both enabled and disabled selections. It defaults to `'blob'` from compatibility date `2026-03-17` or with `websocket_standard_binary_type`, and to `'arraybuffer'` before that date or with `no_websocket_standard_binary_type`. Explicit overrides take precedence. Both modes permit switching between those values; invalid strings leave the value unchanged. With no date and no override (`legacy-local`), the property remains absent and delivery remains ArrayBuffer; an application-created expando does not affect delivery.

This follows released workerd [`v1.20261005.1`, `web-socket.h:390–401`](https://github.com/cloudflare/workerd/blob/v1.20261005.1/src/workerd/api/web-socket.h#L390-L401) and [`web-socket.c++:1694–1704`](https://github.com/cloudflare/workerd/blob/v1.20261005.1/src/workerd/api/web-socket.c++#L1694-L1704). The release exposes the property even with the binary flag disabled, contrary to the historical-absence assumption in the earlier research. Lopata installs an own accessor for selected sockets; the separate workerd instance/prototype property flag is not implemented here.

Binary bytes become a Blob only when constructing an application `MessageEvent`, using the receiver's current selection at delivery time. Queued messages retain bytes; changing `binaryType` in one listener affects later messages, not that listener's already-created event. Text stays text. Listener and callback-property delivery share one event and retain F08a's captured owner scope.

Internal transport endpoints opt into raw delivery before acceptance or queue flushing. Bridge envelopes and queues remain `string | ArrayBuffer`, including adopted and reshipped endpoints; reconstructed application endpoints retain selected conversion. Hibernation handlers always receive ArrayBuffer regardless of the public property, matching [`global-scope.c++:897–916`](https://github.com/cloudflare/workerd/blob/v1.20261005.1/src/workerd/api/global-scope.c++#L897-L916). Hibernation acceptance wires its listeners before flushing queued messages. CLI/Vite ingress and pair ArrayBufferView sends copy only the selected view's offset and length.

Focused local verification on Bun **1.4.2 (`744846f84`)** covers date/flag/default selection, switching and invalid strings, empty/text/binary messages, queued conversion order and shared event identity, nonzero-offset Buffer/DataView/typed-array bytes, bridge/adoption/reconstruction boundaries, real CLI/Vite Worker and DO upgrades, hibernation's raw exception (including pre-accept messages), and overlapping opposite selections in two Vite servers. This is selected local delivery support, not full WebSocket or hosted conformance. Message-size limits and half-open/automatic-close behavior remain separate.

### Automatic WebSocket close-event state — F08c1

For ordinary sockets selected by compatibility date `2026-04-07` or later, or `web_socket_auto_reply_to_close`, runtime close delivery sets `readyState` to `CLOSED` before EventTarget listeners and the `onclose` property run. Both receive the same event under the socket's captured owner scope. A selected delivery guard suppresses a duplicate terminal notification, including the synchronous native close echo that can occur during server-initiated `close()` in Vite. Queued close events use the same boundary.

`web_socket_manual_reply_to_close`, dates before the threshold, and `legacy-local` retain their existing local behavior. This does **not** implement historical manual-reply semantics. `accept({ allowHalfOpen })` and application-controlled reciprocal Close frames remain unsupported. Released workerd's normal read loop queues a reciprocal frame before dispatch in automatic mode; this unit implements only the event-state subset, not its complete directional close state machine. Reference: [`v1.20261005.1`, `web-socket.c++:1426–1449`](https://github.com/cloudflare/workerd/blob/v1.20261005.1/src/workerd/api/web-socket.c++#L1426-L1449).

Hibernation delivery has an explicit marker, separate from raw binary delivery, and retains its existing close behavior. In the tested CLI DO bridge, its callback observes CLOSED. In the tested in-process Vite path, a client-initiated close invokes the callback with OPEN; the handler's own `ws.close()` produces another callback with CLOSED. This preserved limitation is not hibernation close-handshake conformance. Hibernation messages remain ArrayBuffer.

Read-only wire probes on Bun **1.4.2 (`744846f84`)** established that `Bun.serve()` and Vite's bare `ws` import (Bun's built-in adapter) send the reciprocal Close and TCP FIN before application `close()`. Their close callbacks already see CLOSED. Explicitly importing installed `ws` **8.19.0** also auto-replies before its terminal callback. These transports cannot provide the required manual decision through their current close callbacks; transport control remains separately design-gated.

Focused tests on Bun 1.4.2 verify thresholds/overrides, preserved legacy and hibernation paths, queued close delivery, callback identity and owner scope after await, reentrant close deduplication, and real CLI/Vite ordinary Worker and standard DO client/server-initiated closes. The support claim is local automatic close-event consistency only. Network message limits, half-open behavior, transport replacement and hosted parity are not included.

### Modern Web Crypto

Lopata exposes Bun's native Web Crypto as-is. There is no adapter and no compatibility-flag gating; `webcrypto_modern_algorithms` is accepted as an unimplemented flag with no effect. On Bun 1.4.2 and later, ML-KEM, ML-DSA, the encapsulation methods, `crypto.subtle.getPublicKey()` and `SubtleCrypto.supports()` are available natively. On older Bun versions they are absent. Cloudflare-specific extras (`crypto.subtle.timingSafeEqual`, `crypto.DigestStream`, PKCS#1 import) are applied on top of the native object.

## Existing local building blocks

These features had local implementations at the starting revision. This is an inventory, not a claim that every Cloudflare behavior is emulated.

| Announcement                                                                                                                                        | Existing implementation                                                      | Relevant limits                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [April Agents Week: Artifacts, Flagship, AI Search, Email Service, VPC](https://blog.cloudflare.com/agents-week-in-review/)                         | `artifacts.ts`, `flagship.ts`, `ai-search.ts`, `email.ts`, `vpc-network.ts`  | Artifacts uses local Git and SQLite. Flagship evaluates static values, without targeting rules. AI Search proxies to Cloudflare. Email is captured locally. VPC uses host networking, without a Mesh overlay. |
| [Dynamic Workflows](https://blog.cloudflare.com/dynamic-workflows/)                                                                                 | Worker Loader and Workflows provide the underlying local building blocks.    | The Dynamic Workflows library itself was not verified in this review.                                                                                                                                         |
| [Sandboxes GA](https://blog.cloudflare.com/sandbox-ga/)                                                                                             | Docker-backed Containers and the Sandbox dependency.                         | Cloudflare-managed provisioning and egress services are not local services.                                                                                                                                   |
| [Browser Run](https://blog.cloudflare.com/browser-run-for-ai-agents/) and [Containers backend](https://blog.cloudflare.com/browser-run-containers/) | Local Puppeteer binding.                                                     | Cloudflare's hosted Live View, recording and scaling services are separate platform features.                                                                                                                 |
| [Local tracing](https://blog.cloudflare.com/local-tracing/)                                                                                         | Automatic spans, correlated logs, dashboard and trace CLI.                   | Lopata's APIs are distinct from Wrangler's Local Explorer API.                                                                                                                                                |
| [Node.js compatibility and new module registry](https://blog.cloudflare.com/workers-module-registry-nodejs/)                                        | Bun provides Node-compatible APIs and a native module loader.                | Workerd-specific import-attribute validation, module URLs, `import.meta.main` and WebAssembly source-phase imports must not be assumed identical to Bun.                                                      |
| [cdnjs platform migration](https://blog.cloudflare.com/cdnjs-dev-platform-migration/)                                                               | Workers, R2, KV, D1, Queues, Containers and Workflows already exist locally. | The article's scale and billing changes are Cloudflare platform properties. Workflow limits remain configurable locally.                                                                                      |

## Remaining runtime gaps

The implementation scope remains the four backports above plus the approved parser-coexistence and cache-invalidation additions. The [follow-up backlog](WORKERS-COMPAT-BACKLOG.md) tracks the broader annual findings. Access identity simulation and active-span lookup were identified during the original final inventory check and deferred to follow-up work. The scope also excludes these additional projects:

- [Durable Object Facets](https://blog.cloudflare.com/durable-object-facets-dynamic-workers/): dynamic Durable Object classes and independently managed facet storage need a separate implementation.
- [Inbound TCP and gRPC](https://blog.cloudflare.com/grpc-workers/): the private-beta `connect(socket)` handler, Spectrum ingress and gRPC translation need their own transport design.
- [Python RPC](https://blog.cloudflare.com/python-workers-rpc/): Pyodide execution and cross-language object conversion require a separate runtime integration.
- [Rust/Emscripten support](https://blog.cloudflare.com/rust-workers-emscripten-target/): compatibility of the experimental toolchain's generated JavaScript/WebAssembly and required runtime APIs was not verified.
- [Cloudflare Computer](https://blog.cloudflare.com/cloudflare-computer/): an application library built on several runtime primitives; end-to-end library compatibility was not verified here.
- [Access for Workers](https://blog.cloudflare.com/workers-protected-by-access/): `ctx.access.getIdentity()` and Wrangler's `access.dev` identity simulation are local runtime APIs not yet implemented by Lopata.
- [Issues and application context](https://blog.cloudflare.com/real-time-issue-detection/): the announcement uses `tracing.getActiveSpan()`, which Lopata does not yet expose. The existing `tracing.enterSpan()` API covers custom child spans only.

Access policy enforcement, hosted Issues grouping and automations, managed AI model catalogs, billing, CI services and account provisioning are platform services. The Access identity and active-span APIs above are distinct local runtime gaps.

## Authoritative API references

- [Workflows Workers API](https://developers.cloudflare.com/workflows/build/workers-api/)
- [Workers Cache configuration](https://developers.cloudflare.com/workers/cache/configuration/)
- [Workers Cache keys](https://developers.cloudflare.com/workers/cache/cache-keys/)
- [Workers Cache purge](https://developers.cloudflare.com/workers/cache/purge/)
- [Workers Cache invalidation announcement](https://developers.cloudflare.com/changelog/post/2026-09-29-workers-cache-invalidate/)
- [Workers AI bindings](https://developers.cloudflare.com/workers-ai/configuration/bindings/)
- [AI Gateway Workers bindings](https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/)
- [Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)
- [Modern Web Crypto draft](https://wicg.github.io/webcrypto-modern-algos/)

## Current verification

Local completion checks on October 5, 2026 cover [`2f1d444` — mixed export declarations](https://github.com/contember/lopata/commit/2f1d444) and [`87b84e6` — Workers Cache soft invalidation](https://github.com/contember/lopata/commit/87b84e6). Runtime: Bun 1.4.2 (`744846f84`). Each Bun command below ran under `cpu-lease run -n 2 --`. The full suite ran after all source changes; its fixture source restored itself.

| Command                                                                                                                                                                                                                 | Result                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `bun run typecheck`                                                                                                                                                                                                     | Passed.                                                                                          |
| `bun run lint`                                                                                                                                                                                                          | Passed; 409 files checked.                                                                       |
| `bun run format:check`                                                                                                                                                                                                  | Passed.                                                                                          |
| `bun test tests/worker-cache-config.test.ts tests/worker-cache-invalidate.test.ts tests/worker-cache.test.ts tests/worker-cache-regressions.test.ts tests/worker-cache-runtime.test.ts tests/worker-cache-vite.test.ts` | 79 passed, 0 failed; 422 assertions across 6 files.                                              |
| `bun run test`                                                                                                                                                                                                          | 1,905 passed, 0 failed, 2 pre-existing skips; 1,907 tests across 104 files and 4,357 assertions. |
| `git diff --check`                                                                                                                                                                                                      | Passed.                                                                                          |

Independent source reviews reported no findings. Documentation review resolved the F07b/F04 dependency distinction with no remaining findings. These are local verification results, not a new CI run or live Cloudflare parity claim. The additions have been pushed to PR #31. Follow-up implementation is approved and tracked in [WORKERS-COMPAT-PROGRESS.md](WORKERS-COMPAT-PROGRESS.md), with concrete architecture decisions still approval-gated.

## Historical verification

These results predate the approved parser-coexistence and soft-invalidation additions. They do not verify those additions; their completion checks are recorded separately above.

Historical final checks on October 2, 2026:

| Command                         | Result                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| `bun install --frozen-lockfile` | Passed.                                                                               |
| `bun run lint`                  | Passed; 408 files checked.                                                            |
| `bun run format:check`          | Passed.                                                                               |
| `bun run typecheck`             | Passed.                                                                               |
| `bun run test`                  | 1,885 passed, 0 failed, 2 skipped; 1,887 tests across 103 files and 4,154 assertions. |
| `git diff --check`              | Passed.                                                                               |

The two skips are pre-existing `tests/ws-hmr-e2e.test.ts` cases for preserving WebSockets across reloads. The active reload test for closing connections with code 1012 passed. Concurrent cold SQLite startup was also verified with 10 consecutive passes of the normal-worker/Durable-Object crypto isolation test after installing the busy timeout before WAL initialization.

Historical CI compatibility verification on October 5, 2026 used Bun 1.4.2, matching the GitHub Actions runner. After switching fixture directories to `node:os`'s `tmpdir()` and gating Bun's native modern crypto, `bun run test` passed with 1,885 passes, 0 failures, 2 skips and 4,162 assertions. Lint, formatting and typecheck also passed. The flag-toggle regression was verified on Bun 1.3.14 as well.

Those historical focused tests covered AI Gateway request forwarding and errors; Workflow rollback ordering, recovery, termination and persistence; cache HTTP semantics, isolation, purge, entrypoint dispatch, RPC contexts and background work; and modern crypto primitives, key formats and compatibility-flag wiring across normal workers, Durable Objects, dynamic workers and Vite.

Live Cloudflare inference and authentication were not exercised. Global cache propagation requires Cloudflare infrastructure and was not verified locally. The accepted callback-settlement, post-quantum key and cache limitations are recorded above.

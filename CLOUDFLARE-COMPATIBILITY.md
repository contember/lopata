# Cloudflare Workers compatibility review

Review window: April 2–October 2, 2026. Starting point: `origin/main` at `99ae836` (Lopata 0.24.0).

The review covered the Cloudflare Workers blog archive, both 2026 Agents Week recaps, and the runtime documentation linked from the announcements. Blog announcements describe the motivation; the linked API documentation defines the implementation contracts.

**Current scope (October 5, 2026):** [PR #31](https://github.com/contember/lopata/pull/31) retains the four backports below, with approved additions for shared `exports` parser coexistence and Workers Cache soft invalidation. These additions are complete and verified locally, not yet pushed; see [current verification](#current-verification). The [follow-up backlog](WORKERS-COMPAT-BACKLOG.md) defines the completion boundary and proposed later work. The [annual review](reports/Roční%20přehled%20Workers%20API.md) covers October 5, 2025–October 5, 2026 and describes snapshot head [`8b82801`](https://github.com/contember/lopata/tree/8b82801ac83d4880d64a0cfa948698347ea84f1a), not the current implementation or its verification status.

## Backports selected for this update

**Current runtime requirement:** Bun 1.4.2 or later. CI and release verification are pinned to 1.4.2. The scoped crypto facade requires property behavior verified on that version; older Bun versions are no longer supported. Older-version probes and test results below remain historical evidence, not current support claims.

| Announcement                                                                                                                                                               | Date                | Local implementation                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------ |
| [Workflow saga rollbacks](https://blog.cloudflare.com/rollbacks-for-workflows/)                                                                                            | June 25             | Extend the existing Workflow engine with per-step compensation and durable rollback state.                   |
| [Workers Cache](https://blog.cloudflare.com/workers-cache/)                                                                                                                | July 6              | Add an entrypoint-scoped response cache, separate from the existing `caches` API.                            |
| [Third-party AI models](https://blog.cloudflare.com/ai-platform/) and [Workers AI and AI Gateway unification](https://blog.cloudflare.com/workers-ai-gateway-unification/) | April 16 / August 7 | Extend the existing authenticated HTTP proxy to forward gateway options and support the gateway binding API. |
| [Modern Web Crypto](https://blog.cloudflare.com/workers-ml-kem-ml-dsa-support/)                                                                                            | October 1           | Add the opt-in modern crypto API using `@noble/post-quantum` for primitives unavailable in Bun.              |

The modern-crypto target is Cloudflare's shipped subset: ML-KEM-768/1024, ML-DSA-44/65/87, the four encapsulation methods, `getPublicKey()`, static `SubtleCrypto.supports()` and JWK import/export. It requires `webcrypto_modern_algorithms`. ML-KEM-512, SHA-3, cSHAKE, TurboSHAKE, ChaCha20-Poly1305 and HPKE are not part of this Cloudflare release.

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

Enable entrypoint response caching in Wrangler configuration. Named exports can override the top-level setting:

```json
{
	"cache": { "enabled": true },
	"exports": {
		"Gateway": { "type": "worker", "cache": { "enabled": false } }
	}
}
```

Response headers control freshness and stale-while-revalidate behavior. Cache identity includes the Worker, entrypoint, version and `ctx.props`, while ignoring the request hostname. Responses persist in SQLite. Reloads start cold unless `cache.cross_version_cache` is enabled.

#### Purge and soft invalidation

Soft invalidation is implemented and locally verified within the following contract and accepted limitations.

Both operations are available through the execution context or the active-context import:

```ts
import { cache } from 'cloudflare:workers'

await ctx.cache.purge({ tags: ['articles'] })
await cache.purge({ pathPrefixes: ['/articles/'] })
await ctx.cache.invalidate({ tags: ['articles'] })
await cache.invalidate({ purgeEverything: true })
```

Both accept the same selectors and return a promise of `{ success: true, errors: [] }` on success, or `{ success: false, errors: [{ code: 1000, message }] }` for invalid options:

- `tags`: 1–1,000 printable ASCII tags, each at most 1,024 characters; matching is case-insensitive.
- `pathPrefixes`: a nonempty list of paths without a scheme, host, query or fragment. A missing leading slash is added; matching uses pathname prefixes.
- `purgeEverything: true`: selects every entry and cannot be combined with the other selectors.
- Tags and path prefixes may be combined; an entry matching either selector is selected. At least one selector is required; unknown options are rejected.

Operations target the active Worker's entrypoint, including all of its props and version partitions. Other Workers and entrypoints are excluded. Imported `cache` requires an active Worker execution context. The separate `caches` API retains its existing behavior.

`purge()` deletes matching entries. The next eligible request misses and invokes the Worker. `invalidate()` instead sets the stored TTL to zero using the existing SQLite schema. It preserves the response body, validators, headers and age origin; invalidation does not reset `Age` or rewrite the stored `Cache-Control` header.

On the next eligible request, an invalidated entry is stale. Revalidation can send its retained `ETag` or `Last-Modified` validator to the Worker. A `304 Not Modified` reuses the stored body and updates freshness from the revalidation response; subsequent requests can hit that refreshed entry while it remains fresh. A cacheable replacement response can likewise serve subsequent hits. Existing stale-while-revalidate (SWR) and stale-if-error (SIE) windows still apply: SWR may serve the stale body while revalidation runs, and SIE may permit stale fallback on an error.

**Accepted local semantics:** after TTL is set to zero, SWR/SIE windows are measured from the original age origin, not restarted at invalidation. An already old entry can therefore be outside either window immediately after invalidation. Live Cloudflare parity for this TTL-zero, preserved-age and stale-window combination has not been verified. Neither operation emulates global propagation.

#### Shared export declarations

The locally verified parser accepts concrete `worker`, `durable-object` and `workflow` declarations together, with or without Worker cache configuration. Worker cache validation still applies. Accepting these declarations does not implement declarative Durable Object lifecycle, Workflow lifecycle or their binding/loopback wiring. That work remains in [F07 — Declarative exports and complete loopback wiring](WORKERS-COMPAT-BACKLOG.md#f07--declarative-exports-and-complete-loopback-wiring-design-gated-pr-series).

**Local cache limits:** stale-while-revalidate deduplication applies within one dispatcher. Unknown-length and multipart range responses buffer the representation with a 30-second timeout and a 512 MiB limit; the exact timeout and size boundaries were not exercised. Cloudflare purge rate limits are not emulated.

### Durable Object scheduled-alarm deletion

`storage.deleteAll()` removes the scheduled alarm with compatibility dates from `2026-02-24`, or the explicit `delete_all_deletes_alarm` flag. The inverse `delete_all_preserves_alarm` flag preserves it. Without a date or either flag, the existing local alarm-preserving behavior remains. Selection belongs to the target object. Enabled deletion removes persisted alarm state and cancels its armed timer; it does not interrupt an already-dispatched handler or implement abort/retry suppression. Application SQL-table deletion remains a separate compatibility gap.

**Accepted local shared-connection limit:** `deleteAll()` rejects before mutation whenever its SQLite connection has an open transaction. In-process objects can share that connection, so an external call to object B also rejects while object A's transaction is suspended, even though B did not start a transaction. This applies to both enabled and legacy alarm behavior. The conservative guard prevents scheduler cancellation from surviving a database rollback. It is a local limitation, not a claim that Cloudflare rejects independent objects' operations. Transactions on separate connections are not covered by this guard.

### Durable Object abort policy — approved F03b contract

The approved scope is ordinary Durable Objects. `abort(reason, { retryAlarm })` fixes its policy on the first abort. Omitted `retryAlarm` and `true` allow retry of an interrupted alarm; `false` suppresses that attempt's retry without deleting a newer scheduled alarm. The option is not compatibility-date gated. The released reference is workerd `v1.20261005.1`, `api/actor-state.c++:1225–1252` and `api/global-scope.c++:644–658`.

- Dedicated threads fence owned storage synchronously, send a typed abort control message, then main terminates the executor and rejects pending calls. Replacement waits for Bun's worker `close` event, not an elapsed timeout. Committed writes survive; open transactions are not flushed or committed during abort. A Bun 1.4.2 probe verified rollback and immediate write-lock acquisition after `close` for two SQLite connections, with both parked and spinning workers (five runs each).
- Unlike workerd's uncatchable execution termination, the local throw can be caught before main receives the abort signal. Captured storage, synchronous KV and SQL handles are fenced; native resources and external side effects cannot be retracted. Container-backed objects retain their previous cleanup-first lifecycle and are a separate follow-up.
- In-process execution is cooperative: pending callers reject, storage is fenced, and late handler results cannot succeed. Replacement waits for actual old handler and concurrency-block settlement. A never-settling handler can prevent replacement indefinitely; arbitrary JavaScript cannot be forcibly stopped in the shared isolate.
- Persisted per-object alarm revisions fence committed replacements/cancellations against stale timer notifications and attempt failures, including identical timestamps. Alarm notifications made within supported storage transactions publish only after commit. A cancellation retains its revision even without an alarm row.
- Revisions are not durable attempt recovery. Running attempts and retry counters are not persisted; the existing crash window after dispatch and the local backoff/retry ceiling remain. Abort teardown closes executor-owned traces and handles late trace inserts without ending unrelated invocations.

This bounded contract was explicitly approved separately from F03a. It does not authorize general eviction, object identity, socket behavior, Container termination, or durable attempt/retry recovery redesigns.

**Approved deletion precedence:** the running alarm's own deletion permits default/true abort retry, matching the cleanup sequence in the [released abort announcement](https://developers.cloudflare.com/changelog/post/2026-08-25-durable-object-alarm-abort-no-retry/). External cancellation or any replacement permanently supersedes that attempt; a later own deletion cannot revive it. An alarm's own replacement, including an identical timestamp, is not overwritten by its retry. `retryAlarm: false` always suppresses the interrupted attempt. Ownership follows the alarm handler's async context and is cleared at separate request/RPC dispatch, including another request to the same executor. Ordered committed mutation notifications carry ownership and the preceding revision; rolled-back mutations have no effect. Attempt ownership and supersession are in-memory/typed transport metadata only, not durable attempt recovery.

### WebSocket close reasons and callback ownership — F08a

`WebSocketPair` sockets enforce the **123 UTF-8-byte** close-reason bound with compatibility dates from `2026-03-03` or `websocket_close_reason_byte_limit`. `no_websocket_close_reason_byte_limit` disables it; explicit flags override dates. With neither a date nor an override, the existing unvalidated local behavior remains. The reference is released workerd [`v1.20261005.1`](https://github.com/cloudflare/workerd/blob/v1.20261005.1/src/workerd/api/web-socket.c++), `LegacyWebSocketAdapter::close`.

Oversized reasons throw a `DOMException` named `SyntaxError` before any ready-state early return, including repeated close calls. Failed validation does not change either socket's state or dispatch close events. This bounded change preserves the existing close handshake and close-code behavior.

Each socket captures its owning compatibility selection at construction. Dedicated user/DO/dynamic threads initialize an immutable isolate fallback before application import; same-process dispatch uses native compatibility ALS. Runtime-delivered message, close, error and open events enter the socket owner's scope for both EventTarget listeners and callback properties. Async descendants retain it, so scoped crypto and newly constructed pairs use the owner rather than the delivery caller. Queued events use the same delivery boundary. This does not add socket tracing lifetimes or scope native externalized module evaluation.

Local verification on Bun **1.4.2 (`744846f84`)** covers date/flag selection, ASCII/multibyte/surrogate boundaries, state preservation, repeated close, cross-scope method calls, queued events, overlapping bridge delivery, and two differently configured Vite servers. Real CLI and Vite upgrades cover ordinary Worker, standard DO and hibernation callbacks, including async crypto visibility and nested sockets. Existing binary echo and close tests pass. Binary selection is covered by F08b below; half-open/automatic-close semantics and network message limits remain F08 follow-ups. These results do not establish hosted parity or durable hibernation.

### WebSocket binary delivery — F08b

Application-facing `WebSocketPair` endpoints expose `binaryType` for both enabled and disabled selections. It defaults to `'blob'` from compatibility date `2026-03-17` or with `websocket_standard_binary_type`, and to `'arraybuffer'` before that date or with `no_websocket_standard_binary_type`. Explicit overrides take precedence. Both modes permit switching between those values; invalid strings leave the value unchanged. With no date and no override (`legacy-local`), the property remains absent and delivery remains ArrayBuffer; an application-created expando does not affect delivery.

This follows released workerd [`v1.20261005.1`, `web-socket.h:390–401`](https://github.com/cloudflare/workerd/blob/v1.20261005.1/src/workerd/api/web-socket.h#L390-L401) and [`web-socket.c++:1694–1704`](https://github.com/cloudflare/workerd/blob/v1.20261005.1/src/workerd/api/web-socket.c++#L1694-L1704). The release exposes the property even with the binary flag disabled, contrary to the historical-absence assumption in the earlier research. Lopata installs an own accessor for selected sockets; the separate workerd instance/prototype property flag is not implemented here.

Binary bytes become a Blob only when constructing an application `MessageEvent`, using the receiver's current selection at delivery time. Queued messages retain bytes; changing `binaryType` in one listener affects later messages, not that listener's already-created event. Text stays text. Listener and callback-property delivery share one event and retain F08a's captured owner scope.

Internal transport endpoints opt into raw delivery before acceptance or queue flushing. Bridge envelopes and queues remain `string | ArrayBuffer`, including adopted and reshipped endpoints; reconstructed application endpoints retain selected conversion. Hibernation handlers always receive ArrayBuffer regardless of the public property, matching [`global-scope.c++:897–916`](https://github.com/cloudflare/workerd/blob/v1.20261005.1/src/workerd/api/global-scope.c++#L897-L916). Hibernation acceptance wires its listeners before flushing queued messages. CLI/Vite ingress and pair ArrayBufferView sends copy only the selected view's offset and length.

Focused local verification on Bun **1.4.2 (`744846f84`)** covers date/flag/default selection, switching and invalid strings, empty/text/binary messages, queued conversion order and shared event identity, nonzero-offset Buffer/DataView/typed-array bytes, bridge/adoption/reconstruction boundaries, real CLI/Vite Worker and DO upgrades, hibernation's raw exception (including pre-accept messages), and overlapping opposite selections in two Vite servers. This is selected local delivery support, not full WebSocket or hosted conformance. Message-size limits and half-open/automatic-close behavior remain separate.

### Modern Web Crypto

Enable the new API in the Worker's Wrangler configuration:

```json
{
	"compatibility_flags": ["webcrypto_modern_algorithms"]
}
```

The opt-in API adds post-quantum key generation, import/export, ML-DSA signing and verification, and ML-KEM encapsulation and decapsulation. The key helpers produce native symmetric keys for use with existing Web Crypto operations. The flag also enables `crypto.subtle.getPublicKey()` and static `SubtleCrypto.supports()`.

The compatibility flag gates these APIs even on Bun 1.4.2, which provides native modern crypto. Without the flag, post-quantum operations remain unavailable. Enabling the flag uses Lopata's adapter. The original adapter was also verified on Bun 1.3.14 before the minimum runtime was raised; that historical result does not establish scoped-facade support on older Bun.

Existing classical algorithms continue to use Bun's native implementations. The post-quantum primitives use `@noble/post-quantum`; private key material is held separately from the public `CryptoKey` metadata.

**Post-quantum key limitation:** The adapter's key objects work with Lopata's crypto methods but do not carry Bun's native key brand. Native `CryptoKey` prototype getters reject them, and `structuredClone()` produces an empty object rather than a usable key. Do not send these key objects through worker messages or other structured-clone paths. This limitation was explicitly accepted for the original backport, whose Bun 1.3.14 probes could not create native ML-KEM/ML-DSA `CryptoKey` objects. Classical keys and symmetric keys produced by the encapsulation helpers remain native.

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

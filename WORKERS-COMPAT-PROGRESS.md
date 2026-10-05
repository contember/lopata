# Workers compatibility execution

Started October 5, 2026. The user approved the whole [backlog](WORKERS-COMPAT-BACKLOG.md), subagent implementation, separate branches/PRs, and pushes. Merging and publishing releases are not part of this run. Concrete architecture decisions remain approval-gated.

## Delivery rules

- Use stacked PRs, beginning at PR #31, with one independently reviewable unit per PR.
- Give implementers disjoint source/test territories. Shared seams land before dependent implementations.
- Independently review each diff, then run coordinator verification: focused behavior tests, typecheck, lint, formatting, and the full suite before publication. Run CPU-heavy checks under `cpu-lease`; use Bun 1.4.2 for the current CI-compatible baseline.
- Record exact PR/commit/check evidence. Implementation, already-supported behavior, and user-approved deferral are different dispositions.
- Preserve existing persisted data and runtime contracts. Ask before architecture, storage format, dependencies, or backend choices change.

## Current wave

The four units below and their boundaries were explicitly approved. They have no source dependencies on one another and use disjoint binding/test owners. Test execution and commits are coordinated centrally.

| Unit                 | Status       | Implementation boundary                                                                                                | Evidence                                                                                                                                          |
| -------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR #31 completion    | Pushed       | Mixed export parsing and cache invalidation                                                                            | Commits `2f1d444`, `87b84e6`, `3932998`; 1,905 tests passed, two existing skips; [verification](CLOUDFLARE-COMPATIBILITY.md#current-verification) |
| F02a Email           | Implementing | Send result IDs, named recipients, base64/binary MIME fidelity; preserve raw messages                                  | `src/bindings/email.ts`, dedicated Email tests/fixtures                                                                                           |
| F06c Hyperdrive      | Implementing | Binding-specific environment override; MySQL/PostgreSQL default ports                                                  | `src/bindings/hyperdrive.ts`, `stateless-env.ts`, dedicated tests/fixtures                                                                        |
| F13a AI transport    | Implementing | Native multipart transport and JSON `rejectIfBusy`; reject unsupported stream combinations rather than dropping inputs | `src/bindings/ai.ts`, dedicated AI tests/fixtures                                                                                                 |
| F19a Images response | Implementing | Synchronous `.response({ headers })` on output, including worker construction                                          | `src/bindings/images.ts`, dedicated Images tests/fixtures                                                                                         |

F02's recipient/attachment limits and size-accounting policy remain a separate pending F02b unit. Official sources distinguish 5 MiB general outbound and 25 MiB verified destinations; exact server size accounting is not established. F19a does not establish fallback image transformation fidelity.

## Remaining tracks

| Track                               | Current disposition / next step                                                                                                                                                               |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F01 Queue                           | JS timestamp contract resolved from released workerd `v1.20261005.1`: `Date \| undefined`; REST uses milliseconds/zero. Specify retention ownership and local pull versus account REST scope. |
| F02b Email limits                   | Decide size-accounting and verified-destination policy; confirm cc/bcc-only builder scope.                                                                                                    |
| F03 DO alarms                       | Specify compatibility selection with F09a, then alarm deletion and abort policy.                                                                                                              |
| F04 Workflow persistence            | Design occurrence identity, stream commits, old-data migration and cleanup before implementation.                                                                                             |
| F05 Tracing                         | Specify captured manual-span ownership, existing trace transport reuse, Vite singleton wiring and never-ended-span cleanup.                                                                   |
| F06a/b/d/e Config                   | Decide resource identity transition and secret precedence; probe SQL imports; specify migration discovery.                                                                                    |
| F07 Declarations/loopbacks          | Design legacy/declarative precedence and lifecycle. Basic Workflow wiring need not wait for F04.                                                                                              |
| F08 WebSockets                      | Probe actual network limits; coordinate selected modern/legacy semantics with F09a.                                                                                                           |
| F09 Compatibility/budgets           | Approve supported selection/default policy and invocation budget ownership; probe native behavior first.                                                                                      |
| F10 Workflow subscriptions/deletion | Design durable event/cursor and cancellation contracts alongside F04.                                                                                                                         |
| F11 Workflow policy                 | Choose local plan/default policy and schedules contract; preserve existing-instance defaults.                                                                                                 |
| F12 DO lifetime/identity            | Design pending-operation ownership and persisted ID/jurisdiction semantics.                                                                                                                   |
| F13b/c AI methods/Search            | Specify proxy contracts, multipart options, polling and handle results.                                                                                                                       |
| F14 Vite                            | Separate programmatic config from transform/child-environment graph design.                                                                                                                   |
| F15 Access                          | Establish complete simulated identity schema and non-HTTP propagation contract.                                                                                                               |
| F16 Dynamic Workers/facets          | Design capability identity/disposal, shared stream transport, egress, CPU feasibility and facet persistence.                                                                                  |
| F17 Browser                         | Design direct session API versus Puppeteer shim and local/proxy-backed action boundaries.                                                                                                     |
| F18 Containers/Sandbox              | Verify Docker prerequisites; design process streams, snapshots, outbound dispatch and pinned SDK acceptance.                                                                                  |
| F19b-g Products                     | Decide backend per product; reuse local Git/image/socket owners where applicable.                                                                                                             |
| F20 Discovery                       | Produce versioned application-path evidence and explicit disposition per candidate; do not equate discovery completion with implementation.                                                   |

## Research and contract decisions

- [Released Queue implementation](https://github.com/cloudflare/workerd/blob/v1.20261005.1/src/workerd/api/queue.h) resolves JS timestamp disagreement: optional `kj::Date`, with the upstream zero sentinel mapped to `undefined`.
- [Released Email definitions](https://github.com/cloudflare/workerd/blob/v1.20261005.1/types/defines/email.d.ts) return `EmailSendResult` for both raw and structured overloads. Service result IDs identify captured messages; they are not MIME `Message-ID` headers.
- [Released Images implementation](https://github.com/cloudflare/workerd/blob/v1.20261005.1/src/cloudflare/internal/images-api.ts) sets actual output Content-Type after merging caller headers.
- The first AI unit is explicitly limited to documented native multipart and JSON busy options. Multipart/Gateway and otherwise unsupported stream combinations must fail explicitly, matching established workerd restrictions; broader combinations require an evidenced transport contract.

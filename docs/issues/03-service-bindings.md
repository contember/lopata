# Service Bindings

Worker-to-worker communication via HTTP fetch and RPC.

## Wrangler config

```jsonc
"services": [
  { "binding": "OTHER_WORKER", "service": "other-worker-name", "entrypoint": "NamedEntrypoint" }
]
```

## API to implement

### HTTP mode

- `env.OTHER_WORKER.fetch(request | url, init?): Promise<Response>`

Calls the target worker's `fetch()` handler directly (in-process, no network).

### RPC mode

When the target worker extends `WorkerEntrypoint`, the binding is a Proxy stub:

- `env.OTHER_WORKER.myMethod(args)` — calls method on the target's entrypoint class
- Promise pipelining supported: `await env.OTHER_WORKER.getUser().getName()` resolves in chain

## Implementation notes

- For single-worker dev (most common case): service bindings that reference the **same** worker can loop back to the worker's own exports
- For multi-worker: would need a registry of loaded workers, but that's out of scope for now — log a warning if service name doesn't match current worker
- The binding object is a Proxy:
  - `.fetch()` calls the target's fetch handler with in-process Request/Response
  - Any other property access returns an async function that calls the method on the target's entrypoint class
- `entrypoint` config field: if specified, use the named export (which should extend `WorkerEntrypoint`) instead of the default export
- Add `WorkerEntrypoint` to the `cloudflare:workers` plugin exports (already partially done as empty class)

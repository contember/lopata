# Durable Objects: Miscellaneous missing APIs

Small gaps in the current DO implementation.

## blockConcurrencyWhile

```ts
ctx.blockConcurrencyWhile(async () => {
  await this.loadState();
});
```

- Typically called in constructor to initialize state before handling requests
- Execute the callback immediately and await it — defer any incoming RPC calls until it resolves
- Store a `ready` promise on the DO state; the proxy stub should `await` it before forwarding any method calls

## newUniqueId

```ts
const id = env.COUNTER.newUniqueId(options?);
// options: { jurisdiction?: "eu" | "fedramp" }
```

- Generate a unique random ID (not name-based)
- Use `crypto.randomUUID()` or similar
- `jurisdiction` is ignored in dev

## deleteAll

```ts
await this.ctx.storage.deleteAll(options?);
```

- Removes all keys from DO storage
- SQLite: `DELETE FROM do_storage WHERE namespace = ? AND id = ?`

## getByName

```ts
const stub = env.COUNTER.getByName("myCounter");
```

- Shorthand for `env.COUNTER.get(env.COUNTER.idFromName("myCounter"))`
- Returns the same proxy stub

## DurableObjectId properties

- `id.name: string | undefined` — the name if created via `idFromName()`
- `id.toString(): string` — hex string of the ID
- `id.equals(other: DurableObjectId): boolean` — compare two IDs

## Storage options parameter

Many storage methods accept `options?: { allowConcurrency?: boolean, allowUnconfirmed?: boolean, noCache?: boolean }`:
- All three are no-ops in dev (they control write durability and caching in production)

## Implementation notes

- These are all small additions to `runtime/bindings/durable-object.ts`
- `blockConcurrencyWhile`: add a `ready` promise to `DurableObjectStateImpl`, proxy stub awaits it
- `newUniqueId`: generate UUID, wrap in `DurableObjectIdImpl`
- `deleteAll`: delete from `do_storage` table
- `equals`: compare `.id` strings

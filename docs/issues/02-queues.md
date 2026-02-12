# Queues binding

SQLite-backed queue producer and consumer.

## Wrangler config

```jsonc
"queues": {
  "producers": [
    { "binding": "MY_QUEUE", "queue": "my-queue", "delivery_delay": 0 }
  ],
  "consumers": [
    { "queue": "my-queue", "max_batch_size": 10, "max_batch_timeout": 5, "max_retries": 3, "dead_letter_queue": "my-dlq" }
  ]
}
```

## API to implement

### Queue (producer binding)

- `send(message: unknown, options?): Promise<void>` — options: `{ contentType?: "json"|"text"|"bytes"|"v8", delaySeconds?: number }`
- `sendBatch(messages: { body: unknown, contentType?, delaySeconds? }[], options?): Promise<void>`

### Consumer handler

Worker exports `queue(batch, env, ctx)` handler:

```ts
async queue(batch: MessageBatch, env: Env, ctx: ExecutionContext): Promise<void>
```

### MessageBatch

- `queue: string` — queue name
- `messages: Message[]`
- `ackAll(): void`
- `retryAll(options?): void` — options: `{ delaySeconds?: number }`

### Message

- `id: string`
- `timestamp: Date`
- `body: unknown`
- `attempts: number`
- `ack(): void`
- `retry(options?): void` — options: `{ delaySeconds?: number }`

## Persistence

Uses the `queue_messages` table in `data.sqlite` (see issue 00).

- `send()` inserts row with `visible_at` = now + delay
- Background poll loop (e.g. every 1s) selects visible messages up to `max_batch_size`, calls worker's `queue()` handler
- `ack()` deletes the row
- `retry()` increments `attempts` and updates `visible_at`
- After `max_retries`, move to DLQ (insert into same table with different queue name) or log warning
- Messages survive restart — poll loop picks up unprocessed messages on next start

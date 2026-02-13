import { test, expect, beforeEach, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db";
import { SqliteQueueProducer, QueueConsumer } from "../bindings/queue";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

describe("SqliteQueueProducer", () => {
  let producer: SqliteQueueProducer;

  beforeEach(() => {
    producer = new SqliteQueueProducer(db, "test-queue");
  });

  test("send inserts a message into queue_messages", async () => {
    await producer.send({ hello: "world" });

    const rows = db.query<{ id: string; queue: string; body: Uint8Array; content_type: string; attempts: number }, []>(
      "SELECT id, queue, body, content_type, attempts FROM queue_messages"
    ).all();

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.queue).toBe("test-queue");
    expect(JSON.parse(new TextDecoder().decode(row.body))).toEqual({ hello: "world" });
    expect(row.content_type).toBe("json");
    expect(row.attempts).toBe(0);
  });

  test("send with text contentType stores as text", async () => {
    await producer.send("plain text", { contentType: "text" });

    const row = db.query<{ body: Uint8Array; content_type: string }, []>(
      "SELECT body, content_type FROM queue_messages"
    ).get()!;

    expect(new TextDecoder().decode(row.body)).toBe("plain text");
    expect(row.content_type).toBe("text");
  });

  test("send with bytes contentType stores ArrayBuffer", async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    await producer.send(data.buffer, { contentType: "bytes" });

    const row = db.query<{ body: Uint8Array; content_type: string }, []>(
      "SELECT body, content_type FROM queue_messages"
    ).get()!;

    expect(row.content_type).toBe("bytes");
    expect(new Uint8Array(row.body)).toEqual(data);
  });

  test("send with bytes contentType stores Uint8Array", async () => {
    const data = new Uint8Array([10, 20, 30]);
    await producer.send(data, { contentType: "bytes" });

    const row = db.query<{ body: Uint8Array; content_type: string }, []>(
      "SELECT body, content_type FROM queue_messages"
    ).get()!;

    expect(new Uint8Array(row.body)).toEqual(data);
  });

  test("send with v8 contentType stores structured data", async () => {
    const data = { nested: { array: [1, 2, 3] } };
    await producer.send(data, { contentType: "v8" });

    const row = db.query<{ body: Uint8Array; content_type: string }, []>(
      "SELECT body, content_type FROM queue_messages"
    ).get()!;

    expect(row.content_type).toBe("v8");
    expect(JSON.parse(new TextDecoder().decode(row.body))).toEqual(data);
  });

  test("send with delaySeconds sets future visible_at", async () => {
    const before = Date.now();
    await producer.send("delayed", { delaySeconds: 10 });

    const row = db.query<{ visible_at: number }, []>(
      "SELECT visible_at FROM queue_messages"
    ).get()!;

    expect(row.visible_at).toBeGreaterThanOrEqual(before + 10000);
  });

  test("send with default delivery_delay", async () => {
    const delayedProducer = new SqliteQueueProducer(db, "test-queue", 5);
    const before = Date.now();
    await delayedProducer.send("msg");

    const row = db.query<{ visible_at: number }, []>(
      "SELECT visible_at FROM queue_messages"
    ).get()!;

    expect(row.visible_at).toBeGreaterThanOrEqual(before + 5000);
  });

  test("sendBatch inserts multiple messages", async () => {
    await producer.sendBatch([
      { body: { id: 1 } },
      { body: { id: 2 } },
      { body: { id: 3 } },
    ]);

    const count = db.query<{ cnt: number }, []>(
      "SELECT COUNT(*) as cnt FROM queue_messages"
    ).get()!;

    expect(count.cnt).toBe(3);
  });

  test("sendBatch with per-message delay", async () => {
    const before = Date.now();
    await producer.sendBatch([
      { body: "fast", delaySeconds: 0 },
      { body: "slow", delaySeconds: 30 },
    ]);

    const rows = db.query<{ body: Uint8Array; visible_at: number }, []>(
      "SELECT body, visible_at FROM queue_messages ORDER BY visible_at"
    ).all();

    expect(rows[0]!.visible_at).toBeLessThan(before + 1000);
    expect(rows[1]!.visible_at).toBeGreaterThanOrEqual(before + 30000);
  });

  test("messages are isolated by queue name", async () => {
    const other = new SqliteQueueProducer(db, "other-queue");
    await producer.send("msg1");
    await other.send("msg2");

    const testRows = db.query<{ body: Uint8Array }, [string]>(
      "SELECT body FROM queue_messages WHERE queue = ?"
    ).all("test-queue");

    const otherRows = db.query<{ body: Uint8Array }, [string]>(
      "SELECT body FROM queue_messages WHERE queue = ?"
    ).all("other-queue");

    expect(testRows).toHaveLength(1);
    expect(otherRows).toHaveLength(1);
  });

  test("send rejects message exceeding max size", async () => {
    const smallProducer = new SqliteQueueProducer(db, "test-queue", 0, { maxMessageSize: 10 });
    await expect(smallProducer.send("this message is way too long for the limit")).rejects.toThrow("max size");
  });

  test("send rejects invalid delaySeconds", async () => {
    await expect(producer.send("msg", { delaySeconds: -1 })).rejects.toThrow("delaySeconds");
    await expect(producer.send("msg", { delaySeconds: 50000 })).rejects.toThrow("delaySeconds");
  });

  test("sendBatch rejects too many messages", async () => {
    const smallProducer = new SqliteQueueProducer(db, "test-queue", 0, { maxBatchMessages: 2 });
    await expect(smallProducer.sendBatch([
      { body: "a" }, { body: "b" }, { body: "c" },
    ])).rejects.toThrow("max message count");
  });

  test("sendBatch rejects batch exceeding max total size", async () => {
    const smallProducer = new SqliteQueueProducer(db, "test-queue", 0, { maxBatchSize: 10 });
    await expect(smallProducer.sendBatch([
      { body: "aaaaaaaaaa" },
      { body: "bbbbbbbbbb" },
    ])).rejects.toThrow("max total size");
  });

  test("bytes contentType rejects non-buffer types", async () => {
    await expect(producer.send("not a buffer", { contentType: "bytes" })).rejects.toThrow("ArrayBuffer or Uint8Array");
  });
});

describe("QueueConsumer", () => {
  let producer: SqliteQueueProducer;

  beforeEach(() => {
    producer = new SqliteQueueProducer(db, "test-queue");
  });

  test("poll delivers messages and auto-acks", async () => {
    await producer.send({ key: "value" });

    const received: unknown[] = [];
    const consumer = new QueueConsumer(
      db,
      { queue: "test-queue", maxBatchSize: 10, maxBatchTimeout: 5, maxRetries: 3, deadLetterQueue: null },
      async (batch) => {
        for (const msg of batch.messages) {
          received.push(msg.body);
        }
        // No explicit ack — default is ack
      },
      {},
    );

    await consumer.poll();

    expect(received).toEqual([{ key: "value" }]);
    // Message should be deleted (auto-acked)
    const count = db.query<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM queue_messages").get()!;
    expect(count.cnt).toBe(0);
  });

  test("poll delivers bytes content correctly", async () => {
    const data = new Uint8Array([42, 43, 44]);
    await producer.send(data, { contentType: "bytes" });

    let receivedBody: unknown = null;
    const consumer = new QueueConsumer(
      db,
      { queue: "test-queue", maxBatchSize: 10, maxBatchTimeout: 5, maxRetries: 3, deadLetterQueue: null },
      async (batch) => {
        receivedBody = batch.messages[0]!.body;
      },
      {},
    );

    await consumer.poll();
    expect(receivedBody).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(receivedBody as ArrayBuffer)).toEqual(data);
  });

  test("poll delivers text content correctly", async () => {
    await producer.send("hello text", { contentType: "text" });

    let receivedBody: unknown = null;
    const consumer = new QueueConsumer(
      db,
      { queue: "test-queue", maxBatchSize: 10, maxBatchTimeout: 5, maxRetries: 3, deadLetterQueue: null },
      async (batch) => {
        receivedBody = batch.messages[0]!.body;
      },
      {},
    );

    await consumer.poll();
    expect(receivedBody).toBe("hello text");
  });

  test("poll delivers v8 content correctly", async () => {
    await producer.send({ complex: [1, 2] }, { contentType: "v8" });

    let receivedBody: unknown = null;
    const consumer = new QueueConsumer(
      db,
      { queue: "test-queue", maxBatchSize: 10, maxBatchTimeout: 5, maxRetries: 3, deadLetterQueue: null },
      async (batch) => {
        receivedBody = batch.messages[0]!.body;
      },
      {},
    );

    await consumer.poll();
    expect(receivedBody).toEqual({ complex: [1, 2] });
  });

  test("poll respects maxBatchSize", async () => {
    for (let i = 0; i < 5; i++) {
      await producer.send({ i });
    }

    let batchSize = 0;
    const consumer = new QueueConsumer(
      db,
      { queue: "test-queue", maxBatchSize: 3, maxBatchTimeout: 5, maxRetries: 3, deadLetterQueue: null },
      async (batch) => {
        batchSize = batch.messages.length;
        batch.ackAll();
      },
      {},
    );

    await consumer.poll();
    expect(batchSize).toBe(3);

    // 2 remaining
    const count = db.query<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM queue_messages").get()!;
    expect(count.cnt).toBe(2);
  });

  test("ackAll deletes all messages in batch", async () => {
    await producer.send("a");
    await producer.send("b");

    const consumer = new QueueConsumer(
      db,
      { queue: "test-queue", maxBatchSize: 10, maxBatchTimeout: 5, maxRetries: 3, deadLetterQueue: null },
      async (batch) => {
        batch.ackAll();
      },
      {},
    );

    await consumer.poll();

    const count = db.query<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM queue_messages").get()!;
    expect(count.cnt).toBe(0);
  });

  test("individual ack deletes specific message", async () => {
    await producer.send("keep");
    await producer.send("remove");

    const consumer = new QueueConsumer(
      db,
      { queue: "test-queue", maxBatchSize: 10, maxBatchTimeout: 5, maxRetries: 3, deadLetterQueue: null },
      async (batch) => {
        for (const msg of batch.messages) {
          if (msg.body === "remove") {
            msg.ack();
          } else {
            msg.retry();
          }
        }
      },
      {},
    );

    await consumer.poll();

    const rows = db.query<{ body: Uint8Array }, []>("SELECT body FROM queue_messages").all();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(new TextDecoder().decode(rows[0]!.body))).toBe("keep");
  });

  test("retry increments attempts and keeps message", async () => {
    await producer.send("retry-me");

    const consumer = new QueueConsumer(
      db,
      { queue: "test-queue", maxBatchSize: 10, maxBatchTimeout: 5, maxRetries: 3, deadLetterQueue: null },
      async (batch) => {
        for (const msg of batch.messages) {
          msg.retry();
        }
      },
      {},
    );

    await consumer.poll();

    const row = db.query<{ attempts: number }, []>("SELECT attempts FROM queue_messages").get()!;
    expect(row.attempts).toBe(1);
  });

  test("retry with delay updates visible_at", async () => {
    await producer.send("delayed-retry");

    const consumer = new QueueConsumer(
      db,
      { queue: "test-queue", maxBatchSize: 10, maxBatchTimeout: 5, maxRetries: 3, deadLetterQueue: null },
      async (batch) => {
        batch.retryAll({ delaySeconds: 60 });
      },
      {},
    );

    const before = Date.now();
    await consumer.poll();

    const row = db.query<{ visible_at: number }, []>("SELECT visible_at FROM queue_messages").get()!;
    expect(row.visible_at).toBeGreaterThanOrEqual(before + 60000);
  });

  test("message not visible until visible_at", async () => {
    await producer.send("future", { delaySeconds: 9999 });

    let called = false;
    const consumer = new QueueConsumer(
      db,
      { queue: "test-queue", maxBatchSize: 10, maxBatchTimeout: 5, maxRetries: 3, deadLetterQueue: null },
      async () => { called = true; },
      {},
    );

    await consumer.poll();
    expect(called).toBe(false);
  });

  test("max retries exceeded discards message without DLQ", async () => {
    await producer.send("will-fail");

    const consumer = new QueueConsumer(
      db,
      { queue: "test-queue", maxBatchSize: 10, maxBatchTimeout: 5, maxRetries: 2, deadLetterQueue: null },
      async (batch) => {
        batch.retryAll();
      },
      {},
    );

    // First poll: attempts becomes 1
    await consumer.poll();
    // Second poll: attempts becomes 2 (== maxRetries), should be discarded
    await consumer.poll();

    const count = db.query<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM queue_messages").get()!;
    expect(count.cnt).toBe(0);
  });

  test("max retries exceeded moves to DLQ", async () => {
    await producer.send("will-dlq");

    const consumer = new QueueConsumer(
      db,
      { queue: "test-queue", maxBatchSize: 10, maxBatchTimeout: 5, maxRetries: 1, deadLetterQueue: "my-dlq" },
      async (batch) => {
        batch.retryAll();
      },
      {},
    );

    await consumer.poll();

    // Original queue should be empty
    const testCount = db.query<{ cnt: number }, [string]>(
      "SELECT COUNT(*) as cnt FROM queue_messages WHERE queue = ?"
    ).get("test-queue")!;
    expect(testCount.cnt).toBe(0);

    // DLQ should have the message
    const dlqRows = db.query<{ body: Uint8Array }, [string]>(
      "SELECT body FROM queue_messages WHERE queue = ?"
    ).all("my-dlq");
    expect(dlqRows).toHaveLength(1);
    expect(JSON.parse(new TextDecoder().decode(dlqRows[0]!.body))).toBe("will-dlq");
  });

  test("handler error triggers retry for all messages", async () => {
    await producer.send("error-msg");

    const consumer = new QueueConsumer(
      db,
      { queue: "test-queue", maxBatchSize: 10, maxBatchTimeout: 5, maxRetries: 3, deadLetterQueue: null },
      async () => {
        throw new Error("handler crash");
      },
      {},
    );

    await consumer.poll();

    // Message should still exist with incremented attempts
    const row = db.query<{ attempts: number }, []>("SELECT attempts FROM queue_messages").get()!;
    expect(row.attempts).toBe(1);
  });

  test("message.attempts is 0 on first delivery (CF behavior)", async () => {
    await producer.send("count-attempts");

    const attemptsSeen: number[] = [];
    const consumer = new QueueConsumer(
      db,
      { queue: "test-queue", maxBatchSize: 10, maxBatchTimeout: 5, maxRetries: 5, deadLetterQueue: null },
      async (batch) => {
        attemptsSeen.push(batch.messages[0]!.attempts);
        batch.retryAll();
      },
      {},
    );

    await consumer.poll();
    await consumer.poll();
    await consumer.poll();

    expect(attemptsSeen).toEqual([0, 1, 2]);
  });

  test("batch.queue contains the queue name", async () => {
    await producer.send("check-name");

    let queueName = "";
    const consumer = new QueueConsumer(
      db,
      { queue: "test-queue", maxBatchSize: 10, maxBatchTimeout: 5, maxRetries: 3, deadLetterQueue: null },
      async (batch) => {
        queueName = batch.queue;
      },
      {},
    );

    await consumer.poll();
    expect(queueName).toBe("test-queue");
  });

  test("messages persist across producer/consumer instances", async () => {
    // Send with one producer instance
    const producer1 = new SqliteQueueProducer(db, "persist-queue");
    await producer1.send({ persisted: true });

    // Consume with new consumer instance
    const received: unknown[] = [];
    const consumer = new QueueConsumer(
      db,
      { queue: "persist-queue", maxBatchSize: 10, maxBatchTimeout: 5, maxRetries: 3, deadLetterQueue: null },
      async (batch) => {
        for (const msg of batch.messages) {
          received.push(msg.body);
        }
      },
      {},
    );

    await consumer.poll();
    expect(received).toEqual([{ persisted: true }]);
  });

  test("empty queue does not call handler", async () => {
    let called = false;
    const consumer = new QueueConsumer(
      db,
      { queue: "test-queue", maxBatchSize: 10, maxBatchTimeout: 5, maxRetries: 3, deadLetterQueue: null },
      async () => { called = true; },
      {},
    );

    await consumer.poll();
    expect(called).toBe(false);
  });

  test("ctx.waitUntil tracks promises", async () => {
    await producer.send("wait-test");
    let resolved = false;

    const consumer = new QueueConsumer(
      db,
      { queue: "test-queue", maxBatchSize: 10, maxBatchTimeout: 5, maxRetries: 3, deadLetterQueue: null },
      async (_batch, _env, ctx) => {
        ctx.waitUntil(new Promise<void>((resolve) => {
          setTimeout(() => { resolved = true; resolve(); }, 10);
        }));
      },
      {},
    );

    await consumer.poll();
    // waitUntil promise should have been awaited
    expect(resolved).toBe(true);
  });
});

import type { Database } from "bun:sqlite";
import { randomUUIDv7 } from "bun";

// --- Types ---

interface SendOptions {
  contentType?: "json" | "text" | "bytes" | "v8";
  delaySeconds?: number;
}

interface BatchMessage {
  body: unknown;
  contentType?: "json" | "text" | "bytes" | "v8";
  delaySeconds?: number;
}

interface Message {
  id: string;
  timestamp: Date;
  body: unknown;
  attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

interface MessageBatch {
  queue: string;
  messages: Message[];
  ackAll(): void;
  retryAll(options?: { delaySeconds?: number }): void;
}

interface ConsumerConfig {
  queue: string;
  maxBatchSize: number;
  maxBatchTimeout: number;
  maxRetries: number;
  deadLetterQueue: string | null;
}

type QueueHandler = (batch: MessageBatch, env: Record<string, unknown>, ctx: { waitUntil(p: Promise<unknown>): void }) => Promise<void>;

// --- Producer ---

export class SqliteQueueProducer {
  private db: Database;
  private queueName: string;
  private defaultDelay: number;

  constructor(db: Database, queueName: string, defaultDelay: number = 0) {
    this.db = db;
    this.queueName = queueName;
    this.defaultDelay = defaultDelay;
  }

  async send(message: unknown, options?: SendOptions): Promise<void> {
    const contentType = options?.contentType ?? "json";
    const delaySeconds = options?.delaySeconds ?? this.defaultDelay;
    const now = Date.now();
    const visibleAt = now + delaySeconds * 1000;

    const body = contentType === "json" ? JSON.stringify(message) : String(message);

    this.db.run(
      "INSERT INTO queue_messages (id, queue, body, content_type, attempts, visible_at, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
      [randomUUIDv7(), this.queueName, body, contentType, visibleAt, now],
    );
  }

  async sendBatch(messages: BatchMessage[], options?: SendOptions): Promise<void> {
    const stmt = this.db.prepare(
      "INSERT INTO queue_messages (id, queue, body, content_type, attempts, visible_at, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
    );
    const now = Date.now();
    const tx = this.db.transaction(() => {
      for (const msg of messages) {
        const contentType = msg.contentType ?? options?.contentType ?? "json";
        const delaySeconds = msg.delaySeconds ?? options?.delaySeconds ?? this.defaultDelay;
        const visibleAt = now + delaySeconds * 1000;
        const body = contentType === "json" ? JSON.stringify(msg.body) : String(msg.body);
        stmt.run(randomUUIDv7(), this.queueName, body, contentType, visibleAt, now);
      }
    });
    tx();
  }
}

// --- Consumer (poll loop) ---

export class QueueConsumer {
  private db: Database;
  private config: ConsumerConfig;
  private handler: QueueHandler;
  private env: Record<string, unknown>;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    db: Database,
    config: ConsumerConfig,
    handler: QueueHandler,
    env: Record<string, unknown>,
  ) {
    this.db = db;
    this.config = config;
    this.handler = handler;
    this.env = env;
  }

  start(intervalMs: number = 1000): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), intervalMs);
    // Run first poll immediately
    this.poll();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async poll(): Promise<void> {
    const now = Date.now();
    const rows = this.db.query<
      { id: string; body: string; content_type: string; attempts: number; created_at: number },
      [string, number, number]
    >(
      "SELECT id, body, content_type, attempts, created_at FROM queue_messages WHERE queue = ? AND visible_at <= ? ORDER BY visible_at LIMIT ?",
    ).all(this.config.queue, now, this.config.maxBatchSize);

    if (rows.length === 0) return;

    // Increment attempts for all fetched messages
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    this.db.run(`UPDATE queue_messages SET attempts = attempts + 1 WHERE id IN (${placeholders})`, ids);

    // Track per-message ack/retry state
    const acked = new Set<string>();
    const retried = new Map<string, number | undefined>(); // id -> delaySeconds
    let allAcked = false;
    let allRetried = false;
    let allRetryDelay: number | undefined;

    const messages: Message[] = rows.map((row) => {
      const body = row.content_type === "json" ? JSON.parse(row.body) : row.body;
      return {
        id: row.id,
        timestamp: new Date(row.created_at),
        body,
        attempts: row.attempts + 1, // reflects the current attempt
        ack() {
          acked.add(row.id);
        },
        retry(options?: { delaySeconds?: number }) {
          retried.set(row.id, options?.delaySeconds);
        },
      };
    });

    const batch: MessageBatch = {
      queue: this.config.queue,
      messages,
      ackAll() {
        allAcked = true;
      },
      retryAll(options?: { delaySeconds?: number }) {
        allRetried = true;
        allRetryDelay = options?.delaySeconds;
      },
    };

    const ctx = { waitUntil(_p: Promise<unknown>) {} };

    try {
      await this.handler(batch, this.env, ctx);
    } catch (err) {
      console.error(`[bunflare] Queue consumer error (${this.config.queue}):`, err);
      // On handler error, retry all messages
      allRetried = true;
    }

    // Process message outcomes
    for (const row of rows) {
      const currentAttempts = row.attempts + 1;
      if (allAcked || acked.has(row.id)) {
        // Delete acknowledged message
        this.db.run("DELETE FROM queue_messages WHERE id = ?", [row.id]);
      } else if (allRetried || retried.has(row.id)) {
        const delay = retried.get(row.id) ?? allRetryDelay ?? 0;
        if (currentAttempts >= this.config.maxRetries) {
          // Max retries exceeded — move to DLQ or delete
          if (this.config.deadLetterQueue) {
            this.db.run(
              "UPDATE queue_messages SET queue = ?, visible_at = ? WHERE id = ?",
              [this.config.deadLetterQueue, Date.now(), row.id],
            );
          } else {
            console.warn(`[bunflare] Queue message ${row.id} exceeded max retries (${this.config.maxRetries}), discarding`);
            this.db.run("DELETE FROM queue_messages WHERE id = ?", [row.id]);
          }
        } else {
          // Retry with delay
          this.db.run(
            "UPDATE queue_messages SET visible_at = ? WHERE id = ?",
            [Date.now() + delay * 1000, row.id],
          );
        }
      } else {
        // No explicit ack or retry — default is ack (matching CF behavior)
        this.db.run("DELETE FROM queue_messages WHERE id = ?", [row.id]);
      }
    }
  }
}

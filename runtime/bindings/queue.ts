import type { Database } from "bun:sqlite";
import { randomUUIDv7 } from "bun";
import { ExecutionContext } from "../execution-context";

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
  readonly queue: string;
  readonly messages: readonly Message[];
  ackAll(): void;
  retryAll(options?: { delaySeconds?: number }): void;
}

interface ConsumerConfig {
  queue: string;
  maxBatchSize: number;
  maxBatchTimeout: number;
  maxRetries: number;
  deadLetterQueue: string | null;
  retentionPeriodSeconds?: number; // default 345600 (4 days), matching CF default
}

type QueueHandler = (batch: MessageBatch, env: Record<string, unknown>, ctx: ExecutionContext) => Promise<void>;

// --- Limits ---

export interface QueueLimits {
  maxMessageSize?: number;     // default 128 * 1024 (128 KB)
  maxBatchMessages?: number;   // default 100
  maxBatchSize?: number;       // default 256 * 1024 (256 KB)
  maxDelaySeconds?: number;    // default 43200 (12 hours)
}

const QUEUE_DEFAULTS: Required<QueueLimits> = {
  maxMessageSize: 128 * 1024,
  maxBatchMessages: 100,
  maxBatchSize: 256 * 1024,
  maxDelaySeconds: 43200,
};

// --- Encoding / Decoding ---

function encodeBody(message: unknown, contentType: string): Uint8Array {
  switch (contentType) {
    case "bytes": {
      if (message instanceof ArrayBuffer) {
        return new Uint8Array(message);
      }
      if (message instanceof Uint8Array) {
        return message;
      }
      if (ArrayBuffer.isView(message)) {
        return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
      }
      throw new Error("bytes content type requires ArrayBuffer or Uint8Array");
    }
    case "text":
      return new TextEncoder().encode(String(message));
    case "v8":
      // Use JSON serialization as a v8-structured-clone approximation
      return new TextEncoder().encode(JSON.stringify(message));
    case "json":
    default:
      return new TextEncoder().encode(JSON.stringify(message));
  }
}

function decodeBody(raw: Uint8Array | Buffer, contentType: string): unknown {
  switch (contentType) {
    case "bytes":
      return raw instanceof Uint8Array ? raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) : new Uint8Array(raw).buffer;
    case "text":
      return new TextDecoder().decode(raw);
    case "v8":
      return JSON.parse(new TextDecoder().decode(raw));
    case "json":
    default:
      return JSON.parse(new TextDecoder().decode(raw));
  }
}

// --- Producer ---

export class SqliteQueueProducer {
  private db: Database;
  private queueName: string;
  private defaultDelay: number;
  private limits: Required<QueueLimits>;

  constructor(db: Database, queueName: string, defaultDelay: number = 0, limits?: QueueLimits) {
    this.db = db;
    this.queueName = queueName;
    this.defaultDelay = defaultDelay;
    this.limits = { ...QUEUE_DEFAULTS, ...limits };
  }

  async send(message: unknown, options?: SendOptions): Promise<void> {
    const contentType = options?.contentType ?? "json";
    const delaySeconds = options?.delaySeconds ?? this.defaultDelay;

    if (delaySeconds < 0 || delaySeconds > this.limits.maxDelaySeconds) {
      throw new Error(`delaySeconds must be between 0 and ${this.limits.maxDelaySeconds}`);
    }

    const encoded = encodeBody(message, contentType);

    if (encoded.byteLength > this.limits.maxMessageSize) {
      throw new Error(`Message exceeds max size of ${this.limits.maxMessageSize} bytes`);
    }

    const now = Date.now();
    const visibleAt = now + delaySeconds * 1000;

    this.db.run(
      "INSERT INTO queue_messages (id, queue, body, content_type, attempts, visible_at, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
      [randomUUIDv7(), this.queueName, encoded, contentType, visibleAt, now],
    );
  }

  async sendBatch(messages: BatchMessage[], options?: SendOptions): Promise<void> {
    if (messages.length > this.limits.maxBatchMessages) {
      throw new Error(`Batch exceeds max message count of ${this.limits.maxBatchMessages}`);
    }

    const stmt = this.db.prepare(
      "INSERT INTO queue_messages (id, queue, body, content_type, attempts, visible_at, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
    );
    const now = Date.now();

    // Pre-encode all messages and validate total size
    const encoded: { data: Uint8Array; contentType: string; delaySeconds: number }[] = [];
    let totalSize = 0;

    for (const msg of messages) {
      const contentType = msg.contentType ?? options?.contentType ?? "json";
      const delaySeconds = msg.delaySeconds ?? options?.delaySeconds ?? this.defaultDelay;

      if (delaySeconds < 0 || delaySeconds > this.limits.maxDelaySeconds) {
        throw new Error(`delaySeconds must be between 0 and ${this.limits.maxDelaySeconds}`);
      }

      const data = encodeBody(msg.body, contentType);

      if (data.byteLength > this.limits.maxMessageSize) {
        throw new Error(`Message exceeds max size of ${this.limits.maxMessageSize} bytes`);
      }

      totalSize += data.byteLength;
      encoded.push({ data, contentType, delaySeconds });
    }

    if (totalSize > this.limits.maxBatchSize) {
      throw new Error(`Batch exceeds max total size of ${this.limits.maxBatchSize} bytes`);
    }

    const tx = this.db.transaction(() => {
      for (const { data, contentType, delaySeconds } of encoded) {
        const visibleAt = now + delaySeconds * 1000;
        stmt.run(randomUUIDv7(), this.queueName, data, contentType, visibleAt, now);
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
  private batchBuffer: { id: string; body: Uint8Array | Buffer; content_type: string; attempts: number; created_at: number }[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;

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
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
  }

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const now = Date.now();

      // Periodically clean up expired messages beyond retention period
      const retentionMs = (this.config.retentionPeriodSeconds ?? 345600) * 1000;
      this.db.run(
        "DELETE FROM queue_messages WHERE queue = ? AND created_at < ?",
        [this.config.queue, now - retentionMs],
      );

      const rows = this.db.query<
        { id: string; body: Uint8Array | Buffer; content_type: string; attempts: number; created_at: number },
        [string, number, number]
      >(
        "SELECT id, body, content_type, attempts, created_at FROM queue_messages WHERE queue = ? AND visible_at <= ? ORDER BY visible_at LIMIT ?",
      ).all(this.config.queue, now, this.config.maxBatchSize);

      if (rows.length === 0) return;

      await this.deliverBatch(rows);
    } finally {
      this.polling = false;
    }
  }

  private async deliverBatch(rows: { id: string; body: Uint8Array | Buffer; content_type: string; attempts: number; created_at: number }[]): Promise<void> {
    // Increment attempts for all fetched messages
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    this.db.run(`UPDATE queue_messages SET attempts = attempts + 1 WHERE id IN (${placeholders})`, ids);

    // Track per-message decisions — last call wins (matching CF behavior)
    type Decision = { type: 'ack' } | { type: 'retry'; delaySeconds: number | undefined };
    const messageDecisions = new Map<string, Decision>();
    let batchDecision: Decision | null = null;

    const messages: Message[] = rows.map((row) => {
      const body = decodeBody(row.body, row.content_type);
      return {
        id: row.id,
        timestamp: new Date(row.created_at),
        body,
        attempts: row.attempts + 1, // CF behavior: starts at 1 on first delivery
        ack() {
          messageDecisions.set(row.id, { type: 'ack' });
        },
        retry(options?: { delaySeconds?: number }) {
          messageDecisions.set(row.id, { type: 'retry', delaySeconds: options?.delaySeconds });
        },
      };
    });

    const batch: MessageBatch = {
      queue: this.config.queue,
      messages,
      ackAll() {
        batchDecision = { type: 'ack' };
      },
      retryAll(options?: { delaySeconds?: number }) {
        batchDecision = { type: 'retry', delaySeconds: options?.delaySeconds };
      },
    };

    const ctx = new ExecutionContext();

    let handlerError = false;
    try {
      await this.handler(batch, this.env, ctx);
    } catch (err) {
      console.error(`[bunflare] Queue consumer error (${this.config.queue}):`, err);
      // On handler error, retry all messages
      handlerError = true;
    }

    // Wait for all waitUntil promises to settle (best-effort)
    await ctx._awaitAll();

    // Process message outcomes — per-message decision overrides batch decision
    for (const row of rows) {
      const currentAttempts = row.attempts + 1;
      const decision: Decision | null = handlerError
        ? { type: 'retry', delaySeconds: undefined }
        : messageDecisions.get(row.id) ?? batchDecision;

      if (!decision || decision.type === 'ack') {
        // Ack (explicit or default) — delete message
        this.db.run("DELETE FROM queue_messages WHERE id = ?", [row.id]);
      } else {
        // Retry
        const delay = decision.delaySeconds ?? 0;
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
      }
    }
  }
}

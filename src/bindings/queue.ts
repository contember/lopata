import { randomUUIDv7 } from 'bun'
import type { Database } from 'bun:sqlite'
import crypto from 'node:crypto'
import { ExecutionContext } from '../execution-context'
import { persistError, startSpan } from '../tracing/span'

// --- Types ---

interface SendOptions {
	contentType?: 'json' | 'text' | 'bytes' | 'v8'
	delaySeconds?: number
}

interface BatchMessage {
	body: unknown
	contentType?: 'json' | 'text' | 'bytes' | 'v8'
	delaySeconds?: number
}

interface Message {
	id: string
	timestamp: Date
	body: unknown
	attempts: number
	ack(): void
	retry(options?: { delaySeconds?: number }): void
}

interface MessageBatch {
	readonly queue: string
	readonly messages: readonly Message[]
	ackAll(): void
	retryAll(options?: { delaySeconds?: number }): void
}

interface ConsumerConfig {
	queue: string
	maxBatchSize: number
	maxBatchTimeout: number
	maxRetries: number
	deadLetterQueue: string | null
	retentionPeriodSeconds?: number // default 345600 (4 days), matching CF default
}

type QueueHandler = (batch: MessageBatch, env: Record<string, unknown>, ctx: ExecutionContext) => Promise<void>

// --- Limits ---

export interface QueueLimits {
	maxMessageSize?: number // default 128 * 1024 (128 KB)
	maxBatchMessages?: number // default 100
	maxBatchSize?: number // default 256 * 1024 (256 KB)
	maxDelaySeconds?: number // default 43200 (12 hours)
}

const QUEUE_DEFAULTS: Required<QueueLimits> = {
	maxMessageSize: 128 * 1024,
	maxBatchMessages: 100,
	maxBatchSize: 256 * 1024,
	maxDelaySeconds: 43200,
}

// --- Encoding / Decoding ---

function encodeBody(message: unknown, contentType: string): Uint8Array {
	switch (contentType) {
		case 'bytes': {
			if (message instanceof ArrayBuffer) {
				return new Uint8Array(message)
			}
			if (message instanceof Uint8Array) {
				return message
			}
			if (ArrayBuffer.isView(message)) {
				return new Uint8Array(message.buffer, message.byteOffset, message.byteLength)
			}
			throw new Error('bytes content type requires ArrayBuffer or Uint8Array')
		}
		case 'text':
			return new TextEncoder().encode(String(message))
		case 'v8':
			// Use JSON serialization as a v8-structured-clone approximation
			return new TextEncoder().encode(JSON.stringify(message))
		default:
			return new TextEncoder().encode(JSON.stringify(message))
	}
}

function decodeBody(raw: Uint8Array | Buffer, contentType: string): unknown {
	switch (contentType) {
		case 'bytes':
			return raw instanceof Uint8Array ? raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) : new Uint8Array(raw).buffer
		case 'text':
			return new TextDecoder().decode(raw)
		case 'v8':
			return JSON.parse(new TextDecoder().decode(raw))
		default:
			return JSON.parse(new TextDecoder().decode(raw))
	}
}

// --- Producer ---

export class SqliteQueueProducer {
	private db: Database
	private queueName: string
	private defaultDelay: number
	private limits: Required<QueueLimits>

	constructor(db: Database, queueName: string, defaultDelay: number = 0, limits?: QueueLimits) {
		this.db = db
		this.queueName = queueName
		this.defaultDelay = defaultDelay
		this.limits = { ...QUEUE_DEFAULTS, ...limits }
	}

	async send(message: unknown, options?: SendOptions): Promise<void> {
		const contentType = options?.contentType ?? 'json'
		const delaySeconds = options?.delaySeconds ?? this.defaultDelay

		if (delaySeconds < 0 || delaySeconds > this.limits.maxDelaySeconds) {
			throw new Error(`delaySeconds must be between 0 and ${this.limits.maxDelaySeconds}`)
		}

		const encoded = encodeBody(message, contentType)

		if (encoded.byteLength > this.limits.maxMessageSize) {
			throw new Error(`Message exceeds max size of ${this.limits.maxMessageSize} bytes`)
		}

		const now = Date.now()
		const visibleAt = now + delaySeconds * 1000

		this.db.run(
			'INSERT INTO queue_messages (id, queue, body, content_type, attempts, visible_at, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
			[randomUUIDv7(), this.queueName, encoded, contentType, visibleAt, now],
		)
	}

	async sendBatch(messages: BatchMessage[], options?: SendOptions): Promise<void> {
		if (messages.length > this.limits.maxBatchMessages) {
			throw new Error(`Batch exceeds max message count of ${this.limits.maxBatchMessages}`)
		}

		const stmt = this.db.prepare(
			'INSERT INTO queue_messages (id, queue, body, content_type, attempts, visible_at, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
		)
		const now = Date.now()

		// Pre-encode all messages and validate total size
		const encoded: { data: Uint8Array; contentType: string; delaySeconds: number }[] = []
		let totalSize = 0

		for (const msg of messages) {
			const contentType = msg.contentType ?? options?.contentType ?? 'json'
			const delaySeconds = msg.delaySeconds ?? options?.delaySeconds ?? this.defaultDelay

			if (delaySeconds < 0 || delaySeconds > this.limits.maxDelaySeconds) {
				throw new Error(`delaySeconds must be between 0 and ${this.limits.maxDelaySeconds}`)
			}

			const data = encodeBody(msg.body, contentType)

			if (data.byteLength > this.limits.maxMessageSize) {
				throw new Error(`Message exceeds max size of ${this.limits.maxMessageSize} bytes`)
			}

			totalSize += data.byteLength
			encoded.push({ data, contentType, delaySeconds })
		}

		if (totalSize > this.limits.maxBatchSize) {
			throw new Error(`Batch exceeds max total size of ${this.limits.maxBatchSize} bytes`)
		}

		const tx = this.db.transaction(() => {
			for (const { data, contentType, delaySeconds } of encoded) {
				const visibleAt = now + delaySeconds * 1000
				stmt.run(randomUUIDv7(), this.queueName, data, contentType, visibleAt, now)
			}
		})
		tx()
	}
}

// --- Consumer (poll loop) ---

export class QueueConsumer {
	private db: Database
	private config: ConsumerConfig
	private handler: QueueHandler
	private env: Record<string, unknown>
	private workerName: string | undefined
	private timer: ReturnType<typeof setInterval> | null = null
	private batchBuffer: { id: string; body: Uint8Array | Buffer; content_type: string; attempts: number; created_at: number }[] = []
	private batchTimer: ReturnType<typeof setTimeout> | null = null
	private polling = false

	constructor(
		db: Database,
		config: ConsumerConfig,
		handler: QueueHandler,
		env: Record<string, unknown>,
		workerName?: string,
	) {
		this.db = db
		this.config = config
		this.handler = handler
		this.env = env
		this.workerName = workerName
	}

	start(intervalMs: number = 1000): void {
		if (this.timer) return
		this.timer = setInterval(() => this.poll(), intervalMs)
		// Run first poll immediately
		this.poll()
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer)
			this.timer = null
		}
		if (this.batchTimer) {
			clearTimeout(this.batchTimer)
			this.batchTimer = null
		}
	}

	async poll(): Promise<void> {
		if (this.polling) return
		this.polling = true
		try {
			const now = Date.now()

			// Periodically clean up completed messages beyond retention period
			const retentionMs = (this.config.retentionPeriodSeconds ?? 345600) * 1000
			this.db.run(
				'DELETE FROM queue_messages WHERE queue = ? AND created_at < ?',
				[this.config.queue, now - retentionMs],
			)

			const rows = this.db.query<
				{ id: string; body: Uint8Array | Buffer; content_type: string; attempts: number; created_at: number },
				[string, number, number]
			>(
				"SELECT id, body, content_type, attempts, created_at FROM queue_messages WHERE queue = ? AND status = 'pending' AND visible_at <= ? ORDER BY visible_at LIMIT ?",
			).all(this.config.queue, now, this.config.maxBatchSize)

			if (rows.length === 0) return

			await this.deliverBatch(rows)
		} finally {
			this.polling = false
		}
	}

	private async deliverBatch(
		rows: { id: string; body: Uint8Array | Buffer; content_type: string; attempts: number; created_at: number }[],
	): Promise<void> {
		// Increment attempts for all fetched messages
		const ids = rows.map((r) => r.id)
		const placeholders = ids.map(() => '?').join(',')
		this.db.run(`UPDATE queue_messages SET attempts = attempts + 1 WHERE id IN (${placeholders})`, ids)

		// Track per-message decisions — last call wins (matching CF behavior)
		type Decision = { type: 'ack' } | { type: 'retry'; delaySeconds: number | undefined }
		const messageDecisions = new Map<string, Decision>()
		let batchDecision: Decision | null = null

		const messages: Message[] = rows.map((row) => {
			const body = decodeBody(row.body, row.content_type)
			return {
				id: row.id,
				timestamp: new Date(row.created_at),
				body,
				attempts: row.attempts + 1, // CF behavior: starts at 1 on first delivery
				ack() {
					messageDecisions.set(row.id, { type: 'ack' })
				},
				retry(options?: { delaySeconds?: number }) {
					messageDecisions.set(row.id, { type: 'retry', delaySeconds: options?.delaySeconds })
				},
			}
		})

		const batch: MessageBatch = {
			queue: this.config.queue,
			messages,
			ackAll() {
				batchDecision = { type: 'ack' }
			},
			retryAll(options?: { delaySeconds?: number }) {
				batchDecision = { type: 'retry', delaySeconds: options?.delaySeconds }
			},
		}

		const ctx = new ExecutionContext()

		let handlerError = false
		await startSpan({
			name: `queue ${this.config.queue}`,
			kind: 'server',
			attributes: { 'messaging.queue': this.config.queue, 'messaging.batch_size': messages.length },
			workerName: this.workerName,
		}, async () => {
			try {
				await this.handler(batch, this.env, ctx)
			} catch (err) {
				console.error(`[lopata] Queue consumer error (${this.config.queue}):`, err)
				persistError(err, 'queue', this.workerName)
				// On handler error, retry all messages
				handlerError = true
			}

			// Wait for all waitUntil promises to settle (best-effort)
			await ctx._awaitAll()
		})

		// Process message outcomes — per-message decision overrides batch decision
		for (const row of rows) {
			const currentAttempts = row.attempts + 1
			const decision: Decision | null = handlerError
				? { type: 'retry', delaySeconds: undefined }
				: messageDecisions.get(row.id) ?? batchDecision

			if (!decision || decision.type === 'ack') {
				// Ack (explicit or default) — mark as acked
				this.db.run("UPDATE queue_messages SET status = 'acked', completed_at = ? WHERE id = ?", [Date.now(), row.id])
			} else {
				// Retry
				const delay = decision.delaySeconds ?? 0
				if (currentAttempts >= this.config.maxRetries) {
					// Max retries exceeded — move to DLQ or mark as failed
					if (this.config.deadLetterQueue) {
						this.db.run(
							"UPDATE queue_messages SET queue = ?, visible_at = ?, status = 'pending' WHERE id = ?",
							[this.config.deadLetterQueue, Date.now(), row.id],
						)
					} else {
						console.warn(`[lopata] Queue message ${row.id} exceeded max retries (${this.config.maxRetries}), discarding`)
						this.db.run("UPDATE queue_messages SET status = 'failed', completed_at = ? WHERE id = ?", [Date.now(), row.id])
					}
				} else {
					// Retry with delay
					this.db.run(
						'UPDATE queue_messages SET visible_at = ? WHERE id = ?',
						[Date.now() + delay * 1000, row.id],
					)
				}
			}
		}
	}
}

// --- Pull Consumer ---

export interface PullMessage {
	lease_id: string
	id: string
	timestamp: string // ISO 8601
	body: unknown
	attempts: number
}

export interface PullResponse {
	messages: PullMessage[]
}

export interface AckRequest {
	acks?: { lease_id: string }[]
	retries?: { lease_id: string; delay_seconds?: number }[]
}

export interface PullRequest {
	batch_size?: number
	visibility_timeout_ms?: number
}

const DEFAULT_VISIBILITY_TIMEOUT_MS = 30_000
const DEFAULT_PULL_BATCH_SIZE = 10

export class QueuePullConsumer {
	private db: Database
	private queueName: string

	constructor(db: Database, queueName: string) {
		this.db = db
		this.queueName = queueName
	}

	pull(options?: PullRequest): PullResponse {
		const batchSize = options?.batch_size ?? DEFAULT_PULL_BATCH_SIZE
		const visibilityTimeoutMs = options?.visibility_timeout_ms ?? DEFAULT_VISIBILITY_TIMEOUT_MS
		const now = Date.now()

		// Clean up expired leases — make messages visible again
		this.db.run(
			'DELETE FROM queue_leases WHERE queue = ? AND expires_at <= ?',
			[this.queueName, now],
		)

		// Select visible pending messages that don't have an active lease
		const rows = this.db.query<
			{ id: string; body: Uint8Array | Buffer; content_type: string; attempts: number; created_at: number },
			[string, number, string, number, number]
		>(
			`SELECT id, body, content_type, attempts, created_at FROM queue_messages
       WHERE queue = ? AND status = 'pending' AND visible_at <= ?
       AND id NOT IN (SELECT message_id FROM queue_leases WHERE queue = ? AND expires_at > ?)
       ORDER BY visible_at LIMIT ?`,
		).all(this.queueName, now, this.queueName, now, batchSize)

		if (rows.length === 0) {
			return { messages: [] }
		}

		// Reject v8 content type
		const v8Messages = rows.filter(r => r.content_type === 'v8')
		const validRows = rows.filter(r => r.content_type !== 'v8')

		const messages: PullMessage[] = []

		const insertLease = this.db.prepare(
			'INSERT INTO queue_leases (lease_id, message_id, queue, expires_at) VALUES (?, ?, ?, ?)',
		)
		const updateAttempts = this.db.prepare(
			'UPDATE queue_messages SET attempts = attempts + 1 WHERE id = ?',
		)

		const tx = this.db.transaction(() => {
			for (const row of validRows) {
				const leaseId = crypto.randomUUID()
				const expiresAt = now + visibilityTimeoutMs

				insertLease.run(leaseId, row.id, this.queueName, expiresAt)
				updateAttempts.run(row.id)

				const body = decodeBody(row.body, row.content_type)

				messages.push({
					lease_id: leaseId,
					id: row.id,
					timestamp: new Date(row.created_at).toISOString(),
					body,
					attempts: row.attempts + 1,
				})
			}
		})
		tx()

		return { messages }
	}

	ack(request: AckRequest): { acked: number; retried: number } {
		let acked = 0
		let retried = 0
		const now = Date.now()

		const tx = this.db.transaction(() => {
			// Process acks
			if (request.acks) {
				for (const { lease_id } of request.acks) {
					// Find the lease
					const lease = this.db.query<
						{ message_id: string },
						[string, string, number]
					>(
						'SELECT message_id FROM queue_leases WHERE lease_id = ? AND queue = ? AND expires_at > ?',
					).get(lease_id, this.queueName, now)

					if (lease) {
						this.db.run("UPDATE queue_messages SET status = 'acked', completed_at = ? WHERE id = ?", [Date.now(), lease.message_id])
						this.db.run('DELETE FROM queue_leases WHERE lease_id = ?', [lease_id])
						acked++
					}
				}
			}

			// Process retries
			if (request.retries) {
				for (const { lease_id, delay_seconds } of request.retries) {
					const lease = this.db.query<
						{ message_id: string },
						[string, string, number]
					>(
						'SELECT message_id FROM queue_leases WHERE lease_id = ? AND queue = ? AND expires_at > ?',
					).get(lease_id, this.queueName, now)

					if (lease) {
						const delay = delay_seconds ?? 0
						this.db.run(
							'UPDATE queue_messages SET visible_at = ? WHERE id = ?',
							[now + delay * 1000, lease.message_id],
						)
						this.db.run('DELETE FROM queue_leases WHERE lease_id = ?', [lease_id])
						retried++
					}
				}
			}
		})
		tx()

		return { acked, retried }
	}
}

// Adapted from workers-sdk packages/miniflare/test/plugins/queues/{index,delay,retry}.spec.ts at 6ee18e1bd (MIT OR Apache-2.0, Cloudflare, Inc.)
// Miniflare plumbing (producer/consumer Workers, REPORTER service bindings, the queue broker's fake timers) is replaced by
// SqliteQueueProducer + QueueConsumer over an in-memory database, one shared TestClock and an in-process handler.

// Excluded:
// - "maxBatchTimeout validation": Miniflare options schema validation (ERR_VALIDATION, Zod message).
// Partially ported (Miniflare-specific assertions dropped, delivered batches still asserted):
// - "retries messages", "moves to dead letter queue": drop the Miniflare log-line assertions (`stripTimings(log.logs)`).
// - "moves to dead letter queue": drops the final `mf.setOptions` check that rejects a queue as its own dead letter queue.

import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect } from 'bun:test'
import assert from 'node:assert'
import { QueueConsumer, SqliteQueueProducer } from '../../src/bindings/queue'
import { resolveCompatibility } from '../../src/compatibility'
import { runMigrations } from '../../src/db'
import { TestClock } from '../../src/testing/clock'
import { conformanceTest, loadKnownFailures } from './harness'

const known = loadKnownFailures('miniflare-queues')

// Miniflare's control stub enables fake timers at 1_000_000 ms.
const FAKE_TIME_START = 1_000_000
// The runtime starts every consumer with `QueueConsumer.start()`, whose default poll interval is 100 ms.
const POLL_INTERVAL_MS = 100
// Miniflare's queue broker defaults (broker.worker.ts); the specs' expected values depend on them.
const DEFAULT_BATCH_SIZE = 5
const DEFAULT_BATCH_TIMEOUT = 1
const DEFAULT_RETRIES = 2
// Miniflare's fallback compatibility date (plugins/core); before queues_json_messages, so the default content type is v8.
const COMPATIBILITY = resolveCompatibility({ date: '2000-01-01' })

type ConsumerConfig = ConstructorParameters<typeof QueueConsumer>[1]
type QueueHandler = ConstructorParameters<typeof QueueConsumer>[2]
type ConsumerOptions = Partial<Omit<ConsumerConfig, 'queue'>>

interface ReportedMessage {
	queue: string
	id: string
	body: unknown
	attempts: number
}

let db: Database
// One wall clock for every queue, as in the runtime (Miniflare gives each queue broker its own fake timers).
let clock: TestClock

beforeEach(() => {
	db = new Database(':memory:')
	runMigrations(db)
	clock = new TestClock(FAKE_TIME_START)
})

afterEach(() => {
	db.close()
})

// Stands in for Miniflare's per-queue broker control stub. Advancing the shared clock fires this queue's consumer poll timer
// at every interval boundary, like `setInterval` would.
class QueueControl {
	readonly consumer: QueueConsumer

	constructor(private readonly queue: string, options: ConsumerOptions, handler: QueueHandler) {
		const config: ConsumerConfig = {
			queue,
			maxBatchSize: DEFAULT_BATCH_SIZE,
			maxBatchTimeout: DEFAULT_BATCH_TIMEOUT,
			maxRetries: DEFAULT_RETRIES,
			deadLetterQueue: null,
			...options,
		}
		this.consumer = new QueueConsumer(db, config, handler, {}, undefined, clock)
	}

	producer(defaultDelay = 0): SqliteQueueProducer {
		return new SqliteQueueProducer(db, this.queue, defaultDelay, undefined, clock, COMPATIBILITY)
	}

	async advanceFakeTime(ms: number): Promise<void> {
		const target = clock.now() + ms
		let pollAt = FAKE_TIME_START + (Math.floor((clock.now() - FAKE_TIME_START) / POLL_INTERVAL_MS) + 1) * POLL_INTERVAL_MS
		for (; pollAt <= target; pollAt += POLL_INTERVAL_MS) {
			clock.set(pollAt)
			await this.consumer.poll()
		}
		clock.set(target)
	}

	// Miniflare's broker flushes a full batch on a zero-delay timer that this awaits; lopata's equivalent is the consumer's
	// next poll, run here at the current time.
	waitForFakeTasks(): Promise<void> {
		return this.consumer.poll()
	}
}

// Stands in for the original's `batch[i].id`, which throws when the message is missing.
function idAt(batch: readonly { id: string }[] | undefined, index: number): string {
	const message = batch?.[index]
	if (message === undefined) throw new TypeError(`No message at index ${index}`)
	return message.id
}

function report(batch: Parameters<QueueHandler>[0]): ReportedMessage[] {
	return batch.messages.map(({ id, body, attempts }) => ({ queue: batch.queue, id, body, attempts }))
}

describe('queues', () => {
	conformanceTest(known, 'flushes partial and full batches', async () => {
		let batches: string[][] = []

		const object = new QueueControl('QUEUE', {}, async (batch) => {
			batches.push(batch.messages.map(({ id }) => id))
		})
		const queue = object.producer()

		async function send(message: unknown) {
			await queue.send(message)
		}
		async function sendBatch(...messages: unknown[]) {
			await queue.sendBatch(messages.map((body) => ({ body })))
		}

		// Check with single msg
		await send('msg1')
		await object.advanceFakeTime(500)
		await object.waitForFakeTasks()
		expect(batches.length).toBe(0)
		await object.advanceFakeTime(500)
		await object.waitForFakeTasks()
		expect(batches[0]?.length).toBe(1)
		expect(batches[0]?.[0]).toMatch(/^[0-9a-f]{32}$/)
		batches = []

		// Check with single batch
		await sendBatch('msg1', 'msg2')
		await object.advanceFakeTime(250)
		await object.waitForFakeTasks()
		expect(batches.length).toBe(0)
		await object.advanceFakeTime(1000)
		await object.waitForFakeTasks()
		expect(batches[0]?.length).toBe(2)
		expect(batches[0]?.[0]).toMatch(/^[0-9a-f]{32}$/)
		expect(batches[0]?.[1]).toMatch(/^[0-9a-f]{32}$/)
		batches = []

		// Check with messages and batches
		await send('msg1')
		await sendBatch('msg2', 'msg3')
		await send('msg4')
		await object.advanceFakeTime(100)
		await object.waitForFakeTasks()
		expect(batches.length).toBe(0)
		await object.advanceFakeTime(900)
		await object.waitForFakeTasks()
		expect(batches[0]?.length).toBe(4)
		batches = []

		// Check with full batch
		await sendBatch('msg1', 'msg2', 'msg3', 'msg4', 'msg5')
		await object.waitForFakeTasks()
		expect(batches.length).toBe(1)
		expect(batches[0]?.length).toBe(5)
		batches = []

		// Check with overflowing batch
		await sendBatch('msg1', 'msg2', 'msg3', 'msg4', 'msg5', 'msg6', 'msg7')
		await object.waitForFakeTasks()
		expect(batches.length).toBe(1)
		// (second batch isn't full, so need to wait for max batch timeout)
		await object.advanceFakeTime(500)
		await object.waitForFakeTasks()
		expect(batches.length).toBe(1)
		await object.advanceFakeTime(500)
		await object.waitForFakeTasks()
		expect(batches.length).toBe(2)
		expect(batches[0]?.length).toBe(5)
		expect(batches[1]?.length).toBe(2)
		batches = []

		// Check with overflowing batch twice
		await sendBatch('msg1', 'msg2', 'msg3', 'msg4', 'msg5', 'msg6')
		await object.waitForFakeTasks()
		expect(batches.length).toBe(1)
		// (second batch isn't full yet, but sending more messages will fill it)
		await sendBatch('msg7', 'msg8', 'msg9', 'msg10', 'msg11')
		await object.waitForFakeTasks()
		expect(batches.length).toBe(2)
		// (third batch isn't full, so need to wait for max batch timeout)
		await object.advanceFakeTime(1000)
		await object.waitForFakeTasks()
		expect(batches.length).toBe(3)
		expect(batches[0]?.length).toBe(5)
		expect(batches[1]?.length).toBe(5)
		expect(batches[2]?.length).toBe(1)
		batches = []
	})

	// The three Miniflare producer declaration shapes all map to a wrangler `{ binding, queue }` producer, i.e. a
	// SqliteQueueProducer whose queue name differs from the binding name.
	async function sendHelloAndReport(first: string, second: string): Promise<ReportedMessage[]> {
		let reported: ReportedMessage[] | undefined
		const object = new QueueControl('MY_QUEUE', {}, async (batch) => {
			reported = report(batch)
		})
		const MY_QUEUE_PRODUCER = object.producer()
		await MY_QUEUE_PRODUCER.send(first)
		await MY_QUEUE_PRODUCER.sendBatch([{ body: second }])
		await object.advanceFakeTime(1000)
		await object.waitForFakeTasks()
		if (reported === undefined) throw new Error('queue handler was not called')
		return reported
	}

	conformanceTest(
		known,
		"supports declaring queue producers as a key-value pair -> queueProducers: { 'MY_QUEUE_BINDING': 'my-queue_name' }",
		async () => {
			const batch = await sendHelloAndReport('Hello world!', 'Hola mundo!')
			expect(batch).toEqual([
				{ queue: 'MY_QUEUE', id: idAt(batch, 0), body: 'Hello world!', attempts: 1 },
				{ queue: 'MY_QUEUE', id: idAt(batch, 1), body: 'Hola mundo!', attempts: 1 },
			])
		},
	)

	conformanceTest(known, "supports declaring queue producers as an array -> queueProducers: ['MY_QUEUE_BINDING']", async () => {
		const batch = await sendHelloAndReport('Hello World!', 'Hola Mundo!')
		expect(batch).toEqual([
			{ queue: 'MY_QUEUE', id: idAt(batch, 0), body: 'Hello World!', attempts: 1 },
			{ queue: 'MY_QUEUE', id: idAt(batch, 1), body: 'Hola Mundo!', attempts: 1 },
		])
	})

	conformanceTest(known, "supports declaring queue producers as {MY_QUEUE_BINDING: {queueName: 'my-queue-name'}}", async () => {
		const batch = await sendHelloAndReport('Hello World!', 'Hola Mundo!')
		expect(batch).toEqual([
			{ queue: 'MY_QUEUE', id: idAt(batch, 0), body: 'Hello World!', attempts: 1 },
			{ queue: 'MY_QUEUE', id: idAt(batch, 1), body: 'Hola Mundo!', attempts: 1 },
		])
	})

	conformanceTest(known, 'sends all structured cloneable types', async () => {
		let reported: string | undefined

		const arrayBuffer = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]).buffer
		const cyclic: { a: number; b?: unknown } = { a: 1 }
		cyclic.b = cyclic

		const VALUES: Record<string, unknown> = {
			Object: { w: 1, x: 42n, y: true, z: 'string' },
			Cyclic: cyclic,
			Array: [0, 1, [2, 3]],
			Date: new Date(1000),
			Map: new Map([['a', 1], ['b', 2], ['c', 3]]),
			Set: new Set(['a', 'b', 'c']),
			RegExp: /ab?c/g,
			ArrayBuffer: arrayBuffer,
			DataView: new DataView(arrayBuffer, 2, 3),
			Int8Array: new Int8Array(arrayBuffer),
			Uint8Array: new Uint8Array(arrayBuffer, 1, 4),
			Uint8ClampedArray: new Uint8ClampedArray(arrayBuffer),
			Int16Array: new Int16Array(arrayBuffer),
			Uint16Array: new Uint16Array(arrayBuffer),
			Int32Array: new Int32Array(arrayBuffer),
			Uint32Array: new Uint32Array(arrayBuffer),
			Float32Array: new Float32Array(arrayBuffer),
			Float64Array: new Float64Array(arrayBuffer),
			BigInt64Array: new BigInt64Array(arrayBuffer),
			BigUint64Array: new BigUint64Array(arrayBuffer),
			Error: new Error('message', { cause: new Error('cause') }),
			EvalError: new EvalError('message'),
			RangeError: new RangeError('message'),
			ReferenceError: new ReferenceError('message'),
			SyntaxError: new SyntaxError('message'),
			TypeError: new TypeError('message'),
			URIError: new URIError('message'),
		}
		const EXTRA_CHECKS: Record<string, (value: unknown) => void> = {
			Cyclic(value) {
				assert(typeof value === 'object' && value !== null && 'b' in value && value.b === value, 'Cyclic: cycle')
			},
			Error(value) {
				const expected = VALUES.Error
				assert(value instanceof Error && expected instanceof Error, 'Error: type')
				assert.deepStrictEqual(value.cause, expected.cause, 'Error: cause')
			},
		}

		const object = new QueueControl('QUEUE', { maxBatchSize: 100, maxBatchTimeout: 0, maxRetries: 0 }, async (batch) => {
			let error: unknown
			try {
				for (const message of batch.messages) {
					const body = message.body
					assert(typeof body === 'object' && body !== null && 'name' in body && 'value' in body, 'body shape')
					const name = String(body.name)
					assert.deepStrictEqual(body.value, VALUES[name], name)
					EXTRA_CHECKS[name]?.(body.value)
				}
			} catch (e) {
				error = e instanceof Error ? e.stack : e
			}
			reported = String(error)
		})
		const QUEUE = object.producer()

		await QUEUE.sendBatch(Object.entries(VALUES).map(([key, value]) => ({ body: { name: key, value } })))
		await object.advanceFakeTime(1000)
		await object.waitForFakeTasks()
		expect(reported).toBe('undefined')
	})

	conformanceTest(known, 'retries messages', async () => {
		let batches: ReportedMessage[][] = []
		const bodiesAttempts = () => batches.map((batch) => batch.map(({ body, attempts }) => ({ body, attempts })))

		let retryAll = false
		let errorAll = false
		let retryMessages: string[] = []

		const object = new QueueControl('queue', { maxBatchSize: 5, maxBatchTimeout: 1, maxRetries: 2 }, async (batch) => {
			batches.push(report(batch))
			if (retryAll) {
				batch.retryAll()
				return
			}
			if (errorAll) {
				throw new Error('Whoops!')
			}
			for (const message of batch.messages) {
				if (typeof message.body === 'string' && retryMessages.includes(message.body)) message.retry()
			}
		})
		const QUEUE = object.producer()

		async function sendBatch(...messages: string[]) {
			await QUEUE.sendBatch(messages.map((body) => ({ body })))
		}

		// Check with explicit single retry
		retryMessages = ['msg2']
		await sendBatch('msg1', 'msg2', 'msg3')
		await object.advanceFakeTime(1000)
		await object.waitForFakeTasks()
		expect(batches.length).toBe(1)
		retryMessages = []
		await object.advanceFakeTime(1000)
		await object.waitForFakeTasks()
		expect(batches.length).toBe(2)
		await object.advanceFakeTime(1000)
		await object.waitForFakeTasks()
		expect(batches.length).toBe(2)
		expect(bodiesAttempts()).toEqual([
			[
				{ body: 'msg1', attempts: 1 },
				{ body: 'msg2', attempts: 1 },
				{ body: 'msg3', attempts: 1 },
			],
			[{ body: 'msg2', attempts: 2 }],
		])
		batches = []

		// Check with explicit retry all
		retryAll = true
		await sendBatch('msg1', 'msg2', 'msg3')
		await object.advanceFakeTime(1000)
		await object.waitForFakeTasks()
		expect(batches.length).toBe(1)
		retryAll = false
		await object.advanceFakeTime(1000)
		await object.waitForFakeTasks()
		expect(batches.length).toBe(2)
		expect(bodiesAttempts()).toEqual([
			[
				{ body: 'msg1', attempts: 1 },
				{ body: 'msg2', attempts: 1 },
				{ body: 'msg3', attempts: 1 },
			],
			[
				{ body: 'msg1', attempts: 2 },
				{ body: 'msg2', attempts: 2 },
				{ body: 'msg3', attempts: 2 },
			],
		])
		batches = []

		// Check with implicit retry from exception
		errorAll = true
		await sendBatch('msg1', 'msg2', 'msg3')
		await object.advanceFakeTime(1000)
		await object.waitForFakeTasks()
		expect(batches.length).toBe(1)
		errorAll = false
		await object.advanceFakeTime(1000)
		await object.waitForFakeTasks()
		expect(batches.length).toBe(2)
		expect(bodiesAttempts()).toEqual([
			[
				{ body: 'msg1', attempts: 1 },
				{ body: 'msg2', attempts: 1 },
				{ body: 'msg3', attempts: 1 },
			],
			[
				{ body: 'msg1', attempts: 2 },
				{ body: 'msg2', attempts: 2 },
				{ body: 'msg3', attempts: 2 },
			],
		])
		batches = []

		// Check drops messages after max retries
		retryAll = true
		await sendBatch('msg1', 'msg2', 'msg3')
		await object.advanceFakeTime(1000)
		await object.waitForFakeTasks()
		expect(batches.length).toBe(1)
		retryAll = false
		retryMessages = ['msg3']
		await object.advanceFakeTime(1000)
		await object.waitForFakeTasks()
		expect(batches.length).toBe(2)
		await object.advanceFakeTime(1000)
		await object.waitForFakeTasks()
		expect(batches.length).toBe(3)
		await object.advanceFakeTime(1000)
		await object.waitForFakeTasks()
		expect(batches.length).toBe(3)
		expect(bodiesAttempts()).toEqual([
			[
				{ body: 'msg1', attempts: 1 },
				{ body: 'msg2', attempts: 1 },
				{ body: 'msg3', attempts: 1 },
			],
			[
				{ body: 'msg1', attempts: 2 },
				{ body: 'msg2', attempts: 2 },
				{ body: 'msg3', attempts: 2 },
			],
			[{ body: 'msg3', attempts: 3 }],
		])
		batches = []
	})

	conformanceTest(known, 'moves to dead letter queue', async () => {
		const batches: ReportedMessage[][] = []
		let retryMessages: string[] = []

		// Check single Worker consuming multiple queues
		const handler: QueueHandler = async (batch) => {
			batches.push(report(batch))
			for (const message of batch.messages) {
				if (typeof message.body === 'string' && retryMessages.includes(message.body)) message.retry()
			}
		}
		const badObject = new QueueControl('bad', { maxBatchSize: 5, maxBatchTimeout: 1, maxRetries: 0, deadLetterQueue: 'dlq' }, handler)
		// (cyclic)
		const dlqObject = new QueueControl('dlq', { maxBatchSize: 5, maxBatchTimeout: 1, maxRetries: 0, deadLetterQueue: 'bad' }, handler)
		const BAD_QUEUE = badObject.producer()

		async function sendBatch(...messages: string[]) {
			await BAD_QUEUE.sendBatch(messages.map((body) => ({ body })))
		}

		// Check moves messages to dead letter queue after max retries
		retryMessages = ['msg2', 'msg3']
		await sendBatch('msg1', 'msg2', 'msg3')
		await badObject.advanceFakeTime(1000)
		await badObject.waitForFakeTasks()
		expect(batches.length).toBe(1)
		// Check allows cyclic dead letter queue path with multiple queues
		retryMessages = ['msg2']
		await dlqObject.advanceFakeTime(1000)
		await dlqObject.waitForFakeTasks()
		expect(batches.length).toBe(2)
		retryMessages = []
		await badObject.advanceFakeTime(1000)
		await badObject.waitForFakeTasks()
		expect(batches.length).toBe(3)
		expect(batches).toEqual([
			[
				{ queue: 'bad', id: idAt(batches[0], 0), body: 'msg1', attempts: 1 },
				{ queue: 'bad', id: idAt(batches[0], 1), body: 'msg2', attempts: 1 },
				{ queue: 'bad', id: idAt(batches[0], 2), body: 'msg3', attempts: 1 },
			],
			[
				{ queue: 'dlq', id: idAt(batches[0], 1), body: 'msg2', attempts: 1 },
				{ queue: 'dlq', id: idAt(batches[0], 2), body: 'msg3', attempts: 1 },
			],
			[{ queue: 'bad', id: idAt(batches[0], 1), body: 'msg2', attempts: 1 }],
		])
	})

	conformanceTest(known, 'operations permit strange queue names', async () => {
		let reported: ReportedMessage[] | undefined
		const id = 'my/ Queue'
		const object = new QueueControl(id, {}, async (batch) => {
			reported = report(batch)
		})
		const QUEUE = object.producer()

		await QUEUE.send('msg1')
		await QUEUE.sendBatch([{ body: 'msg2' }])
		await object.advanceFakeTime(1000)
		await object.waitForFakeTasks()
		const batch = reported ?? []
		expect(batch).toEqual([
			{ queue: id, id: idAt(batch, 0), body: 'msg1', attempts: 1 },
			{ queue: id, id: idAt(batch, 1), body: 'msg2', attempts: 1 },
		])
	})

	conformanceTest(known, 'supports message contentTypes', async () => {
		let reported: { queue: string; id: string; body: unknown }[] | undefined
		const id = 'my/ Queue'

		// Same mapping as the original's JSON.stringify replacer (minus Date.prototype.toJSON), without the JSON round trip.
		const encode = (value: unknown): unknown => {
			if (value instanceof ArrayBuffer) return { $type: 'ArrayBuffer', value: Array.from(new Uint8Array(value)) }
			if (value instanceof Date) return { $type: 'Date', value: value.getTime() }
			if (Array.isArray(value)) return value.map(encode)
			if (typeof value === 'object' && value !== null) {
				return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, encode(entry)]))
			}
			return value
		}

		const object = new QueueControl(id, {}, async (batch) => {
			reported = batch.messages.map(({ id, body }) => ({ queue: batch.queue, id, body: encode(body) }))
		})
		const QUEUE = object.producer()

		await QUEUE.send('msg1', { contentType: 'text' })
		await QUEUE.send([{ message: 'msg2' }], { contentType: 'json' })
		const arrayBuffer = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7])
		await QUEUE.send(arrayBuffer, { contentType: 'bytes' })
		await QUEUE.send(new Date(1600000000000), { contentType: 'v8' })

		await object.advanceFakeTime(1000)
		await object.waitForFakeTasks()
		const batch = reported ?? []
		expect(batch).toEqual([
			{ queue: id, id: idAt(batch, 0), body: 'msg1' },
			{ queue: id, id: idAt(batch, 1), body: [{ message: 'msg2' }] },
			{
				queue: id,
				id: idAt(batch, 2),
				body: { $type: 'ArrayBuffer', value: [0, 1, 2, 3, 4, 5, 6, 7] },
			},
			{
				queue: id,
				id: idAt(batch, 3),
				body: { $type: 'Date', value: 1600000000000 },
			},
		])
	})

	conformanceTest(known, 'validates message size', async () => {
		const object = new QueueControl('MY_QUEUE', { maxBatchSize: 100, maxBatchTimeout: 0 }, async () => {})
		const QUEUE = object.producer()

		await expect(QUEUE.send(new Uint8Array(128 * 1000 + 1), { contentType: 'bytes' })).rejects.toThrow(
			'Queue send failed: message length of 128001 bytes exceeds limit of 128000',
		)
	})
})

describe('queues delay', () => {
	let batches: string[][]
	let object: QueueControl
	let QUEUE: SqliteQueueProducer

	beforeEach(() => {
		batches = []
		object = new QueueControl('QUEUE', { maxBatchSize: 100, maxBatchTimeout: 0 }, async (batch) => {
			const ids = batch.messages.map(({ id }) => id)
			if (ids.length > 0) {
				batches.push(ids)
			}
		})
		QUEUE = object.producer(2)
	})

	conformanceTest(known, '.send() respects default delay', async () => {
		await QUEUE.send('default')

		// Nothing should happen one second later
		await object.advanceFakeTime(1000)
		await object.waitForFakeTasks()
		expect(batches.length).toBe(0)

		// A batch should be delivered 2 seconds later
		await object.advanceFakeTime(1000)
		await object.waitForFakeTasks()
		expect(batches.length).toBe(1)
	})

	conformanceTest(known, '.send() respects per-message delay', async () => {
		// Send 10 messages.
		for (let i = 1; i <= 10; i++) {
			await QUEUE.send(i, { delaySeconds: i })
		}

		// Verify messages are received at the right times.
		expect(batches.length).toBe(0)

		for (let i = 1; i <= 10; i++) {
			await object.advanceFakeTime(1000)
			await object.waitForFakeTasks()
			expect(batches.length).toBe(i)
		}
	})

	conformanceTest(known, '.sendBatch() respects default delay', async () => {
		await QUEUE.sendBatch([{ body: 'msg1' }, { body: 'msg2' }])

		// Nothing should happen one second later
		await object.advanceFakeTime(1000)
		await object.waitForFakeTasks()
		expect(batches.length).toBe(0)

		// Batch should be delivered 2 seconds later
		await object.advanceFakeTime(1000)
		await object.waitForFakeTasks()
		expect(batches.length).toBe(2)
	})

	conformanceTest(known, '.sendBatch() respects per-batch delay', async () => {
		await QUEUE.sendBatch([{ body: 1 }, { body: 2 }], { delaySeconds: 3 })

		// Verify messages are received at the right times.
		expect(batches.length).toBe(0)

		await object.advanceFakeTime(1000)
		await object.waitForFakeTasks()
		expect(batches.length).toBe(0)

		await object.advanceFakeTime(1000)
		await object.waitForFakeTasks()
		expect(batches.length).toBe(0)

		await object.advanceFakeTime(1000)
		await object.waitForFakeTasks()
		expect(batches.length).toBe(2)
	})

	conformanceTest(known, '.sendBatch() respects per-message delay', async () => {
		await QUEUE.sendBatch(
			[
				{ body: 10, delaySeconds: 2 },
				{ body: 11, delaySeconds: 3 },
				{ body: 12, delaySeconds: 4 },
			],
			{ delaySeconds: 1 },
		)

		// Verify messages are received at the right times.
		await object.advanceFakeTime(1000)
		await object.waitForFakeTasks()
		expect(batches.length).toBe(0)

		for (let i = 1; i <= 3; i++) {
			await object.advanceFakeTime(1000)
			await object.waitForFakeTasks()
			expect(batches.length).toBe(i)
		}
	})
})

describe('Queues: retry', () => {
	let batches: string[][]
	let object: QueueControl
	let QUEUE: SqliteQueueProducer

	beforeEach(() => {
		batches = []
		object = new QueueControl('QUEUE', { retryDelay: 5, maxRetries: 2, maxBatchTimeout: 0 }, async (batch) => {
			const ids = batch.messages.map(({ id }) => id)
			if (ids.length > 0) {
				batches.push(ids)
			}
			batch.retryAll()
		})
		QUEUE = object.producer()
	})

	conformanceTest(known, 'respects retry delays', async () => {
		await QUEUE.send('some-message')

		// Message should be delivered once
		await object.advanceFakeTime(1000)
		await object.waitForFakeTasks()
		expect(batches.length).toBe(1)

		// Message should not be re-delivered one second later
		await object.advanceFakeTime(1000)
		await object.waitForFakeTasks()
		expect(batches.length).toBe(1)

		// Message should be re-delivered once 5 seconds later
		await object.advanceFakeTime(5000)
		await object.waitForFakeTasks()
		expect(batches.length).toBe(2)

		// Message should be re-delivered once 5 seconds later
		await object.advanceFakeTime(5000)
		await object.waitForFakeTasks()
		expect(batches.length).toBe(3)
	})

	conformanceTest(known, 'respects max retries', async () => {
		await QUEUE.send('some-message')

		// Message should be delivered once
		await object.advanceFakeTime(1000)
		await object.waitForFakeTasks()

		// Message should not be re-delivered one second later
		await object.advanceFakeTime(1000)
		await object.waitForFakeTasks()

		// Message should be re-delivered once 5 seconds later
		await object.advanceFakeTime(5000)
		await object.waitForFakeTasks()

		// Message should not be delivered again 5 seconds later (max retries is 2)
		await object.advanceFakeTime(5000)
		await object.waitForFakeTasks()
		expect(batches.length).toBe(3)
	})
})

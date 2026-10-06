import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReadableStream as WebReadableStream } from 'node:stream/web'
import { NonRetryableError, SqliteWorkflowBinding, WorkflowEntrypointBase } from '../src/bindings/workflow'
import type { WorkflowLimits, WorkflowStepImpl } from '../src/bindings/workflow'
import { WorkflowStore } from '../src/bindings/workflow-store'
import { runMigrations } from '../src/db'
import { TestWorkflowBinding } from '../src/testing/workflow'

let db: Database
let bindings: SqliteWorkflowBinding[]
beforeEach(() => {
	db = new Database(':memory:')
	runMigrations(db)
	bindings = []
})
afterEach(async () => {
	for (const binding of bindings) binding.abortRunning()
	await Bun.sleep(20)
	db.close()
})
function bind(run: (step: WorkflowStepImpl) => Promise<unknown>, limits: WorkflowLimits = {}) {
	class Workflow extends WorkflowEntrypointBase {
		override run(_event: unknown, step: WorkflowStepImpl) {
			return run(step)
		}
	}
	const binding = new SqliteWorkflowBinding(db, 'STREAMS', 'Workflow', { defaultRetryLimit: 0, defaultRetryDelayMs: 1, ...limits })
	binding._setClass(Workflow, {})
	bindings.push(binding)
	return binding
}
async function until(predicate: () => boolean | Promise<boolean>) {
	const deadline = Date.now() + 4000
	while (!await predicate()) {
		if (Date.now() > deadline) throw new Error('Stream test timed out')
		await Bun.sleep(5)
	}
}
async function terminal(instance: { status(): Promise<{ status: string }> }) {
	await until(async () => ['complete', 'errored', 'terminated'].includes((await instance.status()).status))
}
function source(size = 150000): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(Uint8Array.from({ length: size }, (_, index) => index % 251))
			controller.close()
		},
	})
}
async function inspect(stream: ReadableStream<Uint8Array>) {
	const reader = stream.getReader()
	let count = 0
	let maxChunk = 0
	try {
		while (true) {
			const { value, done } = await reader.read()
			if (done) return { count, maxChunk }
			maxChunk = Math.max(maxChunk, value.length)
			for (const byte of value) {
				if (byte !== count % 251) throw new Error(`Byte mismatch at ${count}`)
				count++
			}
		}
	} finally {
		reader.releaseLock()
	}
}
function streamId(id: string): string {
	const checkpoint = new WorkflowStore(db).readDetail(id, 'STREAMS').occurrences[0]?.checkpoint
	if (checkpoint?.kind !== 'stream') throw new Error('Expected a stream checkpoint')
	return checkpoint.streamId
}

test('large binary results bypass only the nonstream cap, commit before return, and replay with independent bounded readers', async () => {
	let calls = 0
	const binding = bind(async step => {
		const output = await step.do('bytes', async () => {
			calls++
			return source(1100000)
		})
		expect(db.query<{ state: string }, []>('SELECT state FROM workflow_streams').get()?.state).toBe('committed')
		const result = await inspect(output)
		await step.waitForEvent('gate', { type: 'go' })
		return result
	}, { maxStepOutputBytes: 256 })
	const instance = await binding.create()
	await until(async () => (await instance.status()).status === 'waiting')
	const store = new WorkflowStore(db)
	const id = streamId(instance.id)
	const first = store.openStream(id).getReader()
	const second = store.openStream(id).getReader()
	expect((await first.read()).value?.length).toBe(65536)
	await first.cancel()
	expect((await second.read()).value?.[1]).toBe(1)
	await second.cancel()
	binding.abortRunning()
	await Bun.sleep(20)
	binding.resumeInterrupted()
	await until(async () => (await instance.status()).status === 'waiting')
	await instance.sendEvent({ type: 'go' })
	await terminal(instance)
	expect((await instance.status()).output).toEqual({ count: 1100000, maxChunk: 65536 })
	expect(calls).toBe(1)
	const tooLarge = bind(async step => step.do('json', async () => 'abcdef'), { maxStepOutputBytes: 5 })
	const json = await tooLarge.create()
	await terminal(json)
	expect((await json.status()).error?.message).toContain('output exceeds')
})

test('each compensation retry gets a fresh reader', async () => {
	let undoCalls = 0
	const binding = bind(async step => {
		await step.do('bytes', async () => source(), {
			rollback: async ({ output }) => {
				if (!output) throw new Error('Missing rollback output')
				expect((await inspect(output)).count).toBe(150000)
				if (++undoCalls === 1) throw new Error('retry rollback')
			},
			rollbackConfig: { retries: { limit: 1, delay: 1 } },
		})
		throw new NonRetryableError('undo')
	})
	const instance = await binding.create()
	await terminal(instance)
	expect((await instance.status()).rollback?.outcome).toBe('complete')
	expect(undoCalls).toBe(2)
})

test.each(['locked', 'disturbed', 'cancelled', 'byob', 'malformed', 'read-error'])(
	'rejects %s streams without publishing a checkpoint',
	async kind => {
		let cancelled = 0
		const input = kind === 'byob' ? new WebReadableStream({ type: 'bytes' }) : new ReadableStream<unknown>({
			start(controller) {
				if (kind === 'read-error') controller.error(new Error('source failed'))
				else controller.enqueue(kind === 'malformed' ? 'not bytes' : new Uint8Array([1]))
			},
			cancel() {
				cancelled++
			},
		}, { highWaterMark: 0 })
		const reader = kind === 'locked' || kind === 'disturbed' ? input.getReader() : undefined
		if (kind === 'disturbed') {
			await reader?.read()
			reader?.releaseLock()
		}
		if (kind === 'cancelled') await input.cancel()
		const binding = bind(async step => step.do('bytes', async () => input))
		const instance = await binding.create()
		await terminal(instance)
		expect((await instance.status()).status).toBe('errored')
		expect(new WorkflowStore(db).readDetail(instance.id, 'STREAMS').occurrences[0]?.checkpoint).toBeNull()
		expect(db.query('SELECT * FROM workflow_streams').all()).toHaveLength(0)
		if (kind === 'malformed') expect(cancelled).toBe(1)
		if (kind === 'locked') reader?.releaseLock()
	},
)

test('freshness rejection performs no validation reads', async () => {
	let pulls = 0
	const input = new ReadableStream<Uint8Array>({
		pull() {
			pulls++
		},
	}, { highWaterMark: 0 })
	await input.cancel()
	const binding = bind(async step => step.do('bytes', async () => input))
	const instance = await binding.create()
	await terminal(instance)
	expect(pulls).toBe(0)
	expect((await instance.status()).status).toBe('errored')
})

test('native Response freshness validation does not pull data from a fresh default source', async () => {
	let pulls = 0
	let cancels = 0
	const input = new ReadableStream<Uint8Array>({
		pull() {
			pulls++
		},
		cancel() {
			cancels++
		},
	}, { highWaterMark: 0 })
	const owned = new Response(input).body
	await Bun.sleep(5)
	expect(pulls).toBe(0)
	await owned?.cancel()
	expect(cancels).toBe(1)
})

test('an unfinished writer cannot be read or returned until EOF atomically commits it', async () => {
	let close: (() => void) | undefined
	let returned = false
	const input = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array([1, 2, 3]))
			close = () => controller.close()
		},
	})
	const binding = bind(async step => {
		await step.do('bytes', async () => input)
		returned = true
	})
	const instance = await binding.create()
	await until(() => db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM workflow_stream_chunks').get()?.n === 1)
	const manifest = db.query<{ id: string }, []>('SELECT id FROM workflow_streams').get()
	if (!manifest || !close) throw new Error('No active stream')
	expect(returned).toBe(false)
	expect(new WorkflowStore(db).readDetail(instance.id, 'STREAMS').occurrences[0]?.checkpoint).toBeNull()
	expect(() => new WorkflowStore(db).openStream(manifest.id)).toThrow('missing committed manifest')
	close()
	await terminal(instance)
	expect(returned).toBe(true)
	expect(streamId(instance.id)).toBe(manifest.id)
})

test('empty streams commit and replay as empty independent readers', async () => {
	const binding = bind(async step => inspect(await step.do('bytes', async () => source(0))))
	const instance = await binding.create()
	await terminal(instance)
	expect((await instance.status()).output).toEqual({ count: 0, maxChunk: 0 })
	const result = await inspect(new WorkflowStore(db).openStream(streamId(instance.id)))
	expect(result.count).toBe(0)
})

test.each(['pending', 'rejected'])('timeout cancels a stuck source with a %s cancellation promise and releases the lock', async cancellation => {
	let cancellations = 0
	const input = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array([1]))
		},
		cancel() {
			cancellations++
			return cancellation === 'rejected' ? Promise.reject(new Error('cancel failed')) : new Promise<void>(() => {})
		},
	}, { highWaterMark: 0 })
	const binding = bind(async step => step.do('bytes', { timeout: 30 }, async () => input))
	const instance = await binding.create()
	await terminal(instance)
	await until(() => !input.locked)
	expect((await instance.status()).error?.message).toContain('timed out')
	expect(cancellations).toBe(1)
	expect(db.query('SELECT * FROM workflow_streams').all()).toHaveLength(0)
	expect(db.query('SELECT * FROM workflow_stream_chunks').all()).toHaveLength(0)
})

test('a stream returned after callback timeout is cancelled without ever writing a manifest', async () => {
	let cancelled = false
	const input = new ReadableStream<Uint8Array>({
		cancel() {
			cancelled = true
		},
	}, { highWaterMark: 0 })
	const binding = bind(async step =>
		step.do('bytes', { timeout: 10 }, async () => {
			await Bun.sleep(40)
			return input
		})
	)
	const instance = await binding.create()
	await terminal(instance)
	await until(() => cancelled)
	expect(input.locked).toBe(false)
	expect(db.query('SELECT * FROM workflow_streams').all()).toHaveLength(0)
})

test.each(['response', 'blob'])('disturbed optimized %s sources are rejected after their reader releases its lock', async kind => {
	const input = kind === 'response' ? new Response('bytes').body : new Blob(['bytes']).stream()
	if (!input) throw new Error('No source')
	const reader = input.getReader()
	await reader.read()
	reader.releaseLock()
	expect(input.locked).toBe(false)
	const binding = bind(async step => step.do('bytes', async () => input))
	const instance = await binding.create()
	await terminal(instance)
	expect((await instance.status()).error?.message).toContain('disturbed')
	expect(db.query('SELECT * FROM workflow_streams').all()).toHaveLength(0)
})

test('synchronously ready input yields to timeout and cancellation', async () => {
	let cancelled = false
	let pulls = 0
	const input = new ReadableStream<Uint8Array>({
		pull(controller) {
			pulls++
			controller.enqueue(new Uint8Array(65536))
		},
		cancel() {
			cancelled = true
		},
	}, { highWaterMark: 0 })
	const binding = bind(async step => step.do('bytes', { timeout: 20 }, async () => input))
	const instance = await binding.create()
	await terminal(instance)
	expect(cancelled).toBe(true)
	expect(pulls).toBeGreaterThan(0)
	expect(pulls).toBeLessThan(10000)
	expect(input.locked).toBe(false)
})

test('timeout releases its reader before a suspended producer yield resumes', async () => {
	const scheduled: (() => void)[] = []
	const schedule = globalThis.setTimeout
	function scheduleControlled<Args extends unknown[]>(callback: (...args: Args) => void, delay?: number, ...args: Args) {
		if (delay !== 0) return schedule(callback, delay, ...args)
		scheduled.push(() => callback(...args))
		const timer = schedule(() => {}, 0)
		clearTimeout(timer)
		return timer
	}
	const scheduler = spyOn(globalThis, 'setTimeout').mockImplementation(Object.assign(scheduleControlled, { __promisify__: schedule.__promisify__ }))
	let cancelled = false
	const input = new ReadableStream<Uint8Array>({
		pull(controller) {
			controller.enqueue(new Uint8Array(65536))
		},
		cancel() {
			cancelled = true
		},
	}, { highWaterMark: 0 })
	try {
		const binding = bind(async step => step.do('bytes', { timeout: 20 }, async () => input))
		const instance = await binding.create()
		await terminal(instance)
		expect(scheduled).toHaveLength(1)
		expect((await instance.status()).error?.message).toContain('timed out')
		expect(cancelled).toBe(true)
		expect(input.locked).toBe(false)
	} finally {
		scheduler.mockRestore()
		for (const resume of scheduled) resume()
	}
})

test('an abort raised synchronously by the producer fences publication immediately', async () => {
	let aborted = false
	const binding = bind(async step =>
		step.do('bytes', async () =>
			new ReadableStream<Uint8Array>({
				pull(controller) {
					controller.enqueue(new Uint8Array([1, 2, 3]))
					controller.close()
					binding.abortRunning()
					aborted = true
				},
			}, { highWaterMark: 0 }))
	)
	const instance = await binding.create()
	await until(() => aborted)
	await Bun.sleep(20)
	expect(new WorkflowStore(db).readDetail(instance.id, 'STREAMS').occurrences[0]?.checkpoint).toBeNull()
	expect(db.query('SELECT * FROM workflow_streams').all()).toHaveLength(0)
	expect(db.query('SELECT * FROM workflow_stream_chunks').all()).toHaveLength(0)
})

test.each(['response', 'blob'])('optimized %s bodies transfer ownership, persist bytes, and reject reused sources', async kind => {
	const bytes = Uint8Array.from({ length: 150000 }, (_, index) => index % 251)
	const input = kind === 'response' ? new Response(bytes).body : new Blob([bytes]).stream()
	if (!input) throw new Error('No body')
	const binding = bind(async step => inspect(await step.do('bytes', async () => input)))
	const instance = await binding.create()
	await terminal(instance)
	expect((await instance.status()).output).toEqual({ count: 150000, maxChunk: 65536 })
	const reused = await binding.create()
	await terminal(reused)
	expect((await reused.status()).status).toBe('errored')
})

test.each(['default', 'response', 'blob'])('write failure propagates cancellation to the owned %s body and releases its reader', async kind => {
	const bytes = new Uint8Array(200000)
	let sourceCancellations = 0
	const input = kind === 'response' ? new Response(bytes).body : kind === 'blob' ? new Blob([bytes]).stream() : new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes)
		},
		cancel() {
			sourceCancellations++
		},
	}, { highWaterMark: 0 })
	if (!input) throw new Error('No source')
	const cancellations: Promise<void>[] = []
	const released: ReadableStreamDefaultReader<Uint8Array>[] = []
	const cancelled: ReadableStreamDefaultReader<Uint8Array>[] = []
	const originalCancel = ReadableStreamDefaultReader.prototype.cancel
	const originalRelease = ReadableStreamDefaultReader.prototype.releaseLock
	const cancelSpy = spyOn(ReadableStreamDefaultReader.prototype, 'cancel').mockImplementation(
		function(this: ReadableStreamDefaultReader<Uint8Array>, reason?: unknown) {
			cancelled.push(this)
			const result = originalCancel.call(this, reason)
			cancellations.push(result)
			return result
		},
	)
	const releaseSpy = spyOn(ReadableStreamDefaultReader.prototype, 'releaseLock').mockImplementation(
		function(this: ReadableStreamDefaultReader<Uint8Array>) {
			released.push(this)
			return originalRelease.call(this)
		},
	)
	try {
		db.run("CREATE TRIGGER fail_stream BEFORE INSERT ON workflow_stream_chunks BEGIN SELECT RAISE(FAIL, 'write failed'); END")
		const binding = bind(async step => step.do('bytes', async () => input))
		const instance = await binding.create()
		await terminal(instance)
		expect((await instance.status()).status).toBe('errored')
		expect(cancelled).toHaveLength(1)
		const cancelledReader = cancelled[0]
		if (!cancelledReader) throw new Error('No cancelled reader')
		expect(released).toContain(cancelledReader)
		await Promise.all(cancellations)
		if (kind === 'default') {
			expect(sourceCancellations).toBe(1)
			expect(input.locked).toBe(false)
		} else {
			expect(input.locked).toBe(true)
		}
	} finally {
		cancelSpy.mockRestore()
		releaseSpy.mockRestore()
	}
})

test('a reader fetches only the requested chunk and reports later corruption on pull', async () => {
	const binding = bind(async step => {
		await step.do('bytes', async () => source())
		return 'done'
	})
	const instance = await binding.create()
	await terminal(instance)
	const id = streamId(instance.id)
	const reader = new WorkflowStore(db).openStream(id).getReader()
	db.query('DELETE FROM workflow_stream_chunks WHERE stream_id = ? AND chunk_index = 0').run(id)
	await expect(reader.read()).rejects.toThrow('missing or invalid chunk 0')
	reader.releaseLock()
})

test('attempt and epoch fences reject stale writers without sweeping the current writer', async () => {
	const binding = bind(async () => 'unused')
	const instance = await binding._createPrepared()
	const store = new WorkflowStore(db)
	const token = store.acquireExecution(instance.id, 'STREAMS')
	const record = store.openOccurrence(token, { key: { type: 'do', name: 'bytes', count: 1 }, method: 'do', startOrder: 1, rollbackRegistered: false })
	const ref = { token, occurrenceId: record.id }
	const old = store.beginStream(ref, store.startAttempt(ref, 1))
	store.appendStreamChunk(old, new Uint8Array([1]))
	const current = store.beginStream(ref, store.startAttempt(ref, 2))
	expect(() => store.appendStreamChunk(old, new Uint8Array([2]))).toThrow('Stale')
	store.appendStreamChunk(current, new Uint8Array([3]))
	expect(db.query('SELECT * FROM workflow_streams').all()).toHaveLength(1)
	store.acquireExecution(instance.id, 'STREAMS')
	expect(() => store.commitStream(current, Date.now())).toThrow('Stale')
	expect(db.query('SELECT * FROM workflow_streams').all()).toHaveLength(0)
	expect(db.query('SELECT * FROM workflow_stream_chunks').all()).toHaveLength(0)
})

test('cleanup is retried after storage becomes writable, without needing a failure row', async () => {
	const binding = bind(async () => 'unused')
	const instance = await binding._createPrepared()
	const store = new WorkflowStore(db)
	const token = store.acquireExecution(instance.id, 'STREAMS')
	const record = store.openOccurrence(token, { key: { type: 'do', name: 'bytes', count: 1 }, method: 'do', startOrder: 1, rollbackRegistered: false })
	const ref = { token, occurrenceId: record.id }
	const attemptToken = store.startAttempt(ref, 1)
	const stream = store.beginStream(ref, attemptToken)
	store.appendStreamChunk(stream, new Uint8Array([1]))
	db.run("CREATE TRIGGER fail_updates BEFORE UPDATE ON workflow_occurrences BEGIN SELECT RAISE(FAIL, 'disk full'); END")
	db.run("CREATE TRIGGER fail_cleanup BEFORE DELETE ON workflow_stream_chunks BEGIN SELECT RAISE(FAIL, 'disk full'); END")
	store.invalidateStreamAttempt(ref, attemptToken)
	expect(db.query('SELECT * FROM workflow_streams').all()).toHaveLength(1)
	db.run('DROP TRIGGER fail_updates')
	db.run('DROP TRIGGER fail_cleanup')
	store.acquireExecution(instance.id, 'STREAMS')
	expect(db.query('SELECT * FROM workflow_streams').all()).toHaveLength(0)
	expect(db.query('SELECT * FROM workflow_stream_chunks').all()).toHaveLength(0)
	expect(store.readDetail(instance.id, 'STREAMS').occurrences[0]?.failedAttempts).toBe(0)
})

test('restart during a stuck write cancels it and cannot publish late bytes into the replacement run', async () => {
	let calls = 0
	let cancellations = 0
	const input = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array([1]))
		},
		cancel() {
			cancellations++
			return new Promise<void>(() => {})
		},
	}, { highWaterMark: 0 })
	const binding = bind(async step => {
		const result = await step.do('bytes', async () => ++calls === 1 ? input : source())
		return inspect(result)
	})
	const instance = await binding.create()
	await until(() => db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM workflow_stream_chunks').get()?.n === 1)
	await instance.restart()
	await terminal(instance)
	expect((await instance.status()).output).toEqual({ count: 150000, maxChunk: 65536 })
	expect(cancellations).toBe(1)
	expect(input.locked).toBe(false)
	expect(db.query('SELECT * FROM workflow_streams').all()).toHaveLength(1)
})

test.each(['chunk', 'commit'])('SQLite %s failure cancels the source and rolls back partial publication', async failure => {
	let cancellations = 0
	const input = new ReadableStream<Uint8Array>({
		pull(controller) {
			controller.enqueue(new Uint8Array(65536))
		},
		cancel() {
			cancellations++
		},
	}, { highWaterMark: 0 })
	if (failure === 'chunk') {
		db.run("CREATE TRIGGER fail_stream BEFORE INSERT ON workflow_stream_chunks BEGIN SELECT RAISE(FAIL, 'injected disk full'); END")
	} else {db.run(
			"CREATE TRIGGER fail_stream BEFORE UPDATE OF stream_id ON workflow_occurrences BEGIN SELECT RAISE(FAIL, 'injected commit failure'); END",
		)}
	const binding = bind(async step => step.do('bytes', async () => failure === 'chunk' ? input : source()))
	const instance = await binding.create()
	await terminal(instance)
	expect((await instance.status()).status).toBe('errored')
	expect(new WorkflowStore(db).readDetail(instance.id, 'STREAMS').occurrences[0]?.checkpoint).toBeNull()
	expect(db.query('SELECT * FROM workflow_streams').all()).toHaveLength(0)
	expect(db.query('SELECT * FROM workflow_stream_chunks').all()).toHaveLength(0)
	if (failure === 'chunk') {
		expect(cancellations).toBe(1)
		expect(input.locked).toBe(false)
	}
})

test('SQLite page exhaustion fails a stream checkpoint and can recover after explicit restart', async () => {
	const pages = db.query<{ page_count: number }, []>('PRAGMA page_count').get()?.page_count
	if (pages === undefined) throw new Error('Missing page count')
	db.run(`PRAGMA max_page_count = ${pages + 2}`)
	const binding = bind(async step => inspect(await step.do('bytes', async () => source(200000))))
	const instance = await binding.create()
	try {
		await terminal(instance)
		expect((await instance.status()).status).toBe('errored')
		expect((await instance.status()).error?.message).toContain('full')
		expect(new WorkflowStore(db).readDetail(instance.id, 'STREAMS').occurrences[0]?.checkpoint).toBeNull()
	} finally {
		db.run('PRAGMA max_page_count = 1073741823')
	}
	await instance.restart()
	await terminal(instance)
	expect((await instance.status()).output).toEqual({ count: 200000, maxChunk: 65536 })
	expect(db.query("SELECT * FROM workflow_streams WHERE state = 'writing'").all()).toHaveLength(0)
})

test('missing committed chunks fail replay without repeating effects or executing compensation', async () => {
	let calls = 0
	let undos = 0
	const binding = bind(async step => {
		await step.do('bytes', async () => {
			calls++
			return source()
		}, {
			rollback: async () => {
				undos++
			},
		})
		await step.waitForEvent('gate', { type: 'go' })
	})
	const instance = await binding.create()
	await until(async () => (await instance.status()).status === 'waiting')
	binding.abortRunning()
	await Bun.sleep(20)
	db.query('DELETE FROM workflow_stream_chunks WHERE stream_id = ? AND chunk_index = 1').run(streamId(instance.id))
	binding.resumeInterrupted()
	await terminal(instance)
	expect((await instance.status()).error?.message).toContain('Corrupt workflow stream')
	expect(calls).toBe(1)
	expect(undos).toBe(0)
})

test('targeted restart retains prefix streams and reclaims only discarded streams', async () => {
	let prefixCalls = 0
	let suffixCalls = 0
	const binding = bind(async step => {
		await inspect(
			await step.do('prefix', async () => {
				prefixCalls++
				return source()
			}),
		)
		await inspect(
			await step.do('suffix', async () => {
				suffixCalls++
				return source()
			}),
		)
	})
	const instance = await binding.create()
	await terminal(instance)
	const prefixId = streamId(instance.id)
	await instance.restart({ from: { name: 'suffix' } })
	await terminal(instance)
	expect(prefixCalls).toBe(1)
	expect(suffixCalls).toBe(2)
	expect(streamId(instance.id)).toBe(prefixId)
	expect(db.query('SELECT * FROM workflow_streams').all()).toHaveLength(2)
	await instance.restart()
	await terminal(instance)
	expect(prefixCalls).toBe(2)
	expect(db.query('SELECT * FROM workflow_streams').all()).toHaveLength(2)
})

test('configured retention removes owned manifests and chunks', async () => {
	const binding = bind(async step => {
		await step.do('bytes', async () => source())
		return 'done'
	}, { maxRetentionMs: 1 })
	const first = await binding.create()
	await terminal(first)
	const id = streamId(first.id)
	await Bun.sleep(10)
	const next = await binding.create()
	await terminal(next)
	expect(db.query('SELECT * FROM workflow_streams WHERE id = ?').all(id)).toHaveLength(0)
	expect(db.query('SELECT * FROM workflow_stream_chunks WHERE stream_id = ?').all(id)).toHaveLength(0)
})

test('terminate reclaims a fenced writer with default retention disabled', async () => {
	const input = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array([42]))
		},
	})
	const binding = bind(async step => step.do('bytes', async () => input))
	const instance = await binding.create()
	await until(() => db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM workflow_stream_chunks').get()?.n === 1)
	await instance.terminate()
	expect((await instance.status()).status).toBe('terminated')
	expect(input.locked).toBe(false)
	expect(db.query('SELECT * FROM workflow_streams').all()).toHaveLength(0)
	expect(db.query('SELECT * FROM workflow_stream_chunks').all()).toHaveLength(0)
})

test.each(['terminated', 'errored'])('recovery retries failed cleanup of %s writes without fencing a live owner', async outcome => {
	let failedController: ReadableStreamDefaultController<Uint8Array> | undefined
	const failedSource = new ReadableStream<Uint8Array>({
		start(controller) {
			failedController = controller
			controller.enqueue(new Uint8Array([42]))
		},
	})
	const failedBinding = bind(async step => step.do('bytes', async () => failedSource))
	const failed = await failedBinding.create({ id: 'failed-cleanup' })
	await until(() => db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM workflow_stream_chunks').get()?.n === 1)
	db.run("CREATE TRIGGER fail_cleanup BEFORE DELETE ON workflow_stream_chunks BEGIN SELECT RAISE(FAIL, 'cleanup unavailable'); END")
	if (outcome === 'terminated') await failed.terminate()
	else {
		if (!failedController) throw new Error('No failed writer')
		failedController.error(new Error('source failed'))
		await terminal(failed)
	}
	expect((await failed.status()).status).toBe(outcome)
	expect(db.query('SELECT * FROM workflow_streams').all()).toHaveLength(1)
	expect(db.query('SELECT * FROM workflow_stream_chunks').all()).toHaveLength(1)
	db.run('DROP TRIGGER fail_cleanup')
	let liveController: ReadableStreamDefaultController<Uint8Array> | undefined
	const liveSource = new ReadableStream<Uint8Array>({
		start(controller) {
			liveController = controller
			controller.enqueue(new Uint8Array([42]))
		},
	})
	let liveCalls = 0
	const liveBinding = bind(async step => {
		const stream = await step.do('bytes', async () => {
			liveCalls++
			return liveSource
		})
		let byte: number | undefined
		for await (const chunk of stream) byte = chunk[0]
		return byte
	})
	const live = await liveBinding.create({ id: 'live-owner' })
	await until(() => db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM workflow_stream_chunks').get()?.n === 2)
	const store = new WorkflowStore(db)
	const liveToken = store.currentToken(live.id)
	failedBinding.resumeInterrupted()
	expect(store.currentToken(live.id)).toEqual(liveToken)
	expect((await failed.status()).status).toBe(outcome)
	expect(db.query('SELECT * FROM workflow_streams').all()).toHaveLength(1)
	expect(db.query('SELECT * FROM workflow_stream_chunks').all()).toHaveLength(1)
	if (!liveController) throw new Error('No live writer')
	liveController.close()
	await terminal(live)
	expect((await live.status()).output).toBe(42)
	expect(liveCalls).toBe(1)
})

test('live and cached helpers return independent durable streams and surface corruption', async () => {
	let calls = 0
	const binding = bind(async step => {
		for (const byte of [42, 43]) {
			await step.do('bytes', async () => {
				calls++
				return new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new Uint8Array([byte]))
						controller.close()
					},
				})
			})
		}
	})
	const helper = new TestWorkflowBinding(binding, db)
	try {
		const instance = await helper.prepare()
		const live = instance.waitForStep('bytes')
		await instance.start()
		await instance.waitForStatus('complete')
		async function readByte(output: unknown) {
			if (!(output instanceof ReadableStream)) throw new Error('Expected a helper stream')
			const reader = output.getReader()
			try {
				const { value } = await reader.read()
				if (!(value instanceof Uint8Array)) throw new Error('Expected a byte chunk')
				return value[0]
			} finally {
				await reader.cancel()
				reader.releaseLock()
			}
		}
		expect(await readByte(await live)).toBe(42)
		expect(await readByte(await instance.waitForStep('bytes'))).toBe(42)
		expect(await readByte(await instance.waitForStep('bytes', { type: 'do', count: 2 }))).toBe(43)
		expect(await readByte(await instance.stepResult('bytes'))).toBe(42)
		expect(await readByte(await instance.stepResult('bytes', { type: 'do', count: 2 }))).toBe(43)
		expect(await readByte((await instance.steps()).get('bytes'))).toBe(42)
		expect(await readByte((await instance.steps()).get('bytes'))).toBe(42)
		db.query('DELETE FROM workflow_stream_chunks WHERE stream_id = ?').run(streamId(instance.id))
		await expect(instance.waitForStep('bytes')).rejects.toThrow('Corrupt workflow stream')
		await expect(instance.stepResult('bytes')).rejects.toThrow('Corrupt workflow stream')
		await expect(instance.steps()).rejects.toThrow('Corrupt workflow stream')
		expect(calls).toBe(2)
	} finally {
		helper.dispose()
	}
})

test.each(['writing', 'committed', 'retry', 'rollback', 'terminated'])(
	'fresh process recovers a %s stream using only committed checkpoints',
	async phase => {
		const dir = mkdtempSync(join(tmpdir(), 'workflow-streams-'))
		try {
			const path = join(dir, 'state.sqlite')
			for (const mode of [phase, 'recover']) {
				const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/workflow-streams-process.ts'), path, mode], {
					stdout: 'pipe',
					stderr: 'pipe',
				})
				const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
				if (exit !== 0) throw new Error(`Child failed: ${stdout}\n${stderr}`)
			}
			const saved = new Database(path)
			try {
				expect(saved.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM effects').get()?.count).toBe(
					phase === 'writing' || phase === 'retry' ? 2 : 1,
				)
				if (phase === 'retry') expect(saved.query<{ attempt: number }, []>('SELECT MAX(attempt) AS attempt FROM effects').get()?.attempt).toBe(2)
				if (phase === 'rollback') {
					expect(saved.query<{ bytes: number }, []>('SELECT bytes FROM undos').all()).toEqual([{ bytes: 180000 }, { bytes: 180000 }])
				}
				expect(saved.query("SELECT * FROM workflow_streams WHERE state = 'writing'").all()).toHaveLength(0)
				expect(saved.query('SELECT * FROM workflow_streams').all()).toHaveLength(phase === 'terminated' ? 0 : 1)
			} finally {
				saved.close()
			}
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	},
)

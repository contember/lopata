import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { NonRetryableError, SqliteWorkflowBinding, WorkflowEntrypointBase } from '../src/bindings/workflow'
import type { WorkflowLimits, WorkflowStepImpl } from '../src/bindings/workflow'
import { checkpointOutput, WorkflowStore } from '../src/bindings/workflow-store'
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
function storedOutput(id: string, index = 0): unknown {
	const checkpoint = new WorkflowStore(db).readDetail(id, 'STREAMS').occurrences[index]?.checkpoint
	if (checkpoint?.kind !== 'stream') throw new Error('Expected a stream checkpoint')
	return checkpointOutput(checkpoint)
}

test('large binary results bypass the JSON cap and replay without re-running the step', async () => {
	let calls = 0
	const binding = bind(async step => {
		const output = await step.do('bytes', async () => {
			calls++
			return source(1100000)
		})
		const result = await inspect(output)
		await step.waitForEvent('gate', { type: 'go' })
		return result
	}, { maxStepOutputBytes: 256 })
	const instance = await binding.create()
	await until(async () => (await instance.status()).status === 'waiting')
	const stored = storedOutput(instance.id)
	if (!(stored instanceof ReadableStream)) throw new Error('Expected a stored stream')
	expect((await inspect(stored)).count).toBe(1100000)
	binding.abortRunning()
	await Bun.sleep(20)
	binding.resumeInterrupted()
	await until(async () => (await instance.status()).status === 'waiting')
	await instance.sendEvent({ type: 'go' })
	await terminal(instance)
	expect((await instance.status()).output).toMatchObject({ count: 1100000 })
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

test.each(['locked', 'malformed', 'read-error'])('rejects %s streams without publishing a checkpoint', async kind => {
	const input = new ReadableStream<unknown>({
		start(controller) {
			if (kind === 'read-error') controller.error(new Error('source failed'))
			else controller.enqueue(kind === 'malformed' ? 'not bytes' : new Uint8Array([1]))
		},
	})
	const reader = kind === 'locked' ? input.getReader() : undefined
	const binding = bind(async step => step.do('bytes', async () => input))
	const instance = await binding.create()
	await terminal(instance)
	expect((await instance.status()).status).toBe('errored')
	expect(new WorkflowStore(db).readDetail(instance.id, 'STREAMS').occurrences[0]?.checkpoint).toBeNull()
	reader?.releaseLock()
})

test('empty streams commit and replay as empty streams', async () => {
	const binding = bind(async step => inspect(await step.do('bytes', async () => source(0))))
	const instance = await binding.create()
	await terminal(instance)
	expect((await instance.status()).output).toEqual({ count: 0, maxChunk: 0 })
	const stored = storedOutput(instance.id)
	if (!(stored instanceof ReadableStream)) throw new Error('Expected a stored stream')
	expect((await inspect(stored)).count).toBe(0)
})

test('targeted restart keeps prefix stream checkpoints', async () => {
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
	await instance.restart({ from: { name: 'suffix' } })
	await terminal(instance)
	expect(prefixCalls).toBe(1)
	expect(suffixCalls).toBe(2)
	const stored = storedOutput(instance.id)
	if (!(stored instanceof ReadableStream)) throw new Error('Expected a stored stream')
	expect((await inspect(stored)).count).toBe(150000)
})

test('live and cached helpers return independent streams', async () => {
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
		expect(calls).toBe(2)
	} finally {
		helper.dispose()
	}
})

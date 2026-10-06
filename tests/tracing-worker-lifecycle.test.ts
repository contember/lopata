import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { TraceCompletion } from '../src/tracing/invocation'
import { OutboundStreamRegistry, pumpStream } from '../src/worker-thread/stream-shared'

test('a credit-blocked pump retains cancellation cleanup and reports its failure', async () => {
	const cleanup = Promise.withResolvers<void>()
	const cancellationStarted = Promise.withResolvers<void>()
	const completed = Promise.withResolvers<TraceCompletion>()
	let finished = false
	const registry = new OutboundStreamRegistry()
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array([1]))
		},
		cancel() {
			cancellationStarted.resolve()
			return cleanup.promise
		},
	})
	pumpStream(
		1,
		body,
		registry,
		() => {},
		{
			chunk: () => 'chunk',
			end: () => 'end',
			error: () => 'error',
		},
		undefined,
		0,
		result => {
			finished = true
			completed.resolve(result)
		},
	)
	await Bun.sleep(0)
	registry.cancel(1)
	await cancellationStarted.promise
	expect(finished).toBe(false)
	expect(registry.activeCount()).toBe(1)
	const error = new Error('cleanup rejected')
	cleanup.reject(error)
	expect(await completed.promise).toEqual({ kind: 'error', error })
	expect(registry.activeCount()).toBe(0)
	expect(body.locked).toBe(false)
})

test('a failed stream post still cancels the source and reports completion after cleanup', async () => {
	const cleanup = Promise.withResolvers<void>()
	const cancellationStarted = Promise.withResolvers<void>()
	const completed = Promise.withResolvers<TraceCompletion>()
	let finished = false
	const registry = new OutboundStreamRegistry()
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array([1]))
		},
		cancel() {
			cancellationStarted.resolve()
			return cleanup.promise
		},
	})
	const error = new Error('transport closed')
	pumpStream(
		1,
		body,
		registry,
		() => {
			throw error
		},
		{
			chunk: () => 'chunk',
			end: () => 'end',
			error: () => 'error',
		},
		undefined,
		undefined,
		result => {
			finished = true
			completed.resolve(result)
		},
	)
	await cancellationStarted.promise
	expect(finished).toBe(false)
	cleanup.resolve()
	expect(await completed.promise).toEqual({ kind: 'error', error })
	expect(body.locked).toBe(false)
	expect(registry.activeCount()).toBe(0)
})

for (const scenario of ['body', 'background', 'cancel', 'concurrency', 'terminate', 'crash', 'failures', 'handlers', 'late-messages']) {
	test(`ordinary worker invocation lifecycle: ${scenario}`, async () => {
		const directory = mkdtempSync(join(tmpdir(), 'lopata-tracing-worker-'))
		const child = Bun.spawn([process.execPath, resolve(import.meta.dir, 'fixtures/tracing-worker-lifecycle/runner.ts'), scenario], {
			cwd: directory,
			stdout: 'pipe',
			stderr: 'pipe',
		})
		try {
			const [code, output, errors] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			])
			if (code !== 0) throw new Error(`Worker lifecycle ${scenario} failed (${code}):\n${output}\n${errors}`)
			expect(code).toBe(0)
		} finally {
			child.kill()
			rmSync(directory, { recursive: true, force: true })
		}
	}, 20000)
}

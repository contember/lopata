import { expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkerLoaderBinding } from '../src/bindings/worker-loader'
import type { LoaderInitMessage, MainToWorker, WorkerToMain } from '../src/bindings/worker-loader-entry'
import { resolveCompatibility } from '../src/compatibility'

test('isolated runtime compatibility boundaries, callee ownership and reload', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'lopata-compatibility-wiring-'))
	const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/compatibility-wiring-runner.ts')], {
		cwd: directory,
		stdout: 'pipe',
		stderr: 'pipe',
	})
	try {
		const stdout = new Response(child.stdout).text()
		const stderr = new Response(child.stderr).text()
		const code = await child.exited
		const output = await stdout
		const errors = await stderr
		if (code !== 0) throw new Error(`Compatibility runner failed (${code}):\n${output}\n${errors}`)
		expect(output).toContain('compatibility wiring passed')
	} finally {
		child.kill()
		rmSync(directory, { recursive: true, force: true })
	}
}, 30000)

test('dynamic compatibility rejects eager, lazy and mutated descriptors before writing modules', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'lopata-compatibility-loader-'))
	const loader = new WorkerLoaderBinding(directory)
	const descriptor = { compatibilityDate: '2026-02-30', mainModule: 'main.js', modules: { 'main.js': 'throw new Error("must not evaluate")' } }
	try {
		expect(() => loader.load(descriptor)).toThrow('Gregorian')
		const lazy = loader.get('invalid-date', () => descriptor)
		await expect(lazy.getEntrypoint().fetch('https://worker.test')).rejects.toThrow('Gregorian')
		const conflict = loader.get('conflict', () => ({
			...descriptor,
			compatibilityDate: '2026-10-01',
			compatibilityFlags: ['delete_all_deletes_alarm', 'delete_all_preserves_alarm'],
		}))
		await expect(conflict.getEntrypoint().fetch('https://worker.test')).rejects.toThrow('Conflicting')
		const mutable = { ...descriptor, compatibilityDate: '2026-10-01' }
		const stub = loader.load(mutable)
		try {
			mutable.compatibilityDate = 'bad'
			await expect(stub.getEntrypoint().fetch('https://worker.test')).rejects.toThrow('YYYY-MM-DD')
		} finally {
			stub.dispose()
		}
		expect(readdirSync(directory)).toEqual([])
	} finally {
		loader.disposeAll()
		rmSync(directory, { recursive: true, force: true })
	}
})

test('dynamic receiver recomputes derived selection and rejects conflicting cloned input', async () => {
	async function initialize(compatibility: LoaderInitMessage['compatibility']): Promise<WorkerToMain> {
		const worker = new Worker(join(import.meta.dir, '../src/bindings/worker-loader-entry.ts'))
		try {
			return await new Promise<WorkerToMain>((resolve, reject) => {
				worker.onerror = event => reject(new Error(event.message))
				worker.onmessage = (event: MessageEvent<WorkerToMain>) => {
					const message = event.data
					if (message.type === 'need-init') {
						worker.postMessage(
							{
								type: 'init',
								data: {
									type: 'init',
									compatibility,
									mainModulePath: join(import.meta.dir, 'fixtures/compatibility-wiring-worker.ts'),
									env: {},
									globalOutbound: 'allow',
								},
							} satisfies MainToWorker,
						)
					} else if (message.type === 'ready') {
						worker.postMessage(
							{
								type: 'command',
								id: 1,
								command: { type: 'fetch', url: 'https://worker.test', method: 'GET', headers: [], body: null },
							} satisfies MainToWorker,
						)
					} else {
						resolve(message)
					}
				}
			})
		} finally {
			worker.terminate()
		}
	}
	const baseline = resolveCompatibility({ flags: ['unknown_flag', 'no_websocket_close_reason_byte_limit'] })
	const response = await initialize({ ...baseline, websocketCloseReasonByteLimit: 'enabled' })
	if (response.type !== 'result' || response.result.type !== 'fetch') throw new Error('Expected worker response')
	expect(await new Response(response.result.body).json()).toEqual({ topLevelLimited: false, limited: false })
	const failure = await initialize({ ...baseline, flags: ['web_socket_auto_reply_to_close', 'web_socket_manual_reply_to_close'] })
	if (failure.type !== 'result' || failure.result.type !== 'error') throw new Error('Expected init rejection')
	expect(failure.id).toBe(-1)
	expect(failure.result.message).toContain('Conflicting compatibility flags')
})

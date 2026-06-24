import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkerLoaderBinding } from '../src/bindings/worker-loader'

let tmpDir: string
let loader: WorkerLoaderBinding
const stubsToDispose: { dispose: () => void }[] = []

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'lopata-loader-'))
	loader = new WorkerLoaderBinding(tmpDir)
})

afterEach(() => {
	for (const stub of stubsToDispose.splice(0)) stub.dispose()
	loader.disposeAll()
	rmSync(tmpDir, { recursive: true, force: true })
})

function track<T extends { dispose: () => void }>(stub: T): T {
	stubsToDispose.push(stub)
	return stub
}

describe('WorkerLoaderBinding.load()', () => {
	test('fetch() returns worker response', async () => {
		const stub = track(
			loader.load({
				compatibilityDate: '2026-03-01',
				mainModule: 'main.js',
				modules: {
					'main.js': `export default { fetch(req) { return new Response('hello from loader: ' + new URL(req.url).pathname) } }`,
				},
			}),
		)
		const resp = await stub.getEntrypoint().fetch('http://loader/path')
		expect(resp.status).toBe(200)
		expect(await resp.text()).toBe('hello from loader: /path')
	})

	test('env is passed through to the worker', async () => {
		const stub = track(
			loader.load({
				compatibilityDate: '2026-03-01',
				mainModule: 'main.js',
				modules: {
					'main.js': `export default { fetch(req, env) { return new Response(JSON.stringify(env)) } }`,
				},
				env: { FOO: 'bar', COUNT: 42 },
			}),
		)
		const resp = await stub.getEntrypoint().fetch('http://loader/')
		expect(await resp.json()).toEqual({ FOO: 'bar', COUNT: 42 })
	})

	test('named entrypoint RPC — call method on exported class instance', async () => {
		const stub = track(
			loader.load({
				compatibilityDate: '2026-03-01',
				mainModule: 'main.js',
				modules: {
					'main.js': `
						export class Agent {
							constructor(ctx, env) { this.env = env }
							greet(name) { return 'hi ' + name + ' from ' + this.env.WORKER }
						}
					`,
				},
				env: { WORKER: 'dynamic-1' },
			}),
		)
		const agent = stub.getEntrypoint('Agent')
		const result = await (agent.greet as (n: string) => Promise<string>)('alice')
		expect(result).toBe('hi alice from dynamic-1')
	})

	test('multi-module — imports resolve between module files', async () => {
		const stub = track(
			loader.load({
				compatibilityDate: '2026-03-01',
				mainModule: 'main.js',
				modules: {
					'main.js': `
						import { greet } from './util.js'
						export default { fetch(req) { return new Response(greet('world')) } }
					`,
					'util.js': `export function greet(n) { return 'hello, ' + n }`,
				},
			}),
		)
		const resp = await stub.getEntrypoint().fetch('http://loader/')
		expect(await resp.text()).toBe('hello, world')
	})

	test('json module loads as default export', async () => {
		const stub = track(
			loader.load({
				compatibilityDate: '2026-03-01',
				mainModule: 'main.js',
				modules: {
					'main.js': `
						import cfg from './config.json'
						export default { fetch() { return new Response(JSON.stringify(cfg)) } }
					`,
					'config.json': { json: { feature: 'enabled', limit: 10 } },
				},
			}),
		)
		const resp = await stub.getEntrypoint().fetch('http://loader/')
		expect(await resp.json()).toEqual({ feature: 'enabled', limit: 10 })
	})

	test('error in handler surfaces as rejected promise', async () => {
		const stub = track(
			loader.load({
				compatibilityDate: '2026-03-01',
				mainModule: 'main.js',
				modules: {
					'main.js': `export default { fetch() { throw new Error('boom') } }`,
				},
			}),
		)
		await expect(stub.getEntrypoint().fetch('http://loader/')).rejects.toThrow(/boom/)
	})

	test('missing default export — fetch() fails with clear error', async () => {
		const stub = track(
			loader.load({
				compatibilityDate: '2026-03-01',
				mainModule: 'main.js',
				modules: { 'main.js': `export const notDefault = 1` },
			}),
		)
		await expect(stub.getEntrypoint().fetch('http://loader/')).rejects.toThrow(/no default export/)
	})

	test('validation — missing mainModule in modules map rejected', () => {
		expect(() =>
			loader.load({
				compatibilityDate: '2026-03-01',
				mainModule: 'missing.js',
				modules: { 'other.js': 'export default {}' },
			})
		).toThrow(/not present in modules map/)
	})

	test('validation — missing compatibilityDate rejected', () => {
		expect(() =>
			loader.load({
				compatibilityDate: '',
				mainModule: 'main.js',
				modules: { 'main.js': 'export default {}' },
			})
		).toThrow(/compatibilityDate/)
	})

	test('globalOutbound: null blocks fetch in worker', async () => {
		const stub = track(
			loader.load({
				compatibilityDate: '2026-03-01',
				mainModule: 'main.js',
				modules: {
					'main.js': `
						export default { async fetch(req) {
							try { await fetch('http://example.com') } catch (e) { return new Response('blocked: ' + e.message) }
							return new Response('not blocked')
						} }
					`,
				},
				globalOutbound: null,
			}),
		)
		const resp = await stub.getEntrypoint().fetch('http://loader/')
		const text = await resp.text()
		expect(text).toContain('blocked')
	})
})

describe('WorkerLoaderBinding.get()', () => {
	test('caches by id — second call returns the same stub', () => {
		const code = {
			compatibilityDate: '2026-03-01',
			mainModule: 'main.js',
			modules: { 'main.js': 'export default { fetch() { return new Response("x") } }' },
		}
		const a = loader.get('agent-1', () => code)
		const b = loader.get('agent-1', () => code)
		expect(a).toBe(b)
	})

	test('different ids get different stubs', () => {
		const code = {
			compatibilityDate: '2026-03-01',
			mainModule: 'main.js',
			modules: { 'main.js': 'export default { fetch() { return new Response("x") } }' },
		}
		const a = loader.get('agent-1', () => code)
		const b = loader.get('agent-2', () => code)
		expect(a).not.toBe(b)
	})

	test('async getCodeCallback is invoked lazily and awaited', async () => {
		let calls = 0
		const stub = loader.get('lazy', async () => {
			calls++
			// Simulate fetching code from KV / a DB
			await new Promise(res => setTimeout(res, 10))
			return {
				compatibilityDate: '2026-03-01',
				mainModule: 'main.js',
				modules: { 'main.js': 'export default { fetch() { return new Response("lazy ok") } }' },
			}
		})
		expect(calls).toBe(0) // not yet invoked
		stubsToDispose.push(stub)

		const resp = await stub.getEntrypoint().fetch('http://loader/')
		expect(await resp.text()).toBe('lazy ok')
		expect(calls).toBe(1)

		// Second call reuses the cached stub, does not re-invoke callback
		const resp2 = await stub.getEntrypoint().fetch('http://loader/')
		expect(await resp2.text()).toBe('lazy ok')
		expect(calls).toBe(1)
	})
})

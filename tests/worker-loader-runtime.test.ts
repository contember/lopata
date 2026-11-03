import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { WorkerEntrypoint } from 'cloudflare:workers'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServiceBinding } from '../src/bindings/service-binding'
import { type WorkerCode, WorkerLoaderBinding, type WorkerStub } from '../src/bindings/worker-loader'

let tmpDir: string
let loader: WorkerLoaderBinding

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'lopata-loader-runtime-'))
	loader = new WorkerLoaderBinding(tmpDir)
})

afterEach(() => {
	loader.disposeAll()
	rmSync(tmpDir, { recursive: true, force: true })
})

const stubs: WorkerStub[] = []
afterEach(() => {
	for (const stub of stubs.splice(0)) stub.dispose()
})

function load(main: string, extra: Partial<WorkerCode> = {}): WorkerStub {
	const stub = loader.load({ compatibilityDate: '2026-03-01', mainModule: 'main.js', modules: { 'main.js': main }, ...extra })
	stubs.push(stub)
	return stub
}

async function text(response: Promise<Response>): Promise<string> {
	return (await response).text()
}

describe('dynamic worker runtime', () => {
	test('cloudflare:workers and the Workers globals are available, with the loader env published before the module runs', async () => {
		const stub = load(
			`import { env, WorkerEntrypoint, DurableObject } from 'cloudflare:workers'
			const atImport = env.NAME
			export default {
				fetch() {
					return Response.json({
						atImport,
						entrypoint: typeof WorkerEntrypoint,
						durableObject: typeof DurableObject,
						caches: typeof caches?.default?.match,
						rewriter: typeof HTMLRewriter,
						pair: typeof WebSocketPair,
					})
				},
			}`,
			{ env: { NAME: 'tenant-a' } },
		)
		expect(await (await stub.getEntrypoint().fetch('http://loader/')).json()).toEqual({
			atImport: 'tenant-a',
			entrypoint: 'function',
			durableObject: 'function',
			caches: 'function',
			rewriter: 'function',
			pair: 'function',
		})
	})

	test('a WorkerEntrypoint default export is constructed per invocation with env and ctx.props', async () => {
		const stub = load(
			`import { WorkerEntrypoint } from 'cloudflare:workers'
			let constructed = 0
			export default class extends WorkerEntrypoint {
				constructor(ctx, env) { super(ctx, env); constructed++ }
				fetch() { return new Response(this.env.NAME + ':' + this.ctx.props.tenant + ':' + constructed) }
			}`,
			{ env: { NAME: 'dyn' } },
		)
		const entrypoint = stub.getEntrypoint(null, { props: { tenant: 't1' } })
		expect(await text(entrypoint.fetch('http://loader/'))).toBe('dyn:t1:1')
		expect(await text(entrypoint.fetch('http://loader/'))).toBe('dyn:t1:2')
		expect(await text(stub.getEntrypoint('default').fetch('http://loader/'))).toBe('dyn:undefined:3')
	})

	test('named entrypoint RPC sees the props of its handle', async () => {
		const stub = load(
			`import { WorkerEntrypoint } from 'cloudflare:workers'
			export class Api extends WorkerEntrypoint {
				whoami() { return this.ctx.props.user }
			}
			export default { fetch() { return new Response('ok') } }`,
		)
		const alice = stub.getEntrypoint('Api', { props: { user: 'alice' } })
		const bob = stub.getEntrypoint('Api', { props: { user: 'bob' } })
		expect(await (alice.whoami as () => Promise<string>)()).toBe('alice')
		expect(await (bob.whoami as () => Promise<string>)()).toBe('bob')
	})

	test('props are snapshotted when the handle is created', async () => {
		const stub = load(`export default { fetch(request, env, ctx) { return Response.json(ctx.props) } }`)
		const props = { tags: new Map([['a', 1]]), nested: { value: 1 } }
		const entrypoint = stub.getEntrypoint(undefined, { props })
		props.nested.value = 2
		props.tags.set('a', 2)
		const received = await (await entrypoint.fetch('http://loader/')).json()
		expect(received).toEqual({ tags: {}, nested: { value: 1 } })
		const viaMap = load(`export default { fetch(request, env, ctx) { return new Response(String(ctx.props.tags.get('a'))) } }`)
		const mapHandle = viaMap.getEntrypoint(undefined, { props })
		props.tags.set('a', 3)
		expect(await text(mapHandle.fetch('http://loader/'))).toBe('2')
	})

	test('a service binding in props is callable from the dynamic worker', async () => {
		class Host extends WorkerEntrypoint {
			ping(): string {
				return 'pong'
			}
		}
		const binding = createServiceBinding('host', 'Host')
		const wire = binding._wire
		if (typeof wire !== 'function') throw new Error('service binding has no _wire')
		wire({ Host }, {})
		const stub = load(`export default { async fetch(request, env, ctx) { return new Response(await ctx.props.HOST.ping()) } }`)
		expect(await text(stub.getEntrypoint(undefined, { props: { HOST: binding } }).fetch('http://loader/'))).toBe('pong')
	})

	test('invalid props and limits throw when the handle is created', () => {
		const stub = load(`export default { fetch() { return new Response('ok') } }`)
		let error: unknown
		try {
			stub.getEntrypoint(undefined, { props: { nested: { fn: () => 1 } } })
		} catch (e) {
			error = e
		}
		if (!(error instanceof DOMException)) throw new Error('expected a DOMException')
		expect(error.name).toBe('DataCloneError')
		expect(error.message).toContain('props.nested.fn')
		expect(() => stub.getEntrypoint(undefined, { limits: { cpuMs: -1 } })).toThrow(TypeError)
	})

	test('missing entrypoints fail with the workerd messages', async () => {
		const stub = load(
			`import { DurableObject } from 'cloudflare:workers'
			export const value = 1
			export function helper() {}
			export class Plain { hello() { return 'plain' } }
			export class Counter extends DurableObject { hello() { return 'do' } }`,
		)
		await expect(stub.getEntrypoint().fetch('http://loader/')).rejects.toThrow('Worker has no default entrypoint.')
		for (const name of ['Nope', 'toString', 'value', 'helper', 'Plain', 'Counter']) {
			const entrypoint = stub.getEntrypoint(name)
			await expect((entrypoint.hello as () => Promise<string>)()).rejects.toThrow(`Worker has no such entrypoint: ${name}`)
		}
	})

	test('an entrypoint whose constructor throws fails the call', async () => {
		const stub = load(
			`import { WorkerEntrypoint } from 'cloudflare:workers'
			export class Boom extends WorkerEntrypoint { constructor(ctx, env) { super(ctx, env); throw new Error('constructor failed') } greet() { return 'hi' } }
			export default { fetch() { return new Response('ok') } }`,
		)
		const boom = stub.getEntrypoint('Boom')
		await expect((boom.greet as () => Promise<string>)()).rejects.toThrow('constructor failed')
	})

	test('a handler that is not exported fails with the workerd message', async () => {
		const stub = load(`export default { scheduled() {} }`)
		await expect(stub.getEntrypoint().fetch('http://loader/')).rejects.toThrow('Handler does not export a fetch() function.')
	})
})

describe('dynamic worker background work', () => {
	test('waitUntil from ctx and from cloudflare:workers belong to the invocation, and a rejection does not take the worker down', async () => {
		const stub = load(
			`import { waitUntil } from 'cloudflare:workers'
			export default {
				fetch(request, env, ctx) {
					if (new URL(request.url).pathname === '/second') return new Response('second')
					ctx.waitUntil(Promise.reject(new Error('context rejection')))
					waitUntil(Promise.reject(new Error('module rejection')))
					return new Response('first')
				},
			}`,
		)
		expect(await text(stub.getEntrypoint().fetch('http://loader/'))).toBe('first')
		await Bun.sleep(50)
		const second = Promise.race([text(stub.getEntrypoint().fetch('http://loader/second')), Bun.sleep(2000).then(() => 'still pending')])
		expect(await second).toBe('second')
	})
})

describe('dynamic worker ctx.exports', () => {
	const MAIN = `import { WorkerEntrypoint, exports } from 'cloudflare:workers'
		export class Greeter extends WorkerEntrypoint {
			greet(name) { return (this.ctx.props.prefix ?? 'hi') + ' ' + name }
		}
		export default {
			async fetch(request, env, ctx) {
				if (ctx.exports === undefined) return Response.json({ ctxExports: false, moduleExports: typeof exports.Greeter })
				return Response.json({ ctxExports: true, greeting: await ctx.exports.Greeter({ props: { prefix: 'hello' } }).greet('x') })
			},
		}`

	test("ctx.exports holds loopbacks to the dynamic worker's own entrypoints", async () => {
		const stub = load(MAIN, { compatibilityDate: '2025-11-17' })
		expect(await (await stub.getEntrypoint().fetch('http://loader/')).json()).toEqual({ ctxExports: true, greeting: 'hello x' })
	})

	test("entrypoints reached through a loopback run with the dynamic worker's compatibility and ctx.exports gate", async () => {
		const main = `import { WorkerEntrypoint, exports } from 'cloudflare:workers'
			function observe(ctx) {
				return { binaryType: new WebSocketPair()[0].binaryType, hasExports: ctx.exports !== undefined }
			}
			export class Probe extends WorkerEntrypoint {
				observe() { return observe(this.ctx) }
			}
			export default {
				async fetch(request, env, ctx) {
					return Response.json({ direct: observe(ctx), loopback: await exports.Probe.observe() })
				},
			}`
		const recent = load(main, { compatibilityDate: '2026-04-07' })
		const recentObservation = { binaryType: 'blob', hasExports: true }
		expect(await (await recent.getEntrypoint().fetch('http://loader/')).json()).toEqual({ direct: recentObservation, loopback: recentObservation })
		const old = load(main, { compatibilityDate: '2025-11-16' })
		const oldObservation = { binaryType: 'arraybuffer', hasExports: false }
		expect(await (await old.getEntrypoint().fetch('http://loader/')).json()).toEqual({ direct: oldObservation, loopback: oldObservation })
	})

	test("ctx.exports follows the dynamic worker's compatibility date and flags", async () => {
		const old = load(MAIN, { compatibilityDate: '2025-11-16' })
		expect(await (await old.getEntrypoint().fetch('http://loader/')).json()).toEqual({ ctxExports: false, moduleExports: 'function' })
		const flagged = load(MAIN, { compatibilityDate: '2025-11-16', compatibilityFlags: ['enable_ctx_exports'] })
		expect(await (await flagged.getEntrypoint().fetch('http://loader/')).json()).toEqual({ ctxExports: true, greeting: 'hello x' })
	})
})

describe('dynamic worker loading', () => {
	const CODE: WorkerCode = {
		compatibilityDate: '2026-03-01',
		mainModule: 'main.js',
		modules: { 'main.js': `export default { fetch() { return new Response('ok') } }` },
	}

	test('get() invokes the code callback when it creates the id, without waiting for a request', () => {
		let calls = 0
		loader.get('eager', () => {
			calls++
			return CODE
		})
		loader.get('eager', () => {
			calls++
			return CODE
		})
		expect(calls).toBe(1)
	})

	test('a failed load is not an unhandled rejection, stays cached and is not retried', async () => {
		const unhandled: unknown[] = []
		const onUnhandled = (reason: unknown) => unhandled.push(reason)
		process.on('unhandledRejection', onUnhandled)
		try {
			let calls = 0
			const stub = loader.get('broken', async () => {
				calls++
				throw new Error('no code for you')
			})
			await Bun.sleep(50)
			expect(unhandled).toEqual([])
			await expect(stub.getEntrypoint().fetch('http://loader/')).rejects.toThrow('no code for you')
			await expect(stub.getEntrypoint().fetch('http://loader/')).rejects.toThrow('no code for you')
			expect(calls).toBe(1)
		} finally {
			process.off('unhandledRejection', onUnhandled)
		}
	})
})

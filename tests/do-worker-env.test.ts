/**
 * Unit tests for the DO-worker env builder.
 *
 * Targets behaviors that don't need a real Worker thread to verify:
 *  - WebSocket-upgrade responses through DO env bindings must throw a clear
 *    error (Finding F).
 *  - Cross-DO env bindings only fail on actual *use* — JS introspection probes
 *    (`then`, `toString`, `inspect`, …) return undefined (Finding E).
 *  - Self-DO env access fails loud instead of silently forking instance state
 *    (Finding D).
 */

import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildWorkerEnv } from '../src/bindings/do-worker-env'
import type { WranglerConfig } from '../src/config'
import { runMigrations } from '../src/db'
import type { ParentSpanContext, RpcCallReply, RpcFetchReply, SerializedResponse } from '../src/worker-thread/protocol'
import { RpcClient } from '../src/worker-thread/rpc-shared'

interface PostedFetch {
	id: number
	target: { binding: string }
	requestUrl: string
}

interface MockRpc {
	rpc: RpcClient
	respondFetch: (response: SerializedResponse) => void
	posts: PostedFetch[]
}

function makeMockRpc(): MockRpc {
	const posts: PostedFetch[] = []
	const pendingFetchIds: number[] = []
	const rpc: RpcClient = new RpcClient(
		(msg: any) => {
			if (msg.type === 'rpc-fetch') {
				posts.push({ id: msg.id, target: msg.target, requestUrl: msg.request.url })
				pendingFetchIds.push(msg.id)
			}
		},
		(): ParentSpanContext | undefined => undefined,
	)
	const respondFetch = (response: SerializedResponse) => {
		const id = pendingFetchIds.shift()
		if (id === undefined) throw new Error('No pending fetch to respond to')
		const reply: RpcFetchReply = { type: 'rpc-fetch-result', id, response }
		rpc.handle(reply)
	}
	return { rpc, respondFetch, posts }
}

describe('buildWorkerEnv — service binding fetch', () => {
	let tempDir: string
	let dataDir: string
	let db: Database

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'do-worker-env-'))
		dataDir = join(tempDir, '.lopata')
		mkdirSync(dataDir, { recursive: true })
		db = new Database(join(dataDir, 'data.sqlite'), { create: true })
		db.run('PRAGMA journal_mode=WAL')
		runMigrations(db)
	})

	afterEach(() => {
		db.close()
	})

	test('Finding F — 101 response with webSocketId throws a clear error', async () => {
		const config = { services: [{ binding: 'SVC', service: 'aux' }] } as unknown as WranglerConfig
		const { rpc, respondFetch } = makeMockRpc()
		const { env } = buildWorkerEnv(config, dataDir, rpc, 'HostDO')
		const svc = env.SVC as { fetch: (req: Request) => Promise<Response> }

		// Kick off the call; the proxy posts an `rpc-fetch` we resolve below.
		const promise = svc.fetch(new Request('http://svc/upgrade'))
		respondFetch({
			status: 101,
			statusText: 'Switching Protocols',
			headers: [],
			body: null,
			webSocketId: 'fake-ws-id',
		})

		await expect(promise).rejects.toThrow(/WebSocket upgrade .* not yet supported .* "SVC"/)
	})

	test('Finding F — bare status 101 without webSocketId also throws', async () => {
		const config = { services: [{ binding: 'SVC', service: 'aux' }] } as unknown as WranglerConfig
		const { rpc, respondFetch } = makeMockRpc()
		const { env } = buildWorkerEnv(config, dataDir, rpc, 'HostDO')
		const svc = env.SVC as { fetch: (req: Request) => Promise<Response> }

		const promise = svc.fetch(new Request('http://svc/upgrade'))
		respondFetch({ status: 101, statusText: '', headers: [], body: null })

		await expect(promise).rejects.toThrow(/WebSocket upgrade/)
	})

	test('non-101 responses pass through unchanged', async () => {
		const config = { services: [{ binding: 'SVC', service: 'aux' }] } as unknown as WranglerConfig
		const { rpc, respondFetch } = makeMockRpc()
		const { env } = buildWorkerEnv(config, dataDir, rpc, 'HostDO')
		const svc = env.SVC as { fetch: (req: Request) => Promise<Response> }

		const promise = svc.fetch(new Request('http://svc/hello'))
		const bodyBytes = new TextEncoder().encode('hello')
		respondFetch({
			status: 200,
			statusText: 'OK',
			headers: [['content-type', 'text/plain']],
			body: bodyBytes.buffer.slice(bodyBytes.byteOffset, bodyBytes.byteOffset + bodyBytes.byteLength) as ArrayBuffer,
		})

		const response = await promise
		expect(response.status).toBe(200)
		expect(await response.text()).toBe('hello')
	})
})

describe('buildWorkerEnv — DO env bindings (Findings D + E)', () => {
	let tempDir: string
	let dataDir: string
	let db: Database

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'do-worker-env-do-'))
		dataDir = join(tempDir, '.lopata')
		mkdirSync(dataDir, { recursive: true })
		db = new Database(join(dataDir, 'data.sqlite'), { create: true })
		db.run('PRAGMA journal_mode=WAL')
		runMigrations(db)
	})

	afterEach(() => {
		db.close()
	})

	test('Finding D — host DO binding is a loud-throw stub, not a local namespace', () => {
		const config = {
			durable_objects: {
				bindings: [
					{ name: 'SELF_REF', class_name: 'HostDO' },
					{ name: 'OTHER', class_name: 'OtherDO' },
				],
			},
		} as unknown as WranglerConfig
		const { rpc } = makeMockRpc()
		const { env, doNamespaces } = buildWorkerEnv(config, dataDir, rpc, 'HostDO')

		// No local namespace gets emitted for the host DO any more.
		expect(doNamespaces).toEqual([])

		// Touching `this.env.SELF_REF.anything` throws, just like cross-DO.
		const selfRef = env.SELF_REF as any
		expect(() => selfRef.get).toThrow(/Cross-Durable-Object.*SELF_REF.*HostDO/s)

		// And `this.env.OTHER` (cross-DO to a different class) likewise throws.
		const other = env.OTHER as any
		expect(() => other.get).toThrow(/Cross-Durable-Object.*OTHER.*OtherDO/s)
	})

	test('Finding E — JS introspection probes return undefined instead of throwing', async () => {
		const config = {
			durable_objects: { bindings: [{ name: 'OTHER', class_name: 'OtherDO' }] },
		} as unknown as WranglerConfig
		const { rpc } = makeMockRpc()
		const { env } = buildWorkerEnv(config, dataDir, rpc, 'HostDO')
		const other = env.OTHER as any

		// `console.log(other)` / `await other` / `JSON.stringify(other)` /
		// `String(other)` must NOT throw — all of these hit the proxy via
		// `then`, `toJSON`, `toString`, or `Symbol.for('nodejs.util.inspect.custom')`.
		expect(other.then).toBeUndefined()
		expect(other.toJSON).toBeUndefined()
		expect(other.toString).toBeUndefined()
		expect(other.valueOf).toBeUndefined()
		expect(other[Symbol.toPrimitive]).toBeUndefined()
		expect(other[Symbol.toStringTag]).toBeUndefined()
		expect(other[Symbol.for('nodejs.util.inspect.custom')]).toBeUndefined()

		// `await other` would call `.then`, which returns undefined → not a thenable;
		// the await resolves to the proxy itself. The earlier code threw here.
		await expect(Promise.resolve(other)).resolves.toBe(other)
	})
})

describe('buildWorkerEnv — RPC call passthrough', () => {
	let tempDir: string
	let dataDir: string
	let db: Database

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'do-worker-env-rpc-'))
		dataDir = join(tempDir, '.lopata')
		mkdirSync(dataDir, { recursive: true })
		db = new Database(join(dataDir, 'data.sqlite'), { create: true })
		db.run('PRAGMA journal_mode=WAL')
		runMigrations(db)
	})

	afterEach(() => {
		db.close()
	})

	test('service-binding RPC method calls route via RpcClient', async () => {
		const config = { services: [{ binding: 'SVC', service: 'aux' }] } as unknown as WranglerConfig

		const calls: Array<{ method: string; args: unknown[] }> = []
		const pendingIds: number[] = []
		const rpc: RpcClient = new RpcClient(
			(msg: any) => {
				if (msg.type === 'rpc-call') {
					calls.push({ method: msg.method, args: msg.args })
					pendingIds.push(msg.id)
				}
			},
			() => undefined,
		)
		const { env } = buildWorkerEnv(config, dataDir, rpc, 'HostDO')
		const svc = env.SVC as Record<string, (...a: unknown[]) => Promise<unknown>>

		const promise = svc.greet!('alice')
		// Drive the reply.
		const id = pendingIds.shift()!
		const reply: RpcCallReply = { type: 'rpc-call-result', id, value: 'hello alice' }
		rpc.handle(reply)
		expect(await promise).toBe('hello alice')
		expect(calls).toEqual([{ method: 'greet', args: ['alice'] }])
	})
})

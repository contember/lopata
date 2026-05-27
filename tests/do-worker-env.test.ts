/**
 * Unit tests for the DO-worker env builder.
 *
 * Targets behaviors that don't need a real Worker thread to verify:
 *  - WebSocket-upgrade responses through DO env bindings must throw a clear
 *    error (Finding F).
 *  - DO env bindings (host and cross-DO) expose a namespace proxy whose
 *    `.get(id).<method|fetch>(...)` round-trips through env-RPC with
 *    `{ instanceId, instanceName }` so main resolves the singleton executor.
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

describe('buildWorkerEnv — DO env bindings', () => {
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

	test('host DO binding exposes a namespace proxy (idFromName / get / fetch)', () => {
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

		// Main owns every executor — the worker side never emits a local namespace.
		expect(doNamespaces).toEqual([])

		// Both bindings (host class and cross-DO class) are namespace proxies.
		const selfRef = env.SELF_REF as any
		expect(typeof selfRef.idFromName).toBe('function')
		expect(typeof selfRef.get).toBe('function')
		const other = env.OTHER as any
		expect(typeof other.idFromName).toBe('function')
		expect(typeof other.get).toBe('function')
	})

	test('stub.fetch ships { binding, instanceId, instanceName } over env-RPC', async () => {
		const config = {
			durable_objects: { bindings: [{ name: 'OTHER', class_name: 'OtherDO' }] },
		} as unknown as WranglerConfig
		const { rpc, respondFetch, posts } = makeMockRpc()
		const { env } = buildWorkerEnv(config, dataDir, rpc, 'HostDO')
		const other = env.OTHER as any

		const id = other.idFromName('alice')
		expect(id.name).toBe('alice')
		const stub = other.get(id)
		expect(stub.id).toBe(id)
		expect(stub.name).toBe('alice')

		const promise = stub.fetch(new Request('http://do/hello'))
		// The posted RPC carries the id details so main resolves the right instance.
		expect(posts.length).toBe(1)
		const post = posts[0] as any
		expect(post.target).toEqual({ binding: 'OTHER', instanceId: id.toString(), instanceName: 'alice' })

		const bodyBytes = new TextEncoder().encode('hi alice')
		respondFetch({
			status: 200,
			statusText: 'OK',
			headers: [['content-type', 'text/plain']],
			body: bodyBytes.buffer.slice(bodyBytes.byteOffset, bodyBytes.byteOffset + bodyBytes.byteLength) as ArrayBuffer,
		})
		const response = await promise
		expect(response.status).toBe(200)
		expect(await response.text()).toBe('hi alice')
	})

	test('stub method call ships { binding, instanceId, instanceName } over env-RPC', async () => {
		const config = {
			durable_objects: { bindings: [{ name: 'OTHER', class_name: 'OtherDO' }] },
		} as unknown as WranglerConfig
		const calls: Array<{ target: unknown; method: string; args: unknown[] }> = []
		const pendingIds: number[] = []
		const rpc: RpcClient = new RpcClient(
			(msg: any) => {
				if (msg.type === 'rpc-call') {
					calls.push({ target: msg.target, method: msg.method, args: msg.args })
					pendingIds.push(msg.id)
				}
			},
			() => undefined,
		)
		const { env } = buildWorkerEnv(config, dataDir, rpc, 'HostDO')
		const other = env.OTHER as any
		const id = other.idFromName('bob')
		const stub = other.get(id)

		const promise = stub.greet('hi')
		const replyId = pendingIds.shift()!
		const reply: RpcCallReply = { type: 'rpc-call-result', id: replyId, value: 'hi bob' }
		rpc.handle(reply)
		expect(await promise).toBe('hi bob')
		expect(calls).toEqual([{
			target: { binding: 'OTHER', instanceId: id.toString(), instanceName: 'bob' },
			method: 'greet',
			args: ['hi'],
		}])
	})

	test('stubs are cached by id — repeated get(id) returns the same proxy', () => {
		const config = {
			durable_objects: { bindings: [{ name: 'OTHER', class_name: 'OtherDO' }] },
		} as unknown as WranglerConfig
		const { rpc } = makeMockRpc()
		const { env } = buildWorkerEnv(config, dataDir, rpc, 'HostDO')
		const other = env.OTHER as any
		const a = other.get(other.idFromName('x'))
		const b = other.get(other.idFromName('x'))
		expect(a).toBe(b)
	})

	test('container DO bindings (no `durable_objects.bindings` entry) also get a namespace proxy', () => {
		const config = {
			containers: [{ name: 'BOX', class_name: 'BoxContainer', image: 'foo' }],
		} as unknown as WranglerConfig
		const { rpc } = makeMockRpc()
		const { env } = buildWorkerEnv(config, dataDir, rpc, 'HostDO')
		const box = env.BOX as any
		expect(typeof box.idFromName).toBe('function')
		expect(typeof box.get).toBe('function')
	})

	test('idFromName is deterministic — same name → same id string', () => {
		const config = {
			durable_objects: { bindings: [{ name: 'OTHER', class_name: 'OtherDO' }] },
		} as unknown as WranglerConfig
		const { rpc } = makeMockRpc()
		const { env } = buildWorkerEnv(config, dataDir, rpc, 'HostDO')
		const other = env.OTHER as any
		const id1 = other.idFromName('shared')
		const id2 = other.idFromName('shared')
		expect(id1.toString()).toBe(id2.toString())
		expect(id1.name).toBe('shared')
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

/**
 * Unit tests for the DO-worker env builder.
 *
 * Targets behaviors that don't need a real Worker thread to verify:
 *  - 101 responses through DO env bindings reconstruct a user-facing
 *    CFWebSocket whose `send`/`close` cross the `envWsBridge`.
 *  - DO env bindings (host and cross-DO) expose a namespace proxy whose
 *    `.get(id).<method|fetch>(...)` round-trips through env-RPC with
 *    `{ instanceId, instanceName }` so main resolves the singleton executor.
 */

import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DOMainMessage } from '../src/bindings/do-executor-worker'
import { buildWorkerEnv } from '../src/bindings/do-worker-env'
import type { CFWebSocket } from '../src/bindings/websocket-pair'
import type { WranglerConfig } from '../src/config'
import { runMigrations } from '../src/db'
import type { ParentSpanContext, RpcCallReply, RpcFetchReply, SerializedResponse } from '../src/worker-thread/protocol'
import { RpcClient } from '../src/worker-thread/rpc-shared'
import { WsGuestBridge } from '../src/worker-thread/ws-bridge-shared'

function makeEnvWsBridge(post: (msg: DOMainMessage) => void = () => {}): WsGuestBridge<DOMainMessage> {
	return new WsGuestBridge<DOMainMessage>(post, {
		remoteMessage: (wsId, data) => ({ type: 'env-ws-outgoing', wsId, data }),
		remoteClose: (wsId, code, reason, wasClean) => ({ type: 'env-ws-close-out', wsId, code, reason, wasClean }),
	})
}

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

	test('101 response with webSocketId reconstructs a bridged CFWebSocket', async () => {
		const config = { services: [{ binding: 'SVC', service: 'aux' }] } as unknown as WranglerConfig
		const { rpc, respondFetch } = makeMockRpc()
		const posted: DOMainMessage[] = []
		const envWsBridge = makeEnvWsBridge(msg => posted.push(msg))
		const { env } = buildWorkerEnv(config, dataDir, dataDir, rpc, 'HostDO', envWsBridge)
		const svc = env.SVC as { fetch: (req: Request) => Promise<Response> }

		const promise = svc.fetch(new Request('http://svc/upgrade'))
		respondFetch({
			status: 101,
			statusText: 'Switching Protocols',
			headers: [],
			body: null,
			webSocketId: 'env-ws-1',
		})

		const response = (await promise) as Response & { webSocket: CFWebSocket }
		expect(response.status).toBe(101)
		expect(response.webSocket).toBeDefined()

		// Drive user code: accept(), attach listener, send a message, simulate an
		// inbound from upstream, then close. Verify both directions cross the
		// bridge correctly.
		const received: string[] = []
		response.webSocket.addEventListener('message', (ev: Event) => {
			const data = (ev as MessageEvent).data
			if (typeof data === 'string') received.push(data)
		})
		response.webSocket.accept()
		response.webSocket.send('client-hello')

		envWsBridge.deliverClientMessage('env-ws-1', 'server-hello')
		// Allow microtask flush for dispatchOrQueue.
		await new Promise<void>(r => setTimeout(r, 0))

		expect(received).toEqual(['server-hello'])
		const outgoing = posted.filter(m => m.type === 'env-ws-outgoing') as Extract<DOMainMessage, { type: 'env-ws-outgoing' }>[]
		expect(outgoing.map(m => m.data)).toEqual(['client-hello'])

		response.webSocket.close(4001, 'bye')
		const closes = posted.filter(m => m.type === 'env-ws-close-out') as Extract<DOMainMessage, { type: 'env-ws-close-out' }>[]
		expect(closes.length).toBe(1)
		expect(closes[0]!.code).toBe(4001)
		expect(closes[0]!.reason).toBe('bye')
	})

	test('non-101 responses pass through unchanged', async () => {
		const config = { services: [{ binding: 'SVC', service: 'aux' }] } as unknown as WranglerConfig
		const { rpc, respondFetch } = makeMockRpc()
		const envWsBridge = makeEnvWsBridge()
		const { env } = buildWorkerEnv(config, dataDir, dataDir, rpc, 'HostDO', envWsBridge)
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
		expect((response as Response & { webSocket?: unknown }).webSocket).toBeUndefined()
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
		const { env } = buildWorkerEnv(config, dataDir, dataDir, rpc, 'HostDO', makeEnvWsBridge())

		// Main owns every executor — the worker side emits only namespace proxies,
		// never a local namespace. Both bindings (host class and cross-DO class) are
		// namespace proxies.
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
		const { env } = buildWorkerEnv(config, dataDir, dataDir, rpc, 'HostDO', makeEnvWsBridge())
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
		const { env } = buildWorkerEnv(config, dataDir, dataDir, rpc, 'HostDO', makeEnvWsBridge())
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
		const { env } = buildWorkerEnv(config, dataDir, dataDir, rpc, 'HostDO', makeEnvWsBridge())
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
		const { env } = buildWorkerEnv(config, dataDir, dataDir, rpc, 'HostDO', makeEnvWsBridge())
		const box = env.BOX as any
		expect(typeof box.idFromName).toBe('function')
		expect(typeof box.get).toBe('function')
	})

	test('idFromName is deterministic — same name → same id string', () => {
		const config = {
			durable_objects: { bindings: [{ name: 'OTHER', class_name: 'OtherDO' }] },
		} as unknown as WranglerConfig
		const { rpc } = makeMockRpc()
		const { env } = buildWorkerEnv(config, dataDir, dataDir, rpc, 'HostDO', makeEnvWsBridge())
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
		const { env } = buildWorkerEnv(config, dataDir, dataDir, rpc, 'HostDO', makeEnvWsBridge())
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

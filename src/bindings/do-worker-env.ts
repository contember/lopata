/**
 * Lightweight env builder for DO worker threads.
 *
 * Each worker thread opens its own Database connection to the same
 * .lopata/data.sqlite (WAL mode ensures safe concurrent access).
 * It builds binding instances (KV, R2, D1, queues) that wrap the
 * shared DB/filesystem — these are stateless wrappers safe to duplicate.
 */

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { WranglerConfig } from '../config'
import { runMigrations } from '../db'
import { resolveVars } from '../env'
import { warnCrossThreadRpcArgs, warnInvalidRpcArgs } from '../rpc-validate'
import { getActiveContext } from '../tracing/context'
import type { BindingTarget, ParentSpanContext, SerializedResponse, WorkflowControlOp, WorkflowControlResult } from '../worker-thread/protocol'
import { RpcClient } from '../worker-thread/rpc-shared'
import { tagCloneable } from '../worker-thread/rpc-shared'
import type { WsGuestBridge } from '../worker-thread/ws-bridge-shared'
import type { DOWorkerRuntimeOptions } from './do-executor'
import type { DOMainMessage } from './do-executor-worker'
import { DurableObjectIdImpl, hashIdFromName, randomUniqueIdHex } from './durable-object'
import { EmailMessage } from './email'
import { SqliteQueueProducer } from './queue'
import { makeBindingProxy } from './rpc-stub'
import { addStatelessBindings } from './stateless-env'
import type { ResponseWithWebSocket } from './websocket-pair'
import type { WorkflowRestartOptions } from './workflow'

/** Build an RpcClient that bridges DO-worker → main over the DO executor channel. */
export function createDoEnvRpc(post: (msg: DOMainMessage) => void): RpcClient {
	const getParent = (): ParentSpanContext | undefined => {
		const active = getActiveContext()
		return active ? { traceId: active.traceId, spanId: active.spanId } : undefined
	}
	return new RpcClient(req => post(req as DOMainMessage), getParent)
}

function buildBridgedFetchResponse(
	r: SerializedResponse,
	rpc: RpcClient,
	envWsBridge: WsGuestBridge<DOMainMessage>,
): Response {
	const response = rpc.makeResponse(r) as ResponseWithWebSocket
	if (r.webSocketId !== undefined) {
		response.webSocket = envWsBridge.createBridgedSocket(r.webSocketId)
	}
	return response
}

function makeRpcProxy(
	target: BindingTarget,
	rpc: RpcClient,
	envWsBridge: WsGuestBridge<DOMainMessage>,
	extras: Record<string | symbol, unknown> = {},
): Record<string, unknown> {
	return makeBindingProxy(
		{
			fetch: async (input, init) => {
				const req = input instanceof Request ? input : new Request(input instanceof URL ? input.href : input, init)
				const r = await rpc.callFetch(target, req)
				return buildBridgedFetchResponse(r, rpc, envWsBridge)
			},
			call: (prop, args) => {
				warnInvalidRpcArgs(args, prop)
				warnCrossThreadRpcArgs(args, prop)
				return rpc.call(target, prop, args)
			},
			getProperty: prop => rpc.callGet(target, prop),
		},
		extras,
	)
}

function makeEnvBindingProxy(binding: string, rpc: RpcClient, envWsBridge: WsGuestBridge<DOMainMessage>): Record<string, unknown> {
	return makeRpcProxy({ binding }, rpc, envWsBridge)
}

function makeDoEnvStubProxy(
	bindingName: string,
	idStr: string,
	id: DurableObjectIdImpl,
	rpc: RpcClient,
	envWsBridge: WsGuestBridge<DOMainMessage>,
): Record<string, unknown> {
	return makeRpcProxy({ binding: bindingName, instanceId: idStr, instanceName: id.name }, rpc, envWsBridge, { id, name: id.name })
}

/**
 * DO namespace proxy for use inside a DO worker thread. ID factories run
 * locally (deterministic); `.get()` produces a stub that ships
 * `{ binding, instanceId, instanceName }` to main, where the namespace's
 * `.get()` resolves the singleton executor for that id. Mirrors the
 * user-worker `makeDONamespaceProxy` shape.
 */
function makeDoEnvNamespaceProxy(bindingName: string, rpc: RpcClient, envWsBridge: WsGuestBridge<DOMainMessage>): Record<string, unknown> {
	const stubs = new Map<string, unknown>()
	const idFromName = (name: string) => new DurableObjectIdImpl(hashIdFromName(name), name)
	const idFromString = (idStr: string) => new DurableObjectIdImpl(idStr)
	const newUniqueId = (_opts?: { jurisdiction?: string }) => new DurableObjectIdImpl(randomUniqueIdHex())
	const get = (id: DurableObjectIdImpl) => {
		const idStr = id.toString()
		// Key includes the name so a nameless `idFromString(hash)` and a named
		// `idFromName(...)` resolving to the same hash get distinct stubs, each
		// preserving its caller's `id.name`. Matches thread-env's makeDONamespaceProxy.
		const key = `${idStr}:${id.name ?? ''}`
		let stub = stubs.get(key)
		if (!stub) {
			stub = makeDoEnvStubProxy(bindingName, idStr, id, rpc, envWsBridge)
			stubs.set(key, stub)
		}
		return stub
	}
	return {
		idFromName,
		idFromString,
		newUniqueId,
		get,
		getByName: (name: string) => get(idFromName(name)),
	}
}

/**
 * Build a minimal env for use inside a DO worker thread.
 *
 * Stateless bindings (KV/R2/D1/queue producer/nested DO) are instantiated
 * locally against the shared SQLite/filesystem. Stateful ones (service
 * bindings, email, workflow, …) become RPC proxies that route through main
 * via the DO-executor message channel.
 *
 * `envWsBridge` is shared with `do-worker-entry.ts`'s message router: when an
 * env-binding fetch returns a 101 response with a `webSocketId`, the proxy
 * here calls `envWsBridge.createBridgedSocket(id)` to reconstruct a
 * user-facing CFWebSocket whose events flow over the bridge to main.
 */
export function buildWorkerEnv(
	config: WranglerConfig,
	dataDir: string,
	baseDir: string,
	rpc: RpcClient,
	_hostNamespaceName: string,
	envWsBridge: WsGuestBridge<DOMainMessage>,
	runtime: DOWorkerRuntimeOptions = {},
): { db: Database; env: Record<string, unknown> } {
	// Open own DB connection (WAL mode for safe concurrency)
	const dbPath = join(dataDir, 'data.sqlite')
	mkdirSync(dataDir, { recursive: true })
	const db = new Database(dbPath, { create: true })
	db.run('PRAGMA journal_mode=WAL')
	// Match db.ts / thread-env.ts: WAL allows only one writer at a time across
	// connections, so without busy_timeout a concurrent write from the main or
	// user-worker connection fails this DO-worker write instantly with
	// SQLITE_BUSY instead of waiting.
	db.run('PRAGMA busy_timeout=5000')
	runMigrations(db)
	// Expose this thread's DB handle so the fetch patch (plugin.ts) can serve the
	// intercepted Analytics Engine SQL API from this DO worker's data dir.
	const threadGlobals = globalThis as { __lopata_db?: Database }
	threadGlobals.__lopata_db = db

	// On real CF a DO's env equals the worker's env: same vars, `.dev.vars` secrets
	// and process.env overrides, resolved by the same function main uses.
	const env: Record<string, unknown> = resolveVars(config, baseDir)

	// Durable Objects — every DO binding (including the host class) routes via
	// main's namespace over env-RPC. The stub ships `{ instanceId, instanceName }`
	// in `BindingTarget`; main's `_resolveBinding` reconstructs the
	// `DurableObjectId` and resolves the singleton executor, so both self-DO
	// and cross-DO access reach the same instance state main owns.
	const doBindingNames = new Set<string>()
	for (const doBinding of config.durable_objects?.bindings ?? []) {
		env[doBinding.name] = makeDoEnvNamespaceProxy(doBinding.name, rpc, envWsBridge)
		doBindingNames.add(doBinding.name)
	}
	// Container DOs whose binding isn't already declared under `durable_objects`
	// (main synthesises a DO namespace for them); the worker env needs the
	// matching proxy or the binding is missing at runtime.
	for (const container of config.containers ?? []) {
		const bindingName = container.name ?? container.class_name
		if (doBindingNames.has(bindingName)) continue
		env[bindingName] = makeDoEnvNamespaceProxy(bindingName, rpc, envWsBridge)
	}

	// Queue producers
	for (const producer of config.queues?.producers ?? []) {
		env[producer.binding] = new SqliteQueueProducer(db, producer.queue, producer.delivery_delay ?? 0)
	}

	for (const svc of config.services ?? []) {
		env[svc.binding] = makeEnvBindingProxy(svc.binding, rpc, envWsBridge)
	}
	for (const email of config.send_email ?? []) {
		// A plain RPC proxy would DataCloneError on an EmailMessage whose `raw` is a
		// ReadableStream; materialize it and tag the class so main can rebuild it.
		env[email.name] = makeSendEmailProxy(email.name, rpc, envWsBridge)
	}
	for (const wf of config.workflows ?? []) {
		env[wf.binding] = makeWorkflowEnvProxy(wf.binding, rpc, envWsBridge)
	}

	addStatelessBindings(env, { config, db, dataDir, baseDir, browserConfig: runtime.browserConfig, artifactsBaseUrl: runtime.artifactsBaseUrl })

	return { db, env }
}

async function materializeEmailRaw(raw: unknown): Promise<Uint8Array | ArrayBuffer | string> {
	if (typeof raw === 'string' || raw instanceof Uint8Array || raw instanceof ArrayBuffer) return raw
	if (raw && typeof (raw as ReadableStream).getReader === 'function') {
		return new Response(raw as ReadableStream).arrayBuffer()
	}
	throw new Error('EmailMessage.raw must be a string, Uint8Array, ArrayBuffer, or ReadableStream')
}

/**
 * Workflow binding proxy for DO worker threads. A generic RPC proxy would land
 * on main's HOLLOW `SqliteWorkflowBinding` (in thread mode main never wires the
 * class — `create()` throws and instance handles silently no-op against empty
 * per-process registries), and the `SqliteWorkflowInstance` a real call returns
 * couldn't cross the boundary anyway. Instead, model the public Workflow API as
 * `executeControl` ops: main's binding forwards them through its thread router
 * to the user worker that owns the live state machine.
 */
function makeWorkflowEnvProxy(bindingName: string, rpc: RpcClient, envWsBridge: WsGuestBridge<DOMainMessage>): Record<string, unknown> {
	const target: BindingTarget = { binding: bindingName }
	const control = async (op: WorkflowControlOp): Promise<WorkflowControlResult> => {
		const result: unknown = await rpc.call(target, 'executeControl', [op])
		if (typeof result === 'object' && result !== null && 'kind' in result && typeof result.kind === 'string') {
			return result as WorkflowControlResult
		}
		throw new Error('Malformed workflow control result')
	}
	const expectCreate = (result: WorkflowControlResult) => {
		if (result.kind !== 'create') throw new Error(`Unexpected workflow control result "${result.kind}" (expected "create")`)
		if (typeof result.id !== 'string' || typeof result.incarnation !== 'string') throw new Error('Malformed workflow handle')
		return result
	}
	const expectStatus = (result: WorkflowControlResult) => {
		if (result.kind !== 'status') throw new Error(`Unexpected workflow control result "${result.kind}" (expected "status")`)
		return result
	}
	const makeHandle = (id: string, incarnation: string) => ({
		id,
		delete: async () => {
			await control({ kind: 'delete', instanceId: id, incarnation })
		},
		status: async () => expectStatus(await control({ kind: 'status', instanceId: id, incarnation })).value,
		pause: async () => {
			await control({ kind: 'pause', instanceId: id, incarnation })
		},
		resume: async () => {
			await control({ kind: 'resume', instanceId: id, incarnation })
		},
		terminate: async (options?: { rollback?: boolean }) => {
			await control({ kind: 'terminate', instanceId: id, rollback: options?.rollback, incarnation })
		},
		restart: async (options?: WorkflowRestartOptions) => {
			await control({ kind: 'restart', instanceId: id, from: options?.from, fromStep: options?.fromStep, incarnation })
		},
		skipSleep: async () => {
			await control({ kind: 'skipSleep', instanceId: id, incarnation })
		},
		sendEvent: async (event: { type: string; payload?: unknown }) => {
			await control({ kind: 'sendEvent', instanceId: id, eventType: event.type, payload: event.payload, incarnation })
		},
	})
	return makeRpcProxy(target, rpc, envWsBridge, {
		create: async (options?: { id?: string; params?: unknown }) => {
			const r = expectCreate(await control({ kind: 'create', params: options?.params ?? {}, id: options?.id }))
			return makeHandle(r.id, r.incarnation)
		},
		createBatch: async (batch: { id?: string; params?: unknown }[]) => {
			const handles = []
			for (const item of batch) {
				const r = expectCreate(await control({ kind: 'create', params: item.params ?? {}, id: item.id }))
				handles.push(makeHandle(r.id, r.incarnation))
			}
			return handles
		},
		deleteBatch: async (instanceIds: string[]) => {
			const result = await control({ kind: 'deleteBatch', instanceIds })
			if (
				result.kind !== 'deleteBatch' || !result.value || !Array.isArray(result.value.deleted) || !Array.isArray(result.value.errors)
				|| !result.value.deleted.every((entry: unknown) => entry !== null && typeof entry === 'object' && 'id' in entry && typeof entry.id === 'string')
				|| !result.value.errors.every((entry: unknown) =>
					entry !== null && typeof entry === 'object' && 'id' in entry && typeof entry.id === 'string'
					&& 'code' in entry && typeof entry.code === 'number' && 'message' in entry && typeof entry.message === 'string'
				)
			) {
				throw new Error('Malformed workflow batch deletion result')
			}
			return result.value
		},
		get: async (id: string) => {
			const result = await control({ kind: 'getHandle', instanceId: id })
			if (result.kind !== 'getHandle' || typeof result.id !== 'string' || typeof result.incarnation !== 'string') {
				throw new Error('Malformed workflow handle')
			}
			return makeHandle(result.id, result.incarnation)
		},
	})
}

function makeSendEmailProxy(bindingName: string, rpc: RpcClient, envWsBridge: WsGuestBridge<DOMainMessage>): Record<string, unknown> {
	const target: BindingTarget = { binding: bindingName }
	const taggedSend = async (message: unknown) => {
		const arg = message instanceof EmailMessage
			? tagCloneable('EmailMessage', {
				from: message.from,
				to: message.to,
				raw: await materializeEmailRaw(message.raw),
			})
			: message
		return rpc.call(target, 'send', [arg])
	}
	return makeRpcProxy(target, rpc, envWsBridge, { send: taggedSend })
}

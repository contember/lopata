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
import { getActiveContext } from '../tracing/context'
import type { BindingTarget, ParentSpanContext, SerializedResponse } from '../worker-thread/protocol'
import { RpcClient } from '../worker-thread/rpc-shared'
import type { WsGuestBridge } from '../worker-thread/ws-bridge-shared'
import { openD1Database } from './d1'
import type { DOMainMessage } from './do-executor-worker'
import { DurableObjectIdImpl, DurableObjectNamespaceImpl, hashIdFromName, randomUniqueIdHex } from './durable-object'
import { SqliteKVNamespace } from './kv'
import { SqliteQueueProducer } from './queue'
import { FileR2Bucket } from './r2'
import { makeBindingProxy } from './rpc-stub'
import type { ResponseWithWebSocket } from './websocket-pair'

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
			call: (prop, args) => rpc.call(target, prop, args),
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
		const key = id.toString()
		let stub = stubs.get(key)
		if (!stub) {
			stub = makeDoEnvStubProxy(bindingName, key, id, rpc, envWsBridge)
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
	rpc: RpcClient,
	_hostNamespaceName: string,
	envWsBridge: WsGuestBridge<DOMainMessage>,
): { db: Database; env: Record<string, unknown>; doNamespaces: { className: string; namespace: DurableObjectNamespaceImpl }[] } {
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

	const env: Record<string, unknown> = {}
	const doNamespaces: { className: string; namespace: DurableObjectNamespaceImpl }[] = []

	// Environment variables
	if (config.vars) {
		for (const [key, value] of Object.entries(config.vars)) {
			env[key] = value
		}
	}

	// KV namespaces
	for (const kv of config.kv_namespaces ?? []) {
		env[kv.binding] = new SqliteKVNamespace(db, kv.id)
	}

	// R2 buckets
	for (const r2 of config.r2_buckets ?? []) {
		env[r2.binding] = new FileR2Bucket(db, r2.bucket_name, dataDir)
	}

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

	// D1 databases
	for (const d1 of config.d1_databases ?? []) {
		env[d1.binding] = openD1Database(dataDir, d1.database_name)
	}

	// Queue producers
	for (const producer of config.queues?.producers ?? []) {
		env[producer.binding] = new SqliteQueueProducer(db, producer.queue, producer.delivery_delay ?? 0)
	}

	for (const svc of config.services ?? []) {
		env[svc.binding] = makeEnvBindingProxy(svc.binding, rpc, envWsBridge)
	}
	for (const email of config.send_email ?? []) {
		env[email.name] = makeEnvBindingProxy(email.name, rpc, envWsBridge)
	}
	for (const wf of config.workflows ?? []) {
		env[wf.binding] = makeEnvBindingProxy(wf.binding, rpc, envWsBridge)
	}

	return { db, env, doNamespaces }
}

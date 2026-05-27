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
import type { BindingTarget, ParentSpanContext } from '../worker-thread/protocol'
import { RpcClient } from '../worker-thread/rpc-shared'
import { openD1Database } from './d1'
import type { DOMainMessage } from './do-executor-worker'
import { DurableObjectIdImpl, DurableObjectNamespaceImpl, hashIdFromName, randomUniqueIdHex } from './durable-object'
import { SqliteKVNamespace } from './kv'
import { SqliteQueueProducer } from './queue'
import { FileR2Bucket } from './r2'
import { makeBindingProxy } from './rpc-stub'

/** Build an RpcClient that bridges DO-worker → main over the DO executor channel. */
export function createDoEnvRpc(post: (msg: DOMainMessage) => void): RpcClient {
	const getParent = (): ParentSpanContext | undefined => {
		const active = getActiveContext()
		return active ? { traceId: active.traceId, spanId: active.spanId } : undefined
	}
	return new RpcClient(req => post(req as DOMainMessage), getParent)
}

function makeRpcProxy(target: BindingTarget, rpc: RpcClient, extras: Record<string | symbol, unknown> = {}): Record<string, unknown> {
	return makeBindingProxy(
		{
			fetch: async (input, init) => {
				const req = input instanceof Request ? input : new Request(input instanceof URL ? input.href : input, init)
				const r = await rpc.callFetch(target, req)
				// WebSocket upgrade responses don't round-trip through this channel
				// yet — main's DO-channel `_dispatchRpcFetch` has no `decorateResponse`
				// hook to adopt the host peer, and `rpc.makeResponse` doesn't reattach
				// a guest peer on the worker side. Returning the body-less Response
				// would lead to silently-broken `response.webSocket === undefined`;
				// throw with a clear message instead.
				if (r.status === 101 || r.webSocketId !== undefined) {
					throw new Error(
						`WebSocket upgrade responses are not yet supported through DO env binding "${target.binding}". `
							+ `(The binding's fetch returned status 101 with a \`webSocket\`. Open the WS from the DO's own fetch handler, `
							+ `or from a non-DO worker.)`,
					)
				}
				return rpc.makeResponse(r)
			},
			call: (prop, args) => rpc.call(target, prop, args),
		},
		extras,
	)
}

function makeEnvBindingProxy(binding: string, rpc: RpcClient): Record<string, unknown> {
	return makeRpcProxy({ binding }, rpc)
}

function makeDoEnvStubProxy(bindingName: string, idStr: string, id: DurableObjectIdImpl, rpc: RpcClient): Record<string, unknown> {
	return makeRpcProxy({ binding: bindingName, instanceId: idStr, instanceName: id.name }, rpc, { id, name: id.name })
}

/**
 * DO namespace proxy for use inside a DO worker thread. ID factories run
 * locally (deterministic); `.get()` produces a stub that ships
 * `{ binding, instanceId, instanceName }` to main, where the namespace's
 * `.get()` resolves the singleton executor for that id. Mirrors the
 * user-worker `makeDONamespaceProxy` shape.
 */
function makeDoEnvNamespaceProxy(bindingName: string, rpc: RpcClient): Record<string, unknown> {
	const stubs = new Map<string, unknown>()
	const idFromName = (name: string) => new DurableObjectIdImpl(hashIdFromName(name), name)
	const idFromString = (idStr: string) => new DurableObjectIdImpl(idStr)
	const newUniqueId = (_opts?: { jurisdiction?: string }) => new DurableObjectIdImpl(randomUniqueIdHex())
	const get = (id: DurableObjectIdImpl) => {
		const key = id.toString()
		let stub = stubs.get(key)
		if (!stub) {
			stub = makeDoEnvStubProxy(bindingName, key, id, rpc)
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
 */
export function buildWorkerEnv(
	config: WranglerConfig,
	dataDir: string,
	rpc: RpcClient,
	_hostNamespaceName: string,
): { db: Database; env: Record<string, unknown>; doNamespaces: { className: string; namespace: DurableObjectNamespaceImpl }[] } {
	// Open own DB connection (WAL mode for safe concurrency)
	const dbPath = join(dataDir, 'data.sqlite')
	mkdirSync(dataDir, { recursive: true })
	const db = new Database(dbPath, { create: true })
	db.run('PRAGMA journal_mode=WAL')
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
		env[doBinding.name] = makeDoEnvNamespaceProxy(doBinding.name, rpc)
		doBindingNames.add(doBinding.name)
	}
	// Container DOs whose binding isn't already declared under `durable_objects`
	// (main synthesises a DO namespace for them); the worker env needs the
	// matching proxy or the binding is missing at runtime.
	for (const container of config.containers ?? []) {
		const bindingName = container.name ?? container.class_name
		if (doBindingNames.has(bindingName)) continue
		env[bindingName] = makeDoEnvNamespaceProxy(bindingName, rpc)
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
		env[svc.binding] = makeEnvBindingProxy(svc.binding, rpc)
	}
	for (const email of config.send_email ?? []) {
		env[email.name] = makeEnvBindingProxy(email.name, rpc)
	}
	for (const wf of config.workflows ?? []) {
		env[wf.binding] = makeEnvBindingProxy(wf.binding, rpc)
	}

	return { db, env, doNamespaces }
}

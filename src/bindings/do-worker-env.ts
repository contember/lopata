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
import type { BindingTarget, ParentSpanContext, RpcCallRequest, RpcFetchRequest } from '../worker-thread/protocol'
import { RpcClient } from '../worker-thread/rpc-shared'
import { deserializeResponse } from '../worker-thread/serialize'
import type { DOMainMessage } from './do-executor-worker'
import { openD1Database } from './d1'
import { DurableObjectNamespaceImpl } from './durable-object'
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
	return new RpcClient(req => post(req as RpcCallRequest | RpcFetchRequest), getParent)
}

function makeEnvBindingProxy(binding: string, rpc: RpcClient): Record<string, unknown> {
	const target: BindingTarget = { binding }
	return makeBindingProxy({
		fetch: async (input, init) => {
			const req = input instanceof Request ? input : new Request(input instanceof URL ? input.href : input, init)
			const r = await rpc.callFetch(target, req)
			return deserializeResponse(r)
		},
		call: (prop, args) => rpc.call(target, prop, args),
	})
}

/**
 * Stub for cross-Durable-Object access from within a DO worker thread.
 *
 * Cross-DO RPC requires routing into a different worker's singleton namespace
 * (alarms, in-memory cache, hibernation WSs all live there). That plumbing is
 * not implemented; constructing a private namespace inside this worker would
 * silently duplicate state. Throw loud and eager instead — the moment user
 * code touches `this.env.OTHER_DO.anything`, fail with a clear message naming
 * the binding and class.
 */
function makeCrossDoStub(bindingName: string, className: string): Record<string, unknown> {
	const fail = (): never => {
		throw new Error(
			`Cross-Durable-Object calls in thread isolation are not supported. The binding "${bindingName}" resolves to DO class "${className}", which lives in a different Worker thread. (To use it, refactor to call via a Service Binding, or run lopata in in-process mode.)`,
		)
	}
	return new Proxy({} as Record<string, unknown>, {
		get(_obj, _prop) {
			return fail()
		},
	})
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
	hostNamespaceName: string,
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

	// Durable Objects — only the binding that points at *this* worker's own DO
	// class gets a real local namespace. Every other DO binding points at a
	// singleton in a different worker thread; constructing a private namespace
	// here would silently duplicate state. Substitute a loud-throw stub.
	for (const doBinding of config.durable_objects?.bindings ?? []) {
		if (doBinding.class_name === hostNamespaceName) {
			const namespace = new DurableObjectNamespaceImpl(db, doBinding.class_name, dataDir)
			env[doBinding.name] = namespace
			doNamespaces.push({ className: doBinding.class_name, namespace })
		} else {
			env[doBinding.name] = makeCrossDoStub(doBinding.name, doBinding.class_name)
		}
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

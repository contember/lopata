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
import { DurableObjectNamespaceImpl } from './durable-object'
import { SqliteKVNamespace } from './kv'
import { SqliteQueueProducer } from './queue'
import { FileR2Bucket } from './r2'
import { makeBindingProxy, NON_RPC_PROPS } from './rpc-stub'

/**
 * JS internals that probe a value without using it as an RPC target:
 * `console.log`, `String(x)`, `JSON.stringify(x)`, `await x`, `nodejs.util.inspect`.
 * Returning `undefined` for these lets debugging/introspection probes through;
 * only a direct method/property *use* via a non-internal name triggers the throw.
 */
const PROBE_PROPS = new Set<string | symbol>([
	...NON_RPC_PROPS,
	'then', // also in NON_RPC_PROPS; listed for clarity
	Symbol.for('nodejs.util.inspect.custom'),
])

/** Build an RpcClient that bridges DO-worker → main over the DO executor channel. */
export function createDoEnvRpc(post: (msg: DOMainMessage) => void): RpcClient {
	const getParent = (): ParentSpanContext | undefined => {
		const active = getActiveContext()
		return active ? { traceId: active.traceId, spanId: active.spanId } : undefined
	}
	return new RpcClient(req => post(req as DOMainMessage), getParent)
}

function makeEnvBindingProxy(binding: string, rpc: RpcClient): Record<string, unknown> {
	const target: BindingTarget = { binding }
	return makeBindingProxy({
		fetch: async (input, init) => {
			const req = input instanceof Request ? input : new Request(input instanceof URL ? input.href : input, init)
			const r = await rpc.callFetch(target, req)
			return rpc.makeResponse(r)
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
		get(_obj, prop) {
			// Promise-protocol / debugging / inspection probes must not throw —
			// `console.log(this.env.OTHER_DO)`, `await this.env.OTHER_DO`,
			// `JSON.stringify(...)`, and `String(...)` all hit the proxy through
			// one of these props without intending to *use* the binding.
			if (PROBE_PROPS.has(prop)) return undefined
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

	// Durable Objects — every DO binding routes via main, including the binding
	// that points at *this* worker's own DO class. Constructing a local
	// namespace here (even for the host class) silently forks instance state:
	// `this.env.SELF_DO.get(idFromName('A'))` would build a fresh in-process
	// `DurableObjectStateImpl` parallel to main's executor for the same id,
	// giving two singletons for one logical instance. The full fix requires
	// extending env-RPC to carry `instanceId` + `instanceName` and routing
	// through main's namespace; until that lands, throw loud and eager.
	for (const doBinding of config.durable_objects?.bindings ?? []) {
		env[doBinding.name] = makeCrossDoStub(doBinding.name, doBinding.class_name)
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

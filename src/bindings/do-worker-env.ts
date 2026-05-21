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
import { openD1Database } from './d1'
import type { DOMainMessage, DOWorkerMessage, SerializedEnvResponse } from './do-executor-worker'
import { DurableObjectNamespaceImpl } from './durable-object'
import { SqliteKVNamespace } from './kv'
import { SqliteQueueProducer } from './queue'
import { FileR2Bucket } from './r2'
import { makeBindingProxy } from './rpc-stub'

/**
 * Minimal RPC helper for DO-worker → main bridges. Each call posts a
 * message with a fresh id and resolves when main echoes back the result.
 */
export interface DoEnvRpc {
	call(binding: string, method: string, args: unknown[]): Promise<unknown>
	callFetch(binding: string, request: Request): Promise<SerializedEnvResponse>
	/** Handle an inbound `env-*` reply from main; returns true if consumed. */
	handle(msg: DOWorkerMessage): boolean
}

export function createDoEnvRpc(post: (msg: DOMainMessage) => void): DoEnvRpc {
	const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
	let nextId = 1

	return {
		call(binding, method, args) {
			const id = nextId++
			return new Promise<unknown>((resolve, reject) => {
				pending.set(id, { resolve, reject })
				post({ type: 'env-call', id, binding, method, args })
			})
		},
		async callFetch(binding, request) {
			const id = nextId++
			const headers: [string, string][] = []
			request.headers.forEach((v, k) => headers.push([k, v]))
			const body = request.body ? await request.arrayBuffer() : null
			return new Promise<SerializedEnvResponse>((resolve, reject) => {
				pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
				post({ type: 'env-fetch', id, binding, request: { url: request.url, method: request.method, headers, body } })
			})
		},
		handle(msg) {
			switch (msg.type) {
				case 'env-call-result':
				case 'env-fetch-result': {
					const p = pending.get(msg.id)
					if (!p) return true
					pending.delete(msg.id)
					p.resolve(msg.type === 'env-call-result' ? msg.value : msg.response)
					return true
				}
				case 'env-call-error':
				case 'env-fetch-error': {
					const p = pending.get(msg.id)
					if (!p) return true
					pending.delete(msg.id)
					const err = new Error(msg.message)
					if (msg.stack) err.stack = msg.stack
					if (msg.name) err.name = msg.name
					p.reject(err)
					return true
				}
				default:
					return false
			}
		},
	}
}

function makeEnvBindingProxy(binding: string, rpc: DoEnvRpc): Record<string, unknown> {
	return makeBindingProxy({
		fetch: async (input, init) => {
			const req = input instanceof Request ? input : new Request(input instanceof URL ? input.href : input, init)
			const r = await rpc.callFetch(binding, req)
			return new Response(r.body, { status: r.status, statusText: r.statusText, headers: r.headers })
		},
		call: (prop, args) => rpc.call(binding, prop, args),
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
	rpc: DoEnvRpc,
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

	// Durable Objects — each runs in-process within this worker thread
	for (const doBinding of config.durable_objects?.bindings ?? []) {
		const namespace = new DurableObjectNamespaceImpl(db, doBinding.class_name, dataDir)
		env[doBinding.name] = namespace
		doNamespaces.push({ className: doBinding.class_name, namespace })
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

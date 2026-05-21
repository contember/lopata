/**
 * Stateless-binding env builder for the main worker-thread runtime.
 *
 * Builds the bindings whose state lives on disk (.lopata SQLite/files) —
 * the same physical files the main thread uses. WAL mode + busy_timeout
 * make multiple `bun:sqlite` handles to the same file safe.
 */

import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { AiBinding } from '../bindings/ai'
import { SqliteAnalyticsEngine } from '../bindings/analytics-engine'
import { openD1Database } from '../bindings/d1'
import { DurableObjectIdImpl, hashIdFromName, randomUniqueIdHex } from '../bindings/durable-object'
import { EmailMessage } from '../bindings/email'
import { HyperdriveBinding } from '../bindings/hyperdrive'
import { ImagesBinding } from '../bindings/images'
import { SqliteKVNamespace } from '../bindings/kv'
import { MediaBinding } from '../bindings/media'
import { FileR2Bucket } from '../bindings/r2'
import { NON_RPC_PROPS } from '../bindings/rpc-stub'
import { serviceBindingConnectError } from '../bindings/service-binding'
import { StaticAssets } from '../bindings/static-assets'
import { SqliteWorkflowBinding } from '../bindings/workflow'
import type { WranglerConfig } from '../config'
import { runMigrations } from '../db'
import { parseDevVars } from '../env'
import type { BindingTarget } from './protocol'
import type { RpcClient } from './rpc-client'
import { deserializeResponse } from './serialize'

export interface ThreadEnvOptions {
	config: WranglerConfig
	baseDir: string
	rpc: RpcClient
}

export interface ThreadEnvBuilt {
	env: Record<string, unknown>
	/** Thread-local DB handle — shared with the workflow + queue consumer wiring
	 *  the caller does after the user module loads. */
	db: Database
	/** Workflows the caller still needs to wire after the user module loads. */
	workflows: { bindingName: string; className: string; binding: SqliteWorkflowBinding }[]
}

export function buildThreadEnv({ config, baseDir, rpc }: ThreadEnvOptions): ThreadEnvBuilt {
	const dataDir = path.join(baseDir, '.lopata')
	mkdirSync(dataDir, { recursive: true })
	mkdirSync(path.join(dataDir, 'r2'), { recursive: true })
	mkdirSync(path.join(dataDir, 'd1'), { recursive: true })

	const db = new Database(path.join(dataDir, 'data.sqlite'), { create: true })
	db.run('PRAGMA journal_mode=WAL')
	db.run('PRAGMA busy_timeout=5000')
	runMigrations(db)

	const env: Record<string, unknown> = {}

	if (config.vars) {
		for (const [key, value] of Object.entries(config.vars)) {
			env[key] = value
		}
	}

	const devVarsPath = path.join(baseDir, '.dev.vars')
	const envPath = path.join(baseDir, '.env')
	const filePath = existsSync(devVarsPath) ? devVarsPath : existsSync(envPath) ? envPath : null
	if (filePath) {
		const devVars = parseDevVars(readFileSync(filePath, 'utf-8'))
		for (const [key, value] of Object.entries(devVars)) {
			env[key] = value
		}
	}

	for (const kv of config.kv_namespaces ?? []) {
		env[kv.binding] = new SqliteKVNamespace(db, kv.id)
	}

	for (const r2 of config.r2_buckets ?? []) {
		env[r2.binding] = new FileR2Bucket(db, r2.bucket_name, dataDir)
	}

	for (const d1 of config.d1_databases ?? []) {
		env[d1.binding] = openD1Database(dataDir, d1.database_name)
	}

	for (const producer of config.queues?.producers ?? []) {
		env[producer.binding] = makeQueueProducerProxy(producer.binding, rpc)
	}

	for (const email of config.send_email ?? []) {
		env[email.name] = makeSendEmailProxy(email.name, rpc)
	}

	for (const svc of config.services ?? []) {
		env[svc.binding] = makeServiceBindingProxy(svc.binding, rpc)
	}

	for (const doBinding of config.durable_objects?.bindings ?? []) {
		env[doBinding.name] = makeDONamespaceProxy(doBinding.name, rpc)
	}

	// Workflows live entirely in the worker thread — class refs and the
	// state machine are both here; main never sees the binding. Caller wires
	// the class once the user module is imported.
	const workflows: ThreadEnvBuilt['workflows'] = []
	for (const wf of config.workflows ?? []) {
		const binding = new SqliteWorkflowBinding(db, wf.binding, wf.class_name, wf.limits)
		env[wf.binding] = binding
		workflows.push({ bindingName: wf.binding, className: wf.class_name, binding })
	}

	if (config.assets?.binding) {
		const assetsDir = path.resolve(baseDir, config.assets.directory)
		env[config.assets.binding] = new StaticAssets(assetsDir, config.assets.html_handling, config.assets.not_found_handling)
	}

	if (config.images) {
		env[config.images.binding] = new ImagesBinding()
	}

	if (config.media) {
		env[config.media.binding] = new MediaBinding()
	}

	for (const hd of config.hyperdrive ?? []) {
		env[hd.binding] = new HyperdriveBinding(hd.localConnectionString ?? '')
	}

	if (config.ai) {
		const accountId = typeof env.CLOUDFLARE_ACCOUNT_ID === 'string' ? env.CLOUDFLARE_ACCOUNT_ID : process.env.CLOUDFLARE_ACCOUNT_ID
		const apiToken = typeof env.CLOUDFLARE_API_TOKEN === 'string' ? env.CLOUDFLARE_API_TOKEN : process.env.CLOUDFLARE_API_TOKEN
		env[config.ai.binding] = new AiBinding(db, accountId, apiToken)
	}

	for (const ae of config.analytics_engine_datasets ?? []) {
		env[ae.binding] = new SqliteAnalyticsEngine(db, ae.dataset ?? ae.binding)
	}

	if (config.version_metadata) {
		env[config.version_metadata.binding] = {
			id: 'local-dev',
			tag: '',
			timestamp: new Date().toISOString(),
		}
	}

	return { env, db, workflows }
}

function makeQueueProducerProxy(bindingName: string, rpc: RpcClient): Record<string, unknown> {
	const target: BindingTarget = { binding: bindingName }
	return {
		send: (message: unknown, options?: unknown) => rpc.call(target, 'send', [message, options]),
		sendBatch: (messages: unknown, options?: unknown) => rpc.call(target, 'sendBatch', [messages, options]),
	}
}

async function materializeEmailRaw(raw: unknown): Promise<Uint8Array | ArrayBuffer | string> {
	if (typeof raw === 'string' || raw instanceof Uint8Array || raw instanceof ArrayBuffer) return raw
	if (raw && typeof (raw as ReadableStream).getReader === 'function') {
		return new Response(raw as ReadableStream).arrayBuffer()
	}
	throw new Error('EmailMessage.raw must be a string, Uint8Array, ArrayBuffer, or ReadableStream')
}

async function proxyFetch(target: BindingTarget, rpc: RpcClient, input: Request | string | URL, init?: RequestInit): Promise<Response> {
	const url = input instanceof URL ? input.toString() : input
	const request = typeof url === 'string' ? new Request(url, init) : url
	return deserializeResponse(await rpc.callFetch(target, request))
}

/**
 * Build a Proxy that exposes `.fetch` over `binding-fetch` and turns any other
 * (non-NON_RPC_PROPS) property into an RPC method callable. `extras` overrides
 * specific props (used by DO stubs to surface `id`/`name`, service bindings
 * to surface `connect`). Methods are cached per (proxy, prop) so hot callers
 * don't allocate a fresh function per access.
 */
function makeRpcProxy(target: BindingTarget, rpc: RpcClient, extras: Record<string | symbol, unknown> = {}): unknown {
	const methodCache = new Map<string | symbol, unknown>()
	return new Proxy({} as Record<string, unknown>, {
		get(_obj, prop) {
			// Filter Promise-protocol props so `await proxy.foo` doesn't dispatch
			// `then`/`catch`/`finally` as RPC method calls.
			if (NON_RPC_PROPS.has(prop)) return undefined
			if (prop in extras) return extras[prop]
			const cached = methodCache.get(prop)
			if (cached) return cached
			const fn = prop === 'fetch'
				? (input: Request | string | URL, init?: RequestInit) => proxyFetch(target, rpc, input, init)
				: (...args: unknown[]) => rpc.call(target, prop as string, args)
			methodCache.set(prop, fn)
			return fn
		},
	})
}

function makeDOStubProxy(bindingName: string, idStr: string, id: DurableObjectIdImpl, rpc: RpcClient): unknown {
	return makeRpcProxy({ binding: bindingName, instanceId: idStr }, rpc, { id, name: id.name })
}

function makeDONamespaceProxy(bindingName: string, rpc: RpcClient): Record<string, unknown> {
	const stubs = new Map<string, unknown>()
	const idFromName = (name: string) => new DurableObjectIdImpl(hashIdFromName(name), name)
	const idFromString = (idStr: string) => new DurableObjectIdImpl(idStr)
	const newUniqueId = (_opts?: { jurisdiction?: string }) => new DurableObjectIdImpl(randomUniqueIdHex())
	const get = (id: DurableObjectIdImpl) => {
		const key = id.toString()
		let stub = stubs.get(key)
		if (!stub) {
			stub = makeDOStubProxy(bindingName, key, id, rpc)
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

function makeServiceBindingProxy(bindingName: string, rpc: RpcClient): unknown {
	return makeRpcProxy({ binding: bindingName }, rpc, {
		connect: () => {
			throw serviceBindingConnectError(bindingName)
		},
	})
}

function makeSendEmailProxy(bindingName: string, rpc: RpcClient): Record<string, unknown> {
	const target: BindingTarget = { binding: bindingName }
	return {
		send: async (message: unknown) => {
			// Structured-clone strips EmailMessage's class identity, so tag it and
			// let main rebuild via `reifyArgs` in executor.ts.
			const arg = message instanceof EmailMessage
				? {
					__lopata_class: 'EmailMessage' as const,
					from: message.from,
					to: message.to,
					raw: await materializeEmailRaw(message.raw),
				}
				: message
			return rpc.call(target, 'send', [arg])
		},
	}
}

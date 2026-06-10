/**
 * Lightweight env builder for DO worker threads.
 *
 * Each worker thread opens its own Database connection to the same
 * .lopata/data.sqlite (WAL mode ensures safe concurrent access).
 * It builds binding instances (KV, R2, D1, queues) that wrap the
 * shared DB/filesystem — these are stateless wrappers safe to duplicate.
 */

import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { WranglerConfig } from '../config'
import { runMigrations } from '../db'
import { parseDevVars } from '../env'
import { warnCrossThreadRpcArgs, warnInvalidRpcArgs } from '../rpc-validate'
import { getActiveContext } from '../tracing/context'
import type { BindingTarget, ParentSpanContext, SerializedResponse } from '../worker-thread/protocol'
import { RpcClient } from '../worker-thread/rpc-shared'
import { tagCloneable } from '../worker-thread/rpc-shared'
import type { WsGuestBridge } from '../worker-thread/ws-bridge-shared'
import { AiBinding } from './ai'
import { SqliteAnalyticsEngine } from './analytics-engine'
import { BrowserBinding } from './browser'
import { openD1Database } from './d1'
import type { DOMainMessage } from './do-executor-worker'
import { DurableObjectIdImpl, DurableObjectNamespaceImpl, hashIdFromName, randomUniqueIdHex } from './durable-object'
import { EmailMessage } from './email'
import { HyperdriveBinding } from './hyperdrive'
import { ImagesBinding } from './images'
import { SqliteKVNamespace } from './kv'
import { MediaBinding } from './media'
import { SqliteQueueProducer } from './queue'
import { FileR2Bucket } from './r2'
import { makeBindingProxy } from './rpc-stub'
import { StaticAssets } from './static-assets'
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

	// `.dev.vars` / `.env` — on real CF a DO's env equals the worker's env, which
	// includes these secrets. Without this `this.env.MY_SECRET` is undefined.
	const devVarsPath = join(baseDir, '.dev.vars')
	const envPath = join(baseDir, '.env')
	const filePath = existsSync(devVarsPath) ? devVarsPath : existsSync(envPath) ? envPath : null
	if (filePath) {
		for (const [key, value] of Object.entries(parseDevVars(readFileSync(filePath, 'utf-8')))) {
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
		// A plain RPC proxy would DataCloneError on an EmailMessage whose `raw` is a
		// ReadableStream; materialize it and tag the class so main can rebuild it.
		env[email.name] = makeSendEmailProxy(email.name, rpc, envWsBridge)
	}
	for (const wf of config.workflows ?? []) {
		env[wf.binding] = makeEnvBindingProxy(wf.binding, rpc, envWsBridge)
	}

	// Stateless bindings missing until now — on real CF a DO's env equals the
	// worker's env, so these must be present here too (mirrors thread-env.ts).
	if (config.assets?.binding) {
		const assetsDir = resolve(baseDir, config.assets.directory)
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
	if (config.browser) {
		env[config.browser.binding] = new BrowserBinding({})
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
		env[config.version_metadata.binding] = { id: 'local-dev', tag: '', timestamp: new Date().toISOString() }
	}

	return { db, env, doNamespaces }
}

async function materializeEmailRaw(raw: unknown): Promise<Uint8Array | ArrayBuffer | string> {
	if (typeof raw === 'string' || raw instanceof Uint8Array || raw instanceof ArrayBuffer) return raw
	if (raw && typeof (raw as ReadableStream).getReader === 'function') {
		return new Response(raw as ReadableStream).arrayBuffer()
	}
	throw new Error('EmailMessage.raw must be a string, Uint8Array, ArrayBuffer, or ReadableStream')
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

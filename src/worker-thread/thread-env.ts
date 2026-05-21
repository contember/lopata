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
import { QueueConsumer } from '../bindings/queue'
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
	/** Thread-local DB handle. Exposed so the caller can spin up queue consumers
	 *  (need the same handle the bindings write to). */
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

/**
 * Start queue consumers in the worker thread. The shared SQLite means the
 * consumer can poll, manage leases, and apply ack/retry decisions locally —
 * exactly like the in-process flow — without any cross-thread RPC.
 */
export function startThreadQueueConsumers(
	config: WranglerConfig,
	db: Database,
	env: Record<string, unknown>,
	workerModule: Record<string, unknown>,
): QueueConsumer[] {
	const handler = resolveQueueHandler(workerModule)
	if (!handler) return []
	const consumers: QueueConsumer[] = []
	for (const cfg of config.queues?.consumers ?? []) {
		const consumer = new QueueConsumer(
			db,
			{
				queue: cfg.queue,
				maxBatchSize: cfg.max_batch_size ?? 10,
				maxBatchTimeout: cfg.max_batch_timeout ?? 5,
				maxRetries: cfg.max_retries ?? 3,
				deadLetterQueue: cfg.dead_letter_queue ?? null,
				maxConcurrency: cfg.max_concurrency ?? null,
				retryDelay: cfg.retry_delay ?? null,
			},
			handler,
			env,
		)
		consumer.start()
		consumers.push(consumer)
	}
	return consumers
}

/** Wrap whatever the user returns into the QueueHandler signature (`Promise<void>`). */
function resolveQueueHandler(workerModule: Record<string, unknown>): ((batch: unknown, env: unknown, ctx: unknown) => Promise<void>) | null {
	const def = workerModule.default
	if (typeof def === 'function' && def.prototype) {
		const proto = def.prototype as Record<string, unknown>
		if (typeof proto.queue !== 'function') return null
		// Class-based: construct a fresh instance per batch — mirrors
		// `Generation.getHandler` for the in-process path.
		const Ctor = def as new(ctx: unknown, env: unknown) => Record<string, (...a: unknown[]) => Promise<unknown>>
		return async (batch, env, ctx) => {
			const instance = new Ctor(ctx, env)
			await instance.queue!(batch, env, ctx)
		}
	}
	const obj = def as Record<string, unknown> | null | undefined
	const queueFn = obj?.queue
	if (typeof queueFn !== 'function') return null
	const fn = queueFn as (batch: unknown, env: unknown, ctx: unknown) => Promise<unknown>
	return async (batch, env, ctx) => {
		await fn.call(obj, batch, env, ctx)
	}
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

function makeDOStubProxy(bindingName: string, idStr: string, id: DurableObjectIdImpl, rpc: RpcClient): unknown {
	const target: BindingTarget = { binding: bindingName, instanceId: idStr }
	return new Proxy({} as Record<string, unknown>, {
		get(_obj, prop) {
			// Filter Promise-protocol props so `await stub.foo` doesn't dispatch
			// `then`/`catch`/`finally` as RPC method calls.
			if (NON_RPC_PROPS.has(prop)) return undefined
			if (prop === 'id') return id
			if (prop === 'name') return id.name
			if (prop === 'fetch') {
				return (input: Request | string | URL, init?: RequestInit) => proxyFetch(target, rpc, input, init)
			}
			return (...args: unknown[]) => rpc.call(target, prop as string, args)
		},
	})
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
	const target: BindingTarget = { binding: bindingName }
	return {
		fetch: (input: Request | string | URL, init?: RequestInit) => proxyFetch(target, rpc, input, init),
		connect: () => {
			throw serviceBindingConnectError(bindingName)
		},
	}
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

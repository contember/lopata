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
import { EmailMessage } from '../bindings/email'
import { HyperdriveBinding } from '../bindings/hyperdrive'
import { ImagesBinding } from '../bindings/images'
import { SqliteKVNamespace } from '../bindings/kv'
import { MediaBinding } from '../bindings/media'
import { FileR2Bucket } from '../bindings/r2'
import { StaticAssets } from '../bindings/static-assets'
import type { WranglerConfig } from '../config'
import { runMigrations } from '../db'
import { parseDevVars } from '../env'
import type { BindingTarget } from './protocol'
import type { RpcClient } from './rpc-client'

export interface ThreadEnvOptions {
	config: WranglerConfig
	baseDir: string
	rpc: RpcClient
}

export function buildThreadEnv({ config, baseDir, rpc }: ThreadEnvOptions): Record<string, unknown> {
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

	return env
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

function makeServiceBindingProxy(bindingName: string, rpc: RpcClient): unknown {
	const target: BindingTarget = { binding: bindingName }
	return {
		fetch: async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
			const url = input instanceof URL ? input.toString() : input
			const request = typeof url === 'string' ? new Request(url, init) : url
			const serialized = await rpc.callFetch(target, request)
			return new Response(serialized.body, {
				status: serialized.status,
				statusText: serialized.statusText,
				headers: serialized.headers,
			})
		},
		connect: () => {
			throw new Error(`Service binding "${bindingName}": connect() (TCP sockets) is not supported in local dev mode`)
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

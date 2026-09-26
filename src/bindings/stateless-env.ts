/**
 * The bindings whose state lives on disk (.lopata SQLite/files) or nowhere at all, built the
 * same way by every env builder: main (`src/env.ts`), the worker thread
 * (`src/worker-thread/thread-env.ts`) and the DO worker (`do-worker-env.ts`). On Cloudflare a
 * DO's env equals the worker's env; keeping one list here stops the builders drifting apart.
 *
 * Stateful bindings (DO namespaces, queues, workflows, service bindings, email) differ per
 * builder, because each thread reaches them differently, and stay in the builders.
 */

import type { Database } from 'bun:sqlite'
import path from 'node:path'
import type { WranglerConfig } from '../config'
import { instrumentBinding, instrumentD1 } from '../tracing/instrument'
import { AiBinding } from './ai'
import { AiSearchNamespaceBinding } from './ai-search'
import { SqliteAnalyticsEngine } from './analytics-engine'
import { ArtifactsBinding } from './artifacts'
import { BrowserBinding } from './browser'
import { openD1Database } from './d1'
import { FlagshipBinding } from './flagship'
import { HyperdriveBinding } from './hyperdrive'
import { ImagesBinding } from './images'
import { SqliteKVNamespace } from './kv'
import { MediaBinding } from './media'
import { FileR2Bucket } from './r2'
import { StaticAssets } from './static-assets'
import { VpcNetworkBinding } from './vpc-network'
import { WorkerLoaderBinding } from './worker-loader'

export interface BrowserConfig {
	wsEndpoint?: string
	executablePath?: string
	headless?: boolean
}

export interface StatelessEnvOptions {
	config: WranglerConfig
	db: Database
	/** Shared `.lopata` data dir (SQLite, r2, d1, artifacts, worker-loader). */
	dataDir: string
	/** The worker's base dir; `assets.directory` resolves against it. */
	baseDir: string
	browserConfig?: BrowserConfig
	/** Base URL of main's Artifacts git endpoint (`/__artifacts/git`). */
	artifactsBaseUrl?: string
	/** Main builds the StaticAssets itself (it also auto-serves them) and passes it in. */
	staticAssets?: StaticAssets
	/** Startup log line per binding; only main prints them. */
	log?: (message: string) => void
}

/**
 * Cloudflare API credentials for the bindings that proxy to the real API (AI, AI Search):
 * the worker's own vars first (`.dev.vars`), then the host environment.
 */
export function cloudflareCredentials(env: Record<string, unknown>): { accountId?: string; apiToken?: string } {
	const accountId = typeof env.CLOUDFLARE_ACCOUNT_ID === 'string' ? env.CLOUDFLARE_ACCOUNT_ID : process.env.CLOUDFLARE_ACCOUNT_ID
	const apiToken = typeof env.CLOUDFLARE_API_TOKEN === 'string' ? env.CLOUDFLARE_API_TOKEN : process.env.CLOUDFLARE_API_TOKEN
	return { accountId, apiToken }
}

export function createStaticAssets(config: WranglerConfig, baseDir: string): StaticAssets | null {
	if (!config.assets) return null
	const assetsDir = path.resolve(baseDir, config.assets.directory)
	return new StaticAssets(assetsDir, config.assets.html_handling, config.assets.not_found_handling)
}

/** Add every stateless binding the config declares to `env`. Vars must already be in `env`. */
export function addStatelessBindings(env: Record<string, unknown>, opts: StatelessEnvOptions): void {
	const { config, db, dataDir, baseDir, browserConfig, artifactsBaseUrl } = opts
	const log = opts.log ?? (() => {})

	for (const kv of config.kv_namespaces ?? []) {
		log(`KV namespace: ${kv.binding}`)
		env[kv.binding] = instrumentBinding(new SqliteKVNamespace(db, kv.id), {
			type: 'kv',
			name: kv.binding,
			methods: ['get', 'getWithMetadata', 'put', 'delete', 'list'],
		})
	}

	for (const r2 of config.r2_buckets ?? []) {
		log(`R2 bucket: ${r2.binding} (${r2.bucket_name})`)
		env[r2.binding] = instrumentBinding(new FileR2Bucket(db, r2.bucket_name, dataDir), {
			type: 'r2',
			name: r2.binding,
			methods: ['get', 'put', 'delete', 'list', 'head', 'createMultipartUpload'],
		})
	}

	for (const d1 of config.d1_databases ?? []) {
		log(`D1 database: ${d1.binding} (${d1.database_name})`)
		env[d1.binding] = instrumentD1(openD1Database(dataDir, d1.database_name), d1.binding)
	}

	if (config.assets?.binding) {
		const assets = opts.staticAssets ?? createStaticAssets(config, baseDir)!
		log(`Static assets: ${config.assets.binding} -> ${config.assets.directory}`)
		env[config.assets.binding] = instrumentBinding(assets, { type: 'assets', name: config.assets.binding, methods: ['fetch'] })
	}

	if (config.images) {
		log(`Images binding: ${config.images.binding}`)
		env[config.images.binding] = instrumentBinding(new ImagesBinding(), { type: 'images', name: config.images.binding, methods: ['info'] })
	}

	if (config.media) {
		log(`Media binding: ${config.media.binding}`)
		env[config.media.binding] = instrumentBinding(new MediaBinding(), { type: 'media', name: config.media.binding, methods: [] })
	}

	for (const hd of config.hyperdrive ?? []) {
		log(`Hyperdrive: ${hd.binding}`)
		env[hd.binding] = new HyperdriveBinding(hd.localConnectionString ?? '')
	}

	if (config.browser) {
		log(`Browser binding: ${config.browser.binding}`)
		env[config.browser.binding] = instrumentBinding(new BrowserBinding(browserConfig ?? {}), {
			type: 'browser',
			name: config.browser.binding,
			methods: ['launch', 'connect', 'sessions'],
		})
	}

	const { accountId, apiToken } = cloudflareCredentials(env)

	if (config.ai) {
		log(`AI binding: ${config.ai.binding}`)
		env[config.ai.binding] = instrumentBinding(new AiBinding(db, accountId, apiToken), {
			type: 'ai',
			name: config.ai.binding,
			methods: ['run', 'models'],
		})
	}

	for (const ae of config.analytics_engine_datasets ?? []) {
		log(`Analytics Engine: ${ae.binding} (dataset: ${ae.dataset ?? ae.binding})`)
		env[ae.binding] = instrumentBinding(new SqliteAnalyticsEngine(db, ae.dataset ?? ae.binding), {
			type: 'analytics_engine',
			name: ae.binding,
			methods: ['writeDataPoint'],
		})
	}

	// VPC Networks: pass-through fetcher (network_id = Mesh, tunnel_id = tunnel)
	for (const vpc of config.vpc_networks ?? []) {
		const networkId = vpc.network_id ?? vpc.tunnel_id
		if (!networkId) {
			throw new Error(`VPC Network "${vpc.binding}" requires either network_id or tunnel_id`)
		}
		log(`VPC Network: ${vpc.binding} (${vpc.tunnel_id ? 'tunnel' : 'network'}: ${networkId})`)
		env[vpc.binding] = instrumentBinding(new VpcNetworkBinding({ networkId, bindingName: vpc.binding }), {
			type: 'vpc_network',
			name: vpc.binding,
			methods: ['fetch'],
		})
	}

	// AI Search namespaces: proxy to the CF AI Search REST API
	for (const ns of config.ai_search_namespaces ?? []) {
		log(`AI Search namespace: ${ns.binding} (namespace: ${ns.namespace})`)
		env[ns.binding] = instrumentBinding(new AiSearchNamespaceBinding(db, ns.namespace, accountId, apiToken), {
			type: 'ai_search',
			name: ns.binding,
			// get() is synchronous and makes no request, so it stays unwrapped
			methods: ['create', 'list', 'delete', 'search', 'chatCompletions'],
		})
	}

	// Artifacts: control plane (SQLite + bare git repos under dataDir/artifacts); the
	// git-over-HTTP endpoint is served by main's Bun.serve at /__artifacts/git/*.
	for (const artifacts of config.artifacts ?? []) {
		const remoteBase = (artifactsBaseUrl ?? 'http://localhost:8787/__artifacts/git').replace(/\/$/, '')
		log(`Artifacts binding: ${artifacts.binding} (namespace: ${artifacts.namespace})`)
		env[artifacts.binding] = instrumentBinding(
			new ArtifactsBinding(db, artifacts.namespace, path.join(dataDir, 'artifacts'), remoteBase),
			{ type: 'artifacts', name: artifacts.binding, methods: ['create', 'get', 'list', 'import', 'delete'] },
		)
	}

	// Worker Loader: dynamic Workers, each its own nested Bun worker thread. Not wrapped in
	// instrumentBinding: load()/get() return live WorkerStub handles synchronously, and the
	// async span wrapper would turn them into Promises, breaking the
	// `loader.get(id).getEntrypoint().fetch()` chaining the Cloudflare API requires.
	for (const loader of config.worker_loaders ?? []) {
		log(`Worker Loader: ${loader.binding}`)
		env[loader.binding] = new WorkerLoaderBinding(path.join(dataDir, 'worker-loader'))
	}

	// Flagship: SQLite-backed feature flags
	if (config.flagship) {
		log(`Flagship binding: ${config.flagship.binding} (app: ${config.flagship.app_id})`)
		env[config.flagship.binding] = instrumentBinding(new FlagshipBinding(db, config.flagship.app_id), {
			type: 'flagship',
			name: config.flagship.binding,
			methods: [
				'getBooleanValue',
				'getStringValue',
				'getNumberValue',
				'getObjectValue',
				'getBooleanValueDetails',
				'getStringValueDetails',
				'getNumberValueDetails',
				'getObjectValueDetails',
			],
		})
	}

	if (config.version_metadata) {
		env[config.version_metadata.binding] = { id: 'local-dev', tag: '', timestamp: new Date().toISOString() }
	}
}

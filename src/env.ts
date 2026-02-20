import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { AiBinding } from './bindings/ai'
import { SqliteAnalyticsEngine } from './bindings/analytics-engine'
import { BrowserBinding } from './bindings/browser'
import { ContainerBase } from './bindings/container'
import { DockerManager } from './bindings/container-docker'
import { openD1Database } from './bindings/d1'
import type { DOExecutorFactory } from './bindings/do-executor'
import { DurableObjectNamespaceImpl } from './bindings/durable-object'
import { SendEmailBinding } from './bindings/email'
import { HyperdriveBinding } from './bindings/hyperdrive'
import { ImagesBinding } from './bindings/images'
import { SqliteKVNamespace } from './bindings/kv'
import { QueueConsumer, SqliteQueueProducer } from './bindings/queue'
import { FileR2Bucket } from './bindings/r2'
import { createServiceBinding } from './bindings/service-binding'
import { StaticAssets } from './bindings/static-assets'
import { SqliteWorkflowBinding } from './bindings/workflow'
import type { WranglerConfig } from './config'
import { getDatabase, getDataDir } from './db'
import { instrumentBinding, instrumentD1, instrumentDONamespace, instrumentServiceBinding } from './tracing/instrument'
import type { WorkerRegistry } from './worker-registry'

/**
 * Global reference to the built env object. Used by cloudflare:workers `env` export.
 * Must remain the same object reference — we mutate it in place so that
 * `import { env } from "cloudflare:workers"` always sees current bindings.
 */
export const globalEnv: Record<string, unknown> = {}

export function setGlobalEnv(env: Record<string, unknown>) {
	for (const key of Object.keys(globalEnv)) {
		delete globalEnv[key]
	}
	Object.assign(globalEnv, env)
}

export function parseDevVars(content: string): Record<string, string> {
	const vars: Record<string, string> = {}
	for (const line of content.split('\n')) {
		const trimmed = line.trim()
		if (!trimmed || trimmed.startsWith('#')) continue
		const eqIndex = trimmed.indexOf('=')
		if (eqIndex === -1) continue
		const key = trimmed.slice(0, eqIndex).trim()
		let value = trimmed.slice(eqIndex + 1).trim()
		// Strip surrounding quotes
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1)
		}
		vars[key] = value
	}
	return vars
}

interface ConsumerConfig {
	queue: string
	maxBatchSize: number
	maxBatchTimeout: number
	maxRetries: number
	deadLetterQueue: string | null
}

interface ServiceBindingEntry {
	bindingName: string
	serviceName: string
	entrypoint?: string
	proxy: Record<string, unknown>
}

interface ClassRegistry {
	durableObjects: { bindingName: string; className: string; namespace: DurableObjectNamespaceImpl }[]
	workflows: { bindingName: string; className: string; binding: SqliteWorkflowBinding }[]
	containers: { className: string; image: string; maxInstances?: number; namespace: DurableObjectNamespaceImpl }[]
	queueConsumers: ConsumerConfig[]
	serviceBindings: ServiceBindingEntry[]
	staticAssets: StaticAssets | null
}

export function buildEnv(
	config: WranglerConfig,
	devVarsDir?: string,
	executorFactory?: DOExecutorFactory,
	browserConfig?: { wsEndpoint?: string; executablePath?: string; headless?: boolean },
): { env: Record<string, unknown>; registry: ClassRegistry } {
	const env: Record<string, unknown> = {}
	const registry: ClassRegistry = { durableObjects: [], workflows: [], containers: [], queueConsumers: [], serviceBindings: [], staticAssets: null }

	// Environment variables from config
	if (config.vars) {
		for (const [key, value] of Object.entries(config.vars)) {
			env[key] = value
		}
	}

	// Override with .dev.vars or .env file (if exists)
	// .dev.vars takes priority over .env (matching CF behavior)
	if (devVarsDir) {
		const devVarsPath = path.join(devVarsDir, '.dev.vars')
		const envPath = path.join(devVarsDir, '.env')
		const filePath = existsSync(devVarsPath) ? devVarsPath : existsSync(envPath) ? envPath : null
		if (filePath) {
			const content = readFileSync(filePath, 'utf-8')
			const devVars = parseDevVars(content)
			for (const [key, value] of Object.entries(devVars)) {
				env[key] = value
			}
		}
	}

	// KV namespaces
	const db = getDatabase()
	for (const kv of config.kv_namespaces ?? []) {
		console.log(`[lopata] KV namespace: ${kv.binding}`)
		env[kv.binding] = instrumentBinding(new SqliteKVNamespace(db, kv.id), {
			type: 'kv',
			name: kv.binding,
			methods: ['get', 'getWithMetadata', 'put', 'delete', 'list'],
		})
	}

	// R2 buckets
	for (const r2 of config.r2_buckets ?? []) {
		console.log(`[lopata] R2 bucket: ${r2.binding} (${r2.bucket_name})`)
		env[r2.binding] = instrumentBinding(new FileR2Bucket(db, r2.bucket_name, getDataDir()), {
			type: 'r2',
			name: r2.binding,
			methods: ['get', 'put', 'delete', 'list', 'head', 'createMultipartUpload'],
		})
	}

	// Durable Objects
	for (const doBinding of config.durable_objects?.bindings ?? []) {
		console.log(`[lopata] Durable Object: ${doBinding.name} -> ${doBinding.class_name}`)
		const namespace = new DurableObjectNamespaceImpl(db, doBinding.class_name, getDataDir(), undefined, executorFactory)
		env[doBinding.name] = instrumentDONamespace(namespace, doBinding.class_name)
		registry.durableObjects.push({
			bindingName: doBinding.name,
			className: doBinding.class_name,
			namespace,
		})
	}

	// Workflows
	for (const wf of config.workflows ?? []) {
		console.log(`[lopata] Workflow: ${wf.binding} -> ${wf.class_name}`)
		const binding = new SqliteWorkflowBinding(db, wf.binding, wf.class_name, wf.limits)
		env[wf.binding] = instrumentBinding(binding, {
			type: 'workflow',
			name: wf.binding,
			methods: ['create', 'get'],
		})
		registry.workflows.push({
			bindingName: wf.binding,
			className: wf.class_name,
			binding,
		})
	}

	// D1 databases
	for (const d1 of config.d1_databases ?? []) {
		console.log(`[lopata] D1 database: ${d1.binding} (${d1.database_name})`)
		env[d1.binding] = instrumentD1(openD1Database(getDataDir(), d1.database_name), d1.binding)
	}

	// Queue producers
	for (const producer of config.queues?.producers ?? []) {
		console.log(`[lopata] Queue producer: ${producer.binding} -> ${producer.queue}`)
		env[producer.binding] = instrumentBinding(new SqliteQueueProducer(db, producer.queue, producer.delivery_delay ?? 0), {
			type: 'queue',
			name: producer.binding,
			methods: ['send', 'sendBatch'],
		})
	}

	// Queue consumers (configs — actual consumers started in dev.ts after worker import)
	for (const consumer of config.queues?.consumers ?? []) {
		console.log(`[lopata] Queue consumer: ${consumer.queue}`)
		registry.queueConsumers.push({
			queue: consumer.queue,
			maxBatchSize: consumer.max_batch_size ?? 10,
			maxBatchTimeout: consumer.max_batch_timeout ?? 5,
			maxRetries: consumer.max_retries ?? 3,
			deadLetterQueue: consumer.dead_letter_queue ?? null,
		})
	}

	// Service bindings
	for (const svc of config.services ?? []) {
		console.log(`[lopata] Service binding: ${svc.binding} -> ${svc.service}${svc.entrypoint ? ` (${svc.entrypoint})` : ''}`)
		const proxy = createServiceBinding(svc.service, svc.entrypoint)
		env[svc.binding] = instrumentServiceBinding(proxy as object, svc.service) as Record<string, unknown>
		registry.serviceBindings.push({
			bindingName: svc.binding,
			serviceName: svc.service,
			entrypoint: svc.entrypoint,
			proxy,
		})
	}

	// Images binding
	if (config.images) {
		console.log(`[lopata] Images binding: ${config.images.binding}`)
		env[config.images.binding] = instrumentBinding(new ImagesBinding(), {
			type: 'images',
			name: config.images.binding,
			methods: ['info'],
		})
	}

	// Send email bindings
	for (const email of config.send_email ?? []) {
		console.log(`[lopata] Send email binding: ${email.name}`)
		env[email.name] = instrumentBinding(
			new SendEmailBinding(db, email.name, email.destination_address, email.allowed_destination_addresses),
			{ type: 'email', name: email.name, methods: ['send'] },
		)
	}

	// Hyperdrive
	for (const hd of config.hyperdrive ?? []) {
		const connStr = hd.localConnectionString ?? ''
		console.log(`[lopata] Hyperdrive: ${hd.binding}`)
		env[hd.binding] = new HyperdriveBinding(connStr)
	}

	// Workers AI
	if (config.ai) {
		const accountId = (env.CLOUDFLARE_ACCOUNT_ID ?? process.env.CLOUDFLARE_ACCOUNT_ID) as string | undefined
		const apiToken = (env.CLOUDFLARE_API_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN) as string | undefined
		console.log(`[lopata] AI binding: ${config.ai.binding}`)
		env[config.ai.binding] = instrumentBinding(
			new AiBinding(db, accountId, apiToken),
			{ type: 'ai', name: config.ai.binding, methods: ['run', 'models'] },
		)
	}

	// Analytics Engine datasets
	for (const ae of config.analytics_engine_datasets ?? []) {
		console.log(`[lopata] Analytics Engine: ${ae.binding} (dataset: ${ae.dataset ?? ae.binding})`)
		env[ae.binding] = instrumentBinding(
			new SqliteAnalyticsEngine(db, ae.dataset ?? ae.binding),
			{ type: 'analytics_engine', name: ae.binding, methods: ['writeDataPoint'] },
		)
	}

	// Containers — create DO namespaces for container classes
	const doClassNames = new Set((config.durable_objects?.bindings ?? []).map(b => b.class_name))
	for (const container of config.containers ?? []) {
		// Skip if this class is already defined as a DO binding (avoid double-creating)
		if (doClassNames.has(container.class_name)) {
			// Find the existing namespace and register container config on it
			const existing = registry.durableObjects.find(d => d.className === container.class_name)
			if (existing) {
				registry.containers.push({
					className: container.class_name,
					image: container.image,
					maxInstances: container.max_instances,
					namespace: existing.namespace,
				})
				console.log(`[lopata] Container: ${container.class_name} (reusing DO binding, image: ${container.image})`)
			}
		} else {
			// Create a new DO namespace for this container
			const bindingName = container.name ?? container.class_name
			console.log(`[lopata] Container: ${bindingName} -> ${container.class_name} (image: ${container.image})`)
			const namespace = new DurableObjectNamespaceImpl(db, container.class_name, getDataDir(), undefined, executorFactory)
			env[bindingName] = instrumentDONamespace(namespace, container.class_name)
			registry.durableObjects.push({
				bindingName,
				className: container.class_name,
				namespace,
			})
			registry.containers.push({
				className: container.class_name,
				image: container.image,
				maxInstances: container.max_instances,
				namespace,
			})
		}
	}

	// Static assets
	if (config.assets) {
		const assetsDir = path.resolve(config.assets.directory)
		const assets = new StaticAssets(assetsDir, config.assets.html_handling, config.assets.not_found_handling)
		registry.staticAssets = assets
		if (config.assets.binding) {
			console.log(`[lopata] Static assets: ${config.assets.binding} -> ${config.assets.directory}`)
			env[config.assets.binding] = instrumentBinding(assets, {
				type: 'assets',
				name: config.assets.binding,
				methods: ['fetch'],
			})
		} else {
			console.log(`[lopata] Static assets: ${config.assets.directory} (auto-serve)`)
		}
	}

	// Browser Rendering binding
	if (config.browser) {
		console.log(`[lopata] Browser binding: ${config.browser.binding}`)
		env[config.browser.binding] = instrumentBinding(
			new BrowserBinding(browserConfig ?? {}),
			{ type: 'browser', name: config.browser.binding, methods: ['launch', 'connect', 'sessions'] },
		)
	}

	// Version metadata binding
	if (config.version_metadata) {
		const binding = config.version_metadata.binding
		env[binding] = {
			id: 'local-dev',
			tag: '',
			timestamp: new Date().toISOString(),
		}
	}

	// Store reference for cloudflare:workers env export
	setGlobalEnv(env)

	return { env, registry }
}

export function wireClassRefs(
	registry: ClassRegistry,
	workerModule: Record<string, unknown>,
	env: Record<string, unknown>,
	workerRegistry?: WorkerRegistry,
) {
	for (const entry of registry.durableObjects) {
		const cls = workerModule[entry.className]
		if (!cls) throw new Error(`Durable Object class "${entry.className}" not exported from worker module`)
		entry.namespace._setClass(cls as any, env)
		console.log(`[lopata] Wired DO class: ${entry.className}`)
	}

	for (const entry of registry.workflows) {
		const cls = workerModule[entry.className]
		if (!cls) throw new Error(`Workflow class "${entry.className}" not exported from worker module`)
		entry.binding._setClass(cls as any, env)
		entry.binding.resumeInterrupted()
		console.log(`[lopata] Wired Workflow class: ${entry.className}`)
	}

	// Wire container configs onto namespaces
	const dockerManager = new DockerManager()
	for (const entry of registry.containers) {
		entry.namespace._setContainerConfig({
			className: entry.className,
			image: entry.image,
			maxInstances: entry.maxInstances,
			dockerManager,
		})
		console.log(`[lopata] Wired container config: ${entry.className} (image: ${entry.image})`)
	}

	// Wire service bindings
	for (const entry of registry.serviceBindings) {
		const wire = entry.proxy._wire as ((resolver: () => { workerModule: Record<string, unknown>; env: Record<string, unknown> }) => void) | undefined
		if (wire) {
			if (workerRegistry) {
				// Resolve through registry (handles both self-ref and cross-worker)
				wire(() => workerRegistry.resolveTarget(entry.serviceName))
			} else {
				// Backward compat: self-reference
				wire(() => ({ workerModule, env }))
			}
			console.log(`[lopata] Wired service binding: ${entry.bindingName} -> ${entry.serviceName}${entry.entrypoint ? ` (${entry.entrypoint})` : ''}`)
		}
	}
}

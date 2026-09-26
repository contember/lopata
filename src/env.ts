import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import { ContainerBase } from './bindings/container'
import { containerLabels, registerContainer, unregisterContainer } from './bindings/container-cleanup'
import { DockerManager } from './bindings/container-docker'
import type { DOExecutorFactory } from './bindings/do-executor'
import { DurableObjectNamespaceImpl } from './bindings/durable-object'
import { SendEmailBinding } from './bindings/email'
import { QueueConsumer, SqliteQueueProducer } from './bindings/queue'
import { createServiceBinding } from './bindings/service-binding'
import { addStatelessBindings, createStaticAssets } from './bindings/stateless-env'
import type { StaticAssets } from './bindings/static-assets'
import { SqliteWorkflowBinding, wireWorkflowClass } from './bindings/workflow'
import type { WranglerConfig } from './config'
import { getDatabase, getDataDir } from './db'
import { instrumentBinding, instrumentDONamespace, instrumentServiceBinding } from './tracing/instrument'
import type { ResolvedTarget, WorkerRegistry } from './worker-registry'

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
	maxConcurrency: number | null
	retryDelay: number | null
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

/**
 * The plain-text vars of a worker's env: wrangler `vars`, then `.dev.vars` (or `.env`) from
 * `devVarsDir`, then `process.env`. Shared by every env builder (main, worker thread, DO
 * worker) so a DO's env equals the worker's env, as on Cloudflare.
 */
export function resolveVars(config: WranglerConfig, devVarsDir?: string): Record<string, unknown> {
	const vars: Record<string, unknown> = { ...config.vars }

	// .dev.vars takes priority over .env (matching CF behavior)
	if (devVarsDir) {
		const devVarsPath = path.join(devVarsDir, '.dev.vars')
		const envPath = path.join(devVarsDir, '.env')
		const filePath = existsSync(devVarsPath) ? devVarsPath : existsSync(envPath) ? envPath : null
		if (filePath) {
			Object.assign(vars, parseDevVars(readFileSync(filePath, 'utf-8')))
		}
	}

	// process.env wins last, but only over names the worker already declares. A worker's env is
	// its own config surface, so an undeclared host variable must never become a binding.
	// Values Bun itself loaded from dotenv files are not host variables: letting them win would
	// make `.env` beat `.dev.vars`, while wrangler ignores `.env` whenever `.dev.vars` exists.
	const autoloaded = bunAutoloadedDotenv(process.cwd())
	for (const key of Object.keys(vars)) {
		const fromProcess = process.env[key]
		if (fromProcess !== undefined && fromProcess !== autoloaded[key]) vars[key] = fromProcess
	}
	return vars
}

/**
 * The values Bun loads into process.env from dotenv files in `cwd` at startup: `.env`, then
 * `.env.<NODE_ENV>` (default `development`), then `.env.local` (skipped when NODE_ENV is
 * `test`). A variable set in the shell keeps its own value, so a process.env entry that equals
 * the file's value came from the file. A shell export that happens to equal it is treated the
 * same way; the result then differs only when `.dev.vars` sets that name too.
 */
function bunAutoloadedDotenv(cwd: string): Record<string, string> {
	const nodeEnv = process.env.NODE_ENV || 'development'
	const files = ['.env', `.env.${nodeEnv}`, ...(nodeEnv === 'test' ? [] : ['.env.local'])]
	const values: Record<string, string> = {}
	for (const file of files) {
		const filePath = path.join(cwd, file)
		if (existsSync(filePath)) Object.assign(values, parseDevVars(readFileSync(filePath, 'utf-8')))
	}
	return values
}

export function buildEnv(
	config: WranglerConfig,
	devVarsDir?: string,
	executorFactory?: DOExecutorFactory,
	browserConfig?: { wsEndpoint?: string; executablePath?: string; headless?: boolean },
	existingNamespaces?: Map<string, DurableObjectNamespaceImpl>,
	baseUrls?: { artifacts?: string },
): { env: Record<string, unknown>; registry: ClassRegistry } {
	const env: Record<string, unknown> = {}
	const registry: ClassRegistry = { durableObjects: [], workflows: [], containers: [], queueConsumers: [], serviceBindings: [], staticAssets: null }

	Object.assign(env, resolveVars(config, devVarsDir))

	// KV namespaces
	const db = getDatabase()

	// DO migrations (renamed_classes, deleted_classes)
	if (config.migrations) {
		for (const migration of config.migrations) {
			const applied = db.query('SELECT 1 FROM do_migrations WHERE tag = ?').get(migration.tag)
			if (applied) continue

			for (const { from, to } of migration.renamed_classes ?? []) {
				db.run('UPDATE do_storage SET namespace = ? WHERE namespace = ?', [to, from])
				db.run('UPDATE do_alarms SET namespace = ? WHERE namespace = ?', [to, from])
				db.run('UPDATE do_instances SET namespace = ? WHERE namespace = ?', [to, from])
				const fromDir = path.join(getDataDir(), 'do-sql', from)
				const toDir = path.join(getDataDir(), 'do-sql', to)
				if (existsSync(fromDir)) {
					renameSync(fromDir, toDir)
				}
				console.log(`[lopata] Migration ${migration.tag}: renamed DO class ${from} → ${to}`)
			}

			for (const className of migration.deleted_classes ?? []) {
				db.run('DELETE FROM do_storage WHERE namespace = ?', [className])
				db.run('DELETE FROM do_alarms WHERE namespace = ?', [className])
				db.run('DELETE FROM do_instances WHERE namespace = ?', [className])
				const classDir = path.join(getDataDir(), 'do-sql', className)
				if (existsSync(classDir)) {
					rmSync(classDir, { recursive: true })
				}
				console.log(`[lopata] Migration ${migration.tag}: deleted DO class ${className}`)
			}

			db.run('INSERT INTO do_migrations (tag) VALUES (?)', [migration.tag])
		}
	}

	// Durable Objects
	for (const doBinding of config.durable_objects?.bindings ?? []) {
		console.log(`[lopata] Durable Object: ${doBinding.name} -> ${doBinding.class_name}`)
		const existing = existingNamespaces?.get(doBinding.class_name)
		const namespace = existing ?? new DurableObjectNamespaceImpl(db, doBinding.class_name, getDataDir(), undefined, executorFactory)
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
			maxConcurrency: consumer.max_concurrency ?? null,
			retryDelay: consumer.retry_delay ?? null,
		})
	}

	// Service bindings
	for (const svc of config.services ?? []) {
		console.log(`[lopata] Service binding: ${svc.binding} -> ${svc.service}${svc.entrypoint ? ` (${svc.entrypoint})` : ''}`)
		const proxy = createServiceBinding(svc.service, svc.entrypoint, undefined, svc.props)
		env[svc.binding] = instrumentServiceBinding(proxy as object, svc.service) as Record<string, unknown>
		registry.serviceBindings.push({
			bindingName: svc.binding,
			serviceName: svc.service,
			entrypoint: svc.entrypoint,
			proxy,
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
			// Reuse the existing namespace across reloads (like the DO-binding branch
			// above) — constructing a fresh one would orphan the old namespace while a
			// new executor opens the same do-sql file for the same id, breaking DO
			// single-threading.
			const bindingName = container.name ?? container.class_name
			console.log(`[lopata] Container: ${bindingName} -> ${container.class_name} (image: ${container.image})`)
			const existingNs = existingNamespaces?.get(container.class_name)
			const namespace = existingNs ?? new DurableObjectNamespaceImpl(db, container.class_name, getDataDir(), undefined, executorFactory)
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

	// Static assets: main keeps the instance to auto-serve them even without a binding
	registry.staticAssets = createStaticAssets(config, devVarsDir ?? process.cwd())
	if (config.assets && !config.assets.binding) {
		console.log(`[lopata] Static assets: ${config.assets.directory} (auto-serve)`)
	}

	addStatelessBindings(env, {
		config,
		db,
		dataDir: getDataDir(),
		baseDir: devVarsDir ?? process.cwd(),
		browserConfig,
		artifactsBaseUrl: baseUrls?.artifacts,
		staticAssets: registry.staticAssets ?? undefined,
		log: (message) => console.log(`[lopata] ${message}`),
	})

	return { env, registry }
}

export function wireClassRefs(
	registry: ClassRegistry,
	workerModule: Record<string, unknown>,
	env: Record<string, unknown>,
	workerRegistry?: WorkerRegistry,
	generationId?: number,
) {
	for (const entry of registry.durableObjects) {
		const cls = workerModule[entry.className]
		if (!cls) throw new Error(`Durable Object class "${entry.className}" not exported from worker module`)
		entry.namespace._setClass(cls as any, env, generationId)
		console.log(`[lopata] Wired DO class: ${entry.className}`)
	}

	for (const entry of registry.workflows) {
		wireWorkflowClass(entry.binding, entry.className, workerModule, env)
		console.log(`[lopata] Wired Workflow class: ${entry.className}`)
	}

	// Wire container configs onto namespaces. Main-side path goes through the
	// cleanup registry directly (no postMessage needed — this *is* main).
	const dockerManager = new DockerManager({
		onRegister: registerContainer,
		onRemove: unregisterContainer,
		labels: containerLabels(),
	})
	for (const entry of registry.containers) {
		entry.namespace._setContainerConfig({
			className: entry.className,
			image: entry.image,
			maxInstances: entry.maxInstances,
			dockerManager,
		})
		console.log(`[lopata] Wired container config: ${entry.className} (image: ${entry.image})`)
	}

	wireServiceBindings(registry, workerModule, env, workerRegistry)
}

/**
 * Service-binding wiring extracted so thread-mode generations (which skip
 * `wireClassRefs` entirely — DO/Workflow classes live in the worker) can
 * still resolve cross-worker fetches through the registry.
 */
export function wireServiceBindings(
	registry: ClassRegistry,
	workerModule: Record<string, unknown>,
	env: Record<string, unknown>,
	workerRegistry?: WorkerRegistry,
) {
	for (const entry of registry.serviceBindings) {
		const wire = entry.proxy._wire as ((resolver: () => ResolvedTarget) => void) | undefined
		if (!wire) continue
		if (workerRegistry) {
			// Resolve through registry (handles both self-ref and cross-worker)
			wire(() => workerRegistry.resolveTarget(entry.serviceName))
		} else {
			// Backward compat: self-reference, in-process
			wire(() => ({ kind: 'in-process', workerModule, env }))
		}
		console.log(`[lopata] Wired service binding: ${entry.bindingName} -> ${entry.serviceName}${entry.entrypoint ? ` (${entry.entrypoint})` : ''}`)
	}
}

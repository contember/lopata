import type { DurableObjectNamespaceImpl } from './bindings/durable-object'
import { hasScript } from './config'
import type { GenerationManager } from './generation-manager'
import type { WorkerThreadExecutor } from './worker-thread/executor'

export type ResolvedTarget =
	| { kind: 'thread'; env: Record<string, unknown>; executor: WorkerThreadExecutor }
	| { kind: 'in-process'; env: Record<string, unknown>; workerModule: Record<string, unknown> }
	/** An assets-only worker: no script, so a fetch is answered by its static assets. */
	| { kind: 'assets'; env: Record<string, unknown>; assets: { fetch(req: Request): Promise<Response> } }

/**
 * Central registry holding all worker GenerationManagers, keyed by worker name.
 * Used to resolve cross-worker service bindings.
 */
export class WorkerRegistry {
	private managers = new Map<string, GenerationManager>()
	private mainName: string | null = null

	/** Register a worker's GenerationManager */
	register(name: string, manager: GenerationManager, isMain = false): void {
		this.managers.set(name, manager)
		if (isMain) {
			this.mainName = name
		}
	}

	/** Get manager by worker name */
	getManager(name: string): GenerationManager | undefined {
		return this.managers.get(name)
	}

	/** Get the main (HTTP entrypoint) worker's manager */
	getMainManager(): GenerationManager {
		if (!this.mainName) throw new Error('No main worker registered')
		const manager = this.managers.get(this.mainName)
		if (!manager) throw new Error('Main worker manager not found')
		return manager
	}

	/**
	 * Lazily resolve a target worker's module and env from its active generation.
	 * Called on each service binding invocation so hot-reloaded workers are picked up.
	 */
	resolveTarget(workerName: string): ResolvedTarget {
		const manager = this.managers.get(workerName)
		if (!manager) {
			throw new Error(`Worker "${workerName}" is not registered in the worker registry`)
		}
		const gen = manager.active
		if (!gen) {
			throw new Error(`Worker "${workerName}" has no active generation (failed to load?)`)
		}
		const threadExecutor = (gen as unknown as { threadExecutor?: WorkerThreadExecutor }).threadExecutor
		if (threadExecutor) {
			return { kind: 'thread', env: gen.env, executor: threadExecutor }
		}
		const workerModule = (gen as unknown as { workerModule?: Record<string, unknown> }).workerModule
		if (workerModule) {
			return { kind: 'in-process', env: gen.env, workerModule }
		}
		// No executor and no module is the legitimate shape of an assets-only worker —
		// binding to one is how a Worker serves a sibling static site internally.
		// Gate on the config, not on the missing module: a *scripted* worker can also
		// be momentarily module-less (the Vite main adapter imports lazily, on first
		// use), and falling through to assets there would silently serve index.html
		// instead of running the script.
		if (!hasScript(manager.config)) {
			const assets = gen.registry.staticAssets
			if (assets) {
				return { kind: 'assets', env: gen.env, assets }
			}
			throw new Error(`Worker "${workerName}" has no script and no static assets to serve`)
		}
		throw new Error(`Worker "${workerName}" generation has neither a thread executor nor a workerModule`)
	}

	/**
	 * The namespace that worker `scriptName` hosts for `className`, for a `durable_objects`
	 * binding with `script_name`. Waits for the worker's first load. Resolved per call, so a
	 * reloaded host is picked up.
	 */
	async resolveDurableObjectNamespace(scriptName: string, className: string): Promise<DurableObjectNamespaceImpl> {
		const manager = this.managers.get(scriptName)
		if (!manager) {
			throw new Error(
				`Durable Object class "${className}" is bound with script_name "${scriptName}", but lopata runs no worker named "${scriptName}" `
					+ `(workers: ${[...this.managers.keys()].join(', ')})`,
			)
		}
		await manager.whenLoaded()
		const gen = manager.active
		if (!gen) {
			throw new Error(`Worker "${scriptName}" has no active generation (failed to load?), so its Durable Object class "${className}" is unavailable`)
		}
		const entry = gen.registry.durableObjects.find(d => d.className === className)
		if (!entry) {
			throw new Error(
				`Worker "${scriptName}" hosts no Durable Object namespace for class "${className}". `
					+ `Declare a durable_objects binding for "${className}" (without script_name) in that worker's wrangler config.`,
			)
		}
		return entry.namespace
	}

	/** List all registered managers (for dashboard) */
	listManagers(): Map<string, GenerationManager> {
		return this.managers
	}
}

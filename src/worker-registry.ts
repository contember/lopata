import type { GenerationManager } from './generation-manager'
import type { WorkerThreadExecutor } from './worker-thread/executor'

export interface ResolvedTarget {
	workerModule: Record<string, unknown>
	env: Record<string, unknown>
	/** Set when the target worker runs in a Bun Worker thread; service-binding fetches RPC through it. */
	threadExecutor: WorkerThreadExecutor | null
}

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
		// `workerModule` is only consumed by the in-process fallback in
		// `ServiceBinding.fetch` (used by the vite-plugin main worker which
		// exposes a different adapter shape with its own workerModule).
		// Thread-mode Generations don't carry one — fall back to `{}`.
		const workerModule = (gen as unknown as { workerModule?: Record<string, unknown> }).workerModule ?? {}
		return { workerModule, env: gen.env, threadExecutor: gen.threadExecutor }
	}

	/** List all registered managers (for dashboard) */
	listManagers(): Map<string, GenerationManager> {
		return this.managers
	}
}

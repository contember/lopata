import path from 'node:path'
import type { DOExecutorFactory } from './bindings/do-executor'
import type { WranglerConfig } from './config'
import { buildEnv, wireServiceBindings } from './env'
import { Generation, type GenerationInfo } from './generation'
import type { WorkerRegistry } from './worker-registry'
import { type WorkerReadyInfo, WorkerThreadExecutor } from './worker-thread/executor'

export class GenerationManager {
	private generations = new Map<number, Generation>()
	private nextGenId = 1
	private _activeGenId: number | null = null
	private _reloading: Promise<Generation> | null = null
	private _pendingReload = false
	/** DO namespaces shared across generations to preserve WebSocket connections on reload */
	private _doNamespaces = new Map<string, import('./bindings/durable-object').DurableObjectNamespaceImpl>()

	gracePeriodMs = 10_000

	readonly config: WranglerConfig
	readonly baseDir: string
	readonly workerPath: string
	readonly workerName: string | undefined
	readonly workerRegistry: WorkerRegistry | undefined
	readonly isMain: boolean
	readonly cronEnabled: boolean
	readonly executorFactory: DOExecutorFactory | undefined
	readonly browserConfig: { wsEndpoint?: string; executablePath?: string; headless?: boolean } | undefined
	/** @internal Path to the wrangler config file (DO worker threads re-load it). */
	_configPath: string = ''

	constructor(
		config: WranglerConfig,
		baseDir: string,
		options?: {
			workerName?: string
			workerRegistry?: WorkerRegistry
			isMain?: boolean
			cron?: boolean
			executorFactory?: DOExecutorFactory
			configPath?: string
			browserConfig?: { wsEndpoint?: string; executablePath?: string; headless?: boolean }
		},
	) {
		this.config = config
		this.baseDir = baseDir
		this.workerPath = path.resolve(baseDir, config.main)
		this.workerName = options?.workerName
		this.workerRegistry = options?.workerRegistry
		this.isMain = options?.isMain ?? true
		this.cronEnabled = options?.cron ?? false
		this.executorFactory = options?.executorFactory
		this.browserConfig = options?.browserConfig
		this._configPath = options?.configPath ?? ''
	}

	/** The currently active generation (receives new requests) */
	get active(): Generation | null {
		if (this._activeGenId === null) return null
		return this.generations.get(this._activeGenId) ?? null
	}

	/**
	 * Create a new generation by importing the worker module fresh.
	 * Serialized: if called while already reloading, queues one reload.
	 */
	async reload(): Promise<Generation> {
		if (this._reloading) {
			this._pendingReload = true
			// Wait for current reload, then re-trigger
			await this._reloading
			if (this._pendingReload) {
				this._pendingReload = false
				return this.reload()
			}
			return this.active!
		}

		this._reloading = this._doReload()
		try {
			const gen = await this._reloading
			return gen
		} finally {
			this._reloading = null
			if (this._pendingReload) {
				this._pendingReload = false
				this.reload()
			}
		}
	}

	private async _doReload(): Promise<Generation> {
		this.executorFactory?.configure?.(this.workerPath, this._configPath)

		// Stateful bindings (DO namespaces, queue producers, workflows,
		// service bindings, email, browser, containers) live in main — the worker
		// RPCs into them. Stateless ones duplicate in the thread. Static assets
		// stay main-side for the auto-serve fallback.
		const { env, registry } = buildEnv(this.config, this.baseDir, this.executorFactory, this.browserConfig, this._doNamespaces)
		for (const entry of registry.durableObjects) {
			this._doNamespaces.set(entry.className, entry.namespace)
			entry.namespace._setExternalClass(entry.className, env, this.nextGenId)
		}
		wireServiceBindings(registry, {}, env, this.workerRegistry)

		const executor = new WorkerThreadExecutor({
			modulePath: this.workerPath,
			config: this.config,
			baseDir: this.baseDir,
			workerName: this.workerName,
			browserConfig: this.browserConfig,
			mainEnv: env,
		})
		let readyInfo: WorkerReadyInfo
		try {
			readyInfo = await executor.ready()
		} catch (err) {
			executor.dispose()
			throw err
		}
		// Forward `alarm()` introspection from the user-worker to each namespace
		// so the dashboard's "trigger alarm" UI shows up in thread mode. (Main
		// itself can't introspect — the user module is only loaded inside the
		// worker.)
		for (const entry of registry.durableObjects) {
			const hasAlarm = readyInfo.doAlarmHandlers[entry.className] ?? false
			entry.namespace._setAlarmHandlerHint(hasAlarm)
		}

		const genId = this.nextGenId++
		const gen = new Generation(genId, env, registry, this.config, executor, this.workerName, this.cronEnabled)
		this.generations.set(genId, gen)

		const oldGenId = this._activeGenId
		if (oldGenId !== null) {
			const oldGen = this.generations.get(oldGenId)
			if (oldGen && oldGen.state === 'active') {
				oldGen.drain()
				this._scheduleDrainAndStop(oldGenId, oldGen)
			}
		}

		this._activeGenId = genId
		gen.startConsumers()
		return gen
	}

	private _scheduleDrainAndStop(genId: number, gen: Generation): void {
		if (gen.isIdle()) {
			this._stopGeneration(genId)
			return
		}
		void Promise.race([
			waitUntilIdle(gen),
			sleep(this.gracePeriodMs),
		]).then(() => this._stopGeneration(genId))
	}

	private _stopGeneration(genId: number): void {
		const gen = this.generations.get(genId)
		if (!gen || gen.state === 'stopped') return
		gen.stop(new Set(this._doNamespaces.values()))
		// Clean up reference (keep for dashboard listing briefly)
		// Remove after another grace period to let dashboard show it
		setTimeout(() => {
			this.generations.delete(genId)
		}, 60_000)
	}

	/** Force-drain a specific generation */
	drain(genId: number): void {
		const gen = this.generations.get(genId)
		if (!gen) return
		gen.drain()
	}

	/** Force-stop a specific generation */
	stop(genId: number): void {
		this._stopGeneration(genId)
	}

	/** Update the grace period for future reloads */
	setGracePeriod(ms: number): void {
		this.gracePeriodMs = ms
	}

	/** Get a specific generation by ID */
	get(genId: number): Generation | null {
		return this.generations.get(genId) ?? null
	}

	/** List all generations for dashboard */
	list(): GenerationInfo[] {
		return Array.from(this.generations.values()).map(g => g.getInfo())
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitUntilIdle(gen: Generation, pollMs = 200): Promise<void> {
	while (gen.state !== 'stopped' && !gen.isIdle()) {
		await sleep(pollMs)
	}
}

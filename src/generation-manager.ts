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
	/** Coalesced follow-up: one reload queued to run after the in-flight one, with
	 *  its real promise handed to every caller that arrived during the in-flight
	 *  reload (so they observe the result/error of the reload reflecting their
	 *  request, not a stale `this.active`). */
	private _pendingReloadPromise: Promise<Generation> | null = null
	/** DO namespaces shared across generations to preserve WebSocket connections on reload */
	private _doNamespaces = new Map<string, import('./bindings/durable-object').DurableObjectNamespaceImpl>()
	/** Per-cron last-fired-minute dedup, shared across generations so a reload
	 *  mid-minute doesn't re-run a scheduled handler the previous generation already
	 *  fired (keyed by cron expression). */
	private _cronLastFired = new Map<string, number>()
	/** Generation ids whose interrupted workflows have already been resumed, so a
	 *  generation isn't resumed twice (which would re-execute the same instances). */
	private _resumedGenIds = new Set<number>()

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
	readonly baseUrls: { artifacts?: string } | undefined
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
			baseUrls?: { artifacts?: string }
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
		this.baseUrls = options?.baseUrls
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
		// A reload is already running. Queue exactly one follow-up that starts once
		// it finishes, and hand every caller that arrives during the in-flight reload
		// that same promise — so they all resolve/reject with the result of the
		// reload that actually reflects their edit, instead of the previous
		// generation (or a null `this.active` when every reload so far has failed).
		if (this._reloading) {
			this._pendingReloadPromise ??= this._reloading
				.catch(() => {})
				.then(() => this.reload())
			return this._pendingReloadPromise
		}

		this._reloading = this._doReload()
		try {
			return await this._reloading
		} finally {
			this._reloading = null
			this._pendingReloadPromise = null
		}
	}

	private async _doReload(): Promise<Generation> {
		this.executorFactory?.configure?.(this.workerPath, this._configPath, this.config)

		// Stateful bindings (DO namespaces, queue producers, workflows,
		// service bindings, email, browser, containers) live in main — the worker
		// RPCs into them. Stateless ones duplicate in the thread. Static assets
		// stay main-side for the auto-serve fallback.
		const { env, registry } = buildEnv(this.config, this.baseDir, this.executorFactory, this.browserConfig, this._doNamespaces, this.baseUrls)
		wireServiceBindings(registry, {}, env, this.workerRegistry)

		const executor = new WorkerThreadExecutor({
			modulePath: this.workerPath,
			config: this.config,
			baseDir: this.baseDir,
			workerName: this.workerName,
			browserConfig: this.browserConfig,
			artifactsBaseUrl: this.baseUrls?.artifacts,
			mainEnv: env,
		})
		let readyInfo: WorkerReadyInfo
		try {
			readyInfo = await executor.ready()
		} catch (err) {
			executor.dispose()
			throw err
		}

		// Rewire the shared DO namespaces to this generation only after the new
		// worker has loaded successfully. `_setExternalClass` disposes the
		// previous generation's live DO executors (active WebSockets included)
		// and repoints the namespace at the new env — doing it before `ready()`
		// would tear down working Durable Objects on a *failed* reload (e.g. a
		// syntax error mid-edit) and leave the still-serving old generation
		// returning 500s for every DO request. Forwarding the `alarm()`
		// introspection hint here (rather than in a later pass) keeps the
		// dashboard's "trigger alarm" UI working in thread mode — main can't
		// introspect because the user module is only loaded inside the worker.
		for (const entry of registry.durableObjects) {
			this._doNamespaces.set(entry.className, entry.namespace)
			entry.namespace._setExternalClass(entry.className, env, this.nextGenId)
			entry.namespace._setAlarmHandlerHint(readyInfo.doAlarmHandlers[entry.className] ?? false)
		}

		// Prune namespaces for DO classes removed from config: a stale entry would
		// otherwise keep firing persisted alarms (spawning DO threads for a class
		// that no longer exists) and keep its 30s eviction interval alive until the
		// process exits. Force-destroy tears those down (the class is gone, so there
		// are no WS connections worth preserving).
		const liveClassNames = new Set(registry.durableObjects.map(e => e.className))
		for (const [className, namespace] of this._doNamespaces) {
			if (!liveClassNames.has(className)) {
				namespace.destroy({ force: true })
				this._doNamespaces.delete(className)
			}
		}

		// Route dashboard workflow control through the worker thread. The main-side
		// binding built by `buildEnv` is hollow (no `_class`, empty in-memory event
		// waiters / sleep resolvers / abort controllers) — the live state machine
		// runs in the worker. This is the workflow analog of `_setExternalClass`,
		// installed here rather than via the (skipped) `wireClassRefs`.
		for (const entry of registry.workflows) {
			entry.binding._setThreadRouter((op) => executor.executeWorkflowControl(entry.bindingName, op))
		}

		const genId = this.nextGenId++
		const gen = new Generation(genId, env, registry, this.config, executor, this.workerName, this.cronEnabled)
		this.generations.set(genId, gen)

		const oldGenId = this._activeGenId
		if (oldGenId !== null) {
			const oldGen = this.generations.get(oldGenId)
			if (oldGen && oldGen.state === 'active') {
				// Skip clearing alarm timers for namespaces shared with this new
				// generation — it just restored them via `_restoreAlarms()`, so
				// clearing here would silently drop pending alarms across the reload.
				oldGen.drain(new Set(this._doNamespaces.values()))
				this._scheduleDrainAndStop(oldGenId, oldGen)
			}
		}

		this._activeGenId = genId
		gen.startConsumers(this._cronLastFired)
		// First load: no previous worker could be running these, so resume any
		// interrupted instances now. On a reload, resume is deferred until the old
		// generation's worker is disposed (see _scheduleDrainAndStop) so a workflow
		// never runs in two threads at once.
		if (oldGenId === null) this._resumeWorkflows(gen)
		return gen
	}

	/**
	 * Resume interrupted (running/waiting) workflow instances on `gen`'s worker,
	 * routed through the live worker-side binding. Guarded so a generation is
	 * resumed at most once even when several older generations stop in sequence —
	 * a second resume would re-execute the same instances (the bug this avoids).
	 */
	private _resumeWorkflows(gen: Generation): void {
		if (gen.registry.workflows.length === 0) return
		if (this._resumedGenIds.has(gen.id)) return
		this._resumedGenIds.add(gen.id)
		for (const entry of gen.registry.workflows) {
			entry.binding.executeControl({ kind: 'resumeInterrupted' }).catch(err => {
				console.error(`[lopata] workflow resume failed (${entry.bindingName}):`, err)
			})
		}
	}

	private _scheduleDrainAndStop(genId: number, gen: Generation): void {
		const finish = () => {
			this._stopGeneration(genId)
			// Resume only once EVERY older generation's worker is gone, not just
			// the one whose grace window elapsed here. Rapid reloads leave several
			// older generations in overlapping grace windows; one of them may
			// still be mid-execution of the very instances `resumeInterrupted`
			// selects (their DB rows stay 'running' until the step settles), and
			// resuming then would run one workflow in two threads at once.
			const active = this.active
			if (!active) return
			for (const [id, g] of this.generations) {
				if (id < active.id && g.state !== 'stopped') return
			}
			this._resumeWorkflows(active)
		}
		if (gen.isIdle()) {
			finish()
			return
		}
		void Promise.race([
			waitUntilIdle(gen),
			sleep(this.gracePeriodMs),
		]).then(finish)
	}

	private _stopGeneration(genId: number): void {
		const gen = this.generations.get(genId)
		if (!gen || gen.state === 'stopped') return
		gen.stop(new Set(this._doNamespaces.values()))
		// Clean up reference (keep for dashboard listing briefly)
		// Remove after another grace period to let dashboard show it
		setTimeout(() => {
			this.generations.delete(genId)
			this._resumedGenIds.delete(genId)
		}, 60_000)
	}

	/** Force-drain a specific generation */
	drain(genId: number): void {
		const gen = this.generations.get(genId)
		if (!gen) return
		gen.drain(new Set(this._doNamespaces.values()))
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

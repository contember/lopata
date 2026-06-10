import { randomUUIDv7, type Server } from 'bun'
import type { DurableObjectNamespaceImpl } from './bindings/durable-object'
import { startCronTimer } from './bindings/scheduled'
import { CFWebSocket, type ResponseWithWebSocket } from './bindings/websocket-pair'
import type { SqliteWorkflowBinding } from './bindings/workflow'
import type { WranglerConfig } from './config'
import { getDatabase } from './db'
import { renderErrorPage, stitchAsyncStack } from './error-page-render'
import { persistError, setSpanAttribute, startSpan } from './tracing/span'
import type { WorkerThreadExecutor } from './worker-thread/executor'

export interface ClassRegistry {
	durableObjects: { bindingName: string; className: string; namespace: DurableObjectNamespaceImpl }[]
	workflows: { bindingName: string; className: string; binding: SqliteWorkflowBinding }[]
	containers: { className: string; image: string; maxInstances?: number; namespace: DurableObjectNamespaceImpl }[]
	queueConsumers: {
		queue: string
		maxBatchSize: number
		maxBatchTimeout: number
		maxRetries: number
		deadLetterQueue: string | null
		maxConcurrency: number | null
		retryDelay: number | null
	}[]
	serviceBindings: { bindingName: string; serviceName: string; entrypoint?: string; proxy: Record<string, unknown> }[]
	staticAssets: { fetch(req: Request): Promise<Response> } | null
}

export type GenerationState = 'active' | 'draining' | 'stopped'

export interface GenerationInfo {
	id: number
	state: GenerationState
	createdAt: number
	activeRequests: number
	workerName?: string
	durableObjects?: { namespace: string; activeInstances: number; totalWebSockets: number }[]
}

export class Generation {
	readonly id: number
	state: GenerationState = 'active'
	readonly createdAt: number
	readonly env: Record<string, unknown>
	readonly registry: ClassRegistry
	readonly config: WranglerConfig
	readonly workerName: string | undefined
	readonly cronEnabled: boolean
	readonly threadExecutor: WorkerThreadExecutor
	activeRequests = 0

	private cronTimer: NodeJS.Timer | ReturnType<typeof setInterval> | null = null

	constructor(
		id: number,
		env: Record<string, unknown>,
		registry: ClassRegistry,
		config: WranglerConfig,
		threadExecutor: WorkerThreadExecutor,
		workerName?: string,
		cronEnabled?: boolean,
	) {
		this.id = id
		this.createdAt = Date.now()
		this.env = env
		this.registry = registry
		this.config = config
		this.workerName = workerName
		this.cronEnabled = cronEnabled ?? false
		this.threadExecutor = threadExecutor
	}

	/** Dispatch a fetch request through the worker thread. */
	async callFetch(request: Request, server: Server<unknown>): Promise<Response | undefined> {
		this.activeRequests++
		try {
			const url = new URL(request.url)
			if (isInfrastructurePath(url.pathname)) {
				return this._dispatchFetch(request, server, url)
			}
			return startSpan({
				name: `${request.method} ${url.pathname}`,
				kind: 'server',
				attributes: { 'http.method': request.method, 'http.url': request.url, 'lopata.generation_id': this.id },
				workerName: this.workerName,
			}, async () => {
				const response = await this._dispatchFetch(request, server, url)
				if (response) setSpanAttribute('http.status_code', response.status)
				return response
			})
		} finally {
			this.activeRequests--
		}
	}

	private async _dispatchFetch(request: Request, server: Server<unknown>, url: URL): Promise<Response | undefined> {
		const callerStack = new Error('')
		try {
			const assets = this.registry.staticAssets
			let response: Response
			if (!assets || this.config.assets?.binding) {
				response = await this.threadExecutor.executeFetch(request)
			} else {
				const workerFirst = shouldRunWorkerFirst(this.config.assets?.run_worker_first, url.pathname)
				if (!workerFirst) {
					const assetResponse = await assets.fetch(request)
					if (assetResponse.status !== 404) return assetResponse
					response = await this.threadExecutor.executeFetch(request)
				} else {
					response = await this.threadExecutor.executeFetch(request)
					if (response.status === 404) {
						// Drop the worker's streaming body so the source pump on the
						// other side stops — we're discarding this response in favour
						// of the assets fallback.
						response.body?.cancel().catch(() => {})
						return assets.fetch(request)
					}
				}
			}
			const ws = (response as ResponseWithWebSocket).webSocket
			if (response.status === 101 && ws instanceof CFWebSocket) {
				const upgraded = server.upgrade(request, { data: { cfSocket: ws } })
				if (!upgraded) {
					// Upgrade failed: the host bridge socket was already registered (and
					// the guest peer accepted) by executeFetch, but nobody will accept()
					// or close() it now. Close it so the guest peer is torn down and the
					// bridge entry forgotten instead of leaking until disposeAll.
					ws.close(1011, 'upgrade failed')
					return new Response('WebSocket upgrade failed', { status: 500 })
				}
				return undefined
			}
			return response
		} catch (err) {
			if (err instanceof Error) stitchAsyncStack(err, callerStack)
			console.error(`[lopata] Request error:\n${err instanceof Error ? err.stack : String(err)}`)
			return renderErrorPage(err, request, this.env, this.config, this.workerName)
		}
	}

	/** Handle manual /cdn-cgi/handler/scheduled trigger */
	async callScheduled(cronExpr: string): Promise<Response> {
		return startSpan({
			name: 'scheduled',
			kind: 'server',
			attributes: { cron: cronExpr, 'lopata.generation_id': this.id },
			workerName: this.workerName,
		}, async () => {
			try {
				const result = await this.threadExecutor.executeScheduled(cronExpr, Date.now())
				if (!result.ok) return new Response('No scheduled handler defined', { status: 404 })
				return new Response(`Scheduled handler executed (cron: ${cronExpr})`, { status: 200 })
			} catch (err) {
				this._persistAndRethrow('scheduled', err)
			}
		})
	}

	/** Handle incoming email — dispatches to the worker's email() handler */
	async callEmail(rawBytes: Uint8Array, from: string, to: string): Promise<Response> {
		return startSpan({
			name: 'email',
			kind: 'server',
			attributes: { 'email.from': from, 'email.to': to, 'lopata.generation_id': this.id },
			workerName: this.workerName,
		}, async () => {
			// Persist incoming email so `setReject` / `forward` can find it. Main
			// inserts here; the worker thread reads it from the shared SQLite.
			const db = getDatabase()
			const messageId = randomUUIDv7()
			db.run(
				"INSERT INTO email_messages (id, binding, from_addr, to_addr, raw, raw_size, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'received', ?)",
				[messageId, '_incoming', from, to, rawBytes, rawBytes.byteLength, Date.now()],
			)
			try {
				const result = await this.threadExecutor.executeEmail(messageId, from, to, rawBytes)
				if (!result.ok) return new Response('No email handler defined', { status: 404 })
				return new Response(`Email handled (from: ${from}, to: ${to})`, { status: 200 })
			} catch (err) {
				this._persistAndRethrow('email', err)
			}
		})
	}

	/** Start cron timer. Queue consumers run in the worker thread; no main-side action needed.
	 *  `cronLastFired` is the manager-owned per-minute dedup state, shared across
	 *  generations so a reload mid-minute doesn't re-fire a cron already handled. */
	startConsumers(cronLastFired?: Map<string, number>): void {
		if (!this.cronEnabled) return
		const crons = this.config.triggers?.crons ?? []
		if (crons.length === 0) return
		const executor = this.threadExecutor
		this.cronTimer = startCronTimer(crons, (cronExpr, now) => executor.executeScheduled(cronExpr, now.getTime()), this.workerName, cronLastFired)
	}

	private _persistAndRethrow(source: 'scheduled' | 'email' | 'queue', err: unknown): never {
		console.error(`[lopata] ${source} handler error:`, err)
		persistError(err, source, this.workerName)
		throw err
	}

	stopConsumers(): void {
		if (this.cronTimer) {
			clearInterval(this.cronTimer)
			this.cronTimer = null
		}
	}

	/** Transition to draining — stops consumers + alarm timers, keeps in-flight requests alive. */
	drain(sharedNamespaces?: Set<DurableObjectNamespaceImpl>): void {
		if (this.state === 'stopped') return
		this.state = 'draining'
		this.stopConsumers()
		// Stop firing this generation's alarms — but skip namespaces shared with
		// the next generation, which has already restored their timers via
		// `_restoreAlarms()`. Clearing a shared namespace here would wipe those
		// freshly-scheduled timers, so a pending alarm would silently never fire
		// across a reload (until the next reload or a `setAlarm` write).
		for (const entry of this.registry.durableObjects) {
			if (sharedNamespaces?.has(entry.namespace)) continue
			entry.namespace.clearAlarmTimers()
		}
	}

	/** Force-stop: drain + destroy all DO namespaces + abort workflows + terminate the worker. */
	stop(sharedNamespaces?: Set<DurableObjectNamespaceImpl>): void {
		if (this.state === 'stopped') return
		this.drain(sharedNamespaces)
		this.state = 'stopped'
		for (const entry of this.registry.durableObjects) {
			// Skip destroy for namespaces shared with the next generation
			if (!sharedNamespaces?.has(entry.namespace)) {
				entry.namespace.destroy()
			}
		}
		// Workflows run inside this generation's worker thread; `dispose()` below
		// terminates it, which stops them. (The old `entry.binding.abortRunning()`
		// was a no-op anyway — main's binding is hollow, the live abort controllers
		// live in the worker.) Their DB rows stay 'running' and the next generation
		// resumes them once this worker is gone — see GenerationManager's
		// resumeInterrupted control op.
		this.threadExecutor.dispose()
	}

	isIdle(): boolean {
		if (this.activeRequests > 0) return false
		if (this.threadExecutor.pendingWaitUntil() > 0) return false
		// In-flight scheduled/email handlers and inbound service-binding RPCs are
		// not counted by `activeRequests` (callScheduled/callEmail don't touch it),
		// but drain must still let them finish — a cron handler firing just before
		// reload would otherwise be force-terminated mid-execution.
		if (this.threadExecutor.pendingHandlerWork() > 0) return false
		// Cross-worker service-binding fetches (`env.OTHER.fetch()`) reach this
		// generation's executor directly, also bypassing `activeRequests`. Count
		// them so reloading the target doesn't sever an inbound fetch mid-flight.
		if (this.threadExecutor.pendingFetch() > 0) return false
		// Streamed bodies outlive the `executeFetch` promise (which resolves at the
		// headers). An active download / SSE / upload must keep the generation alive
		// or reload would abort it mid-stream with zero grace.
		if (this.threadExecutor.openStreamCount() > 0) return false
		// DO WebSockets are intentionally NOT consulted: DO namespaces are shared by
		// identity across generations and `_setExternalClass` disposes the previous
		// generation's executors at swap, so this generation's `registry.durableObjects`
		// only ever observes the NEXT generation's sockets. A browser reconnecting its
		// DO WS to the new generation during the drain window would pin the old one
		// non-idle for the entire grace period (stacking zombie threads on rapid
		// saves). DO worker lifetime is owned by the namespace's eviction logic, not
		// the generation.
		return true
	}

	getInfo(): GenerationInfo {
		const durableObjects = this.registry.durableObjects.map(entry => {
			const executors = entry.namespace._listActiveExecutors()
			return {
				namespace: entry.className,
				activeInstances: executors.length,
				totalWebSockets: executors.reduce((sum, e) => sum + e.wsCount, 0),
			}
		})
		return {
			id: this.id,
			state: this.state,
			createdAt: this.createdAt,
			activeRequests: this.activeRequests,
			workerName: this.workerName,
			durableObjects,
		}
	}
}

/** Bun HMR + browser well-known probes that shouldn't get spans. */
function isInfrastructurePath(pathname: string): boolean {
	return pathname.startsWith('/_bun/') || pathname.startsWith('/.well-known/')
}

function shouldRunWorkerFirst(config: boolean | string[] | undefined, pathname: string): boolean {
	if (config === true) return true
	if (!config) return false
	return config.some(pattern => {
		if (pattern === pathname) return true
		if (pattern.endsWith('/*')) {
			const prefix = pattern.slice(0, -1)
			return pathname.startsWith(prefix) || pathname === pattern.slice(0, -2)
		}
		return false
	})
}

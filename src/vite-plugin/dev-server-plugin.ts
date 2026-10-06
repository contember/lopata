import { randomUUIDv7 } from 'bun'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, resolve } from 'node:path'
import type { ReadableStreamDefaultReader } from 'node:stream/web'
import type { Plugin, ViteDevServer } from 'vite'
import { createScheduledController } from '../bindings/scheduled.ts'
import { type CFWebSocket, copyWebSocketBytes } from '../bindings/websocket-pair.ts'
import { cache, WorkerDispatcher, WorkersCache } from '../bindings/worker-cache.ts'
import { legacyCompatibility, runWithCompatibility } from '../compatibility-context.ts'
import { resolveCompatibility } from '../compatibility.ts'
import { type EntrypointHandlerName, resolveEntrypointHandler } from '../entrypoint-handler.ts'
import { ExecutionContext as CacheContext, getActiveExecutionContext, runWithExecutionContext } from '../execution-context.ts'
import { FileWatcher } from '../file-watcher.ts'
import type { RoutableManager } from '../route-matcher.ts'
import { extractHostname, RouteDispatcher } from '../route-matcher.ts'
import { installCompatibilityCrypto } from '../setup-globals.ts'
import { createInvocationTrace, type InvocationTrace, type TraceCompletion } from '../tracing/invocation.ts'
import type { SpanOptions } from '../tracing/span.ts'
import { serializeResponseHeaders } from '../worker-thread/serialize.ts'

interface DevServerPluginOptions {
	configPath?: string
	envName: string
	hosts?: string[]
	auxiliaryWorkers?: { configPath: string; name?: string; hosts?: string[] }[]
}

/**
 * Main Vite dev server middleware plugin. Intercepts SSR requests and
 * dispatches them through the worker's fetch() handler with Lopata
 * bindings as the env object.
 *
 * Returns a callback from configureServer (post-middleware) so that
 * framework plugins (React Router, SolidStart, etc.) get first crack
 * at requests. Lopata acts as the fallback.
 *
 * Also sets up:
 * - Request-level tracing (startSpan around fetch)
 * - Dashboard routes (/__dashboard)
 * - WebSocket trace streaming (/__api/traces/ws)
 * - Error page rendering with trace context
 *
 * The plugin is externalized by Vite's config bundler (it's in node_modules
 * via link:), so dynamic imports here run through Bun's native loader.
 */
export function devServerPlugin(options: DevServerPluginOptions): Plugin {
	let compatibility = legacyCompatibility
	let server: ViteDevServer
	let config: any
	let env: Record<string, unknown>
	let registry: any
	let workerRegistry: any

	// Lazy-loaded runtime functions
	let wireClassRefs: Function
	let setGlobalEnv: Function
	let ExecutionContext: typeof CacheContext

	// Tracing functions (lazy-loaded)
	let startSpan: Function
	let setSpanAttribute: Function
	let persistError: Function
	let getActiveContext: Function
	let renderErrorPage: Function
	let handleDashboardRequest: Function
	let handleApiRequest: Function
	let getTraceStore: Function
	let handleS3ProxyRequest: typeof import('../s3/proxy.ts').handleS3ProxyRequest
	let matchS3Path: typeof import('../s3/proxy.ts').matchS3Path
	let ForwardableEmailMessage: typeof import('../bindings/email.ts').ForwardableEmailMessage
	let getDatabase: typeof import('../db.ts').getDatabase

	// Route dispatcher for multi-worker route-based dispatching
	let routeDispatcher: RouteDispatcher | undefined

	// Sentinel for "this worker has no fetch() at all" — distinct from any Response, so the
	// fall-through to Vite's own middleware can be decided after the span has closed.
	const NO_FETCH_HANDLER = Symbol('no-fetch-handler')

	// Track current module to detect when Vite HMR invalidates it
	let currentModule: Record<string, unknown> | null = null
	let workerDispatcher: WorkerDispatcher | undefined
	const workerDispatchers = new Set<WeakRef<WorkerDispatcher>>()
	const invocations = new Set<InvocationTrace>()
	// Serializes module reload — prevents concurrent wireClassRefs calls
	let reloadLock: Promise<void> | null = null
	// Generation counter — increments on each module reload for tracing
	let currentGenerationId = 0
	// Track generation records for dashboard visibility
	const viteGenerations = new Map<number, { id: number; createdAt: number; state: 'active' | 'stopped' }>()
	const genActiveRequests = new Map<number, number>()

	/**
	 * Import the worker module through Vite's SSR runner and re-wire
	 * class refs when the module identity changes (HMR invalidation).
	 * Serialized via reloadLock to prevent concurrent wireClassRefs calls.
	 */
	async function ensureWorkerModule(): Promise<Record<string, unknown>> {
		return runWithCompatibility(compatibility, loadWorkerModule)
	}

	async function loadWorkerModule(): Promise<Record<string, unknown>> {
		const ssrEnv = server.environments[options.envName]
		if (!ssrEnv || !('runner' in ssrEnv)) {
			throw new Error(`SSR environment "${options.envName}" not found or has no runner`)
		}

		const entrypoint = resolve(server.config.root, config.main)

		// Wait for any in-progress reload before importing
		if (reloadLock) await reloadLock

		const workerModule = await (ssrEnv as any).runner.import(entrypoint) as Record<string, unknown>

		// Re-wire class refs when module changes (HMR invalidation)
		if (workerModule !== currentModule) {
			if (reloadLock) {
				// Another request started reloading while we were importing — wait for it
				await reloadLock
			} else {
				let resolveReload!: () => void
				reloadLock = new Promise(r => {
					resolveReload = r
				})
				const previousModule = currentModule
				const previousGenId = currentGenerationId
				try {
					currentModule = workerModule
					// Track generation lifecycle
					if (viteGenerations.has(previousGenId)) {
						viteGenerations.get(previousGenId)!.state = 'stopped'
					}
					currentGenerationId++
					viteGenerations.set(currentGenerationId, { id: currentGenerationId, createdAt: Date.now(), state: 'active' })
					wireClassRefs(registry, workerModule, env, workerRegistry, currentGenerationId, compatibility)
					workerDispatcher = new WorkerDispatcher(
						workerModule,
						env,
						new WorkersCache(getDatabase(), config.name, crypto.randomUUID(), config),
						props => new CacheContext(props),
						compatibility,
					)
					for (const reference of workerDispatchers) {
						if (!reference.deref()) workerDispatchers.delete(reference)
					}
					workerDispatchers.add(new WeakRef(workerDispatcher))
					setGlobalEnv(env)
					console.log(`[lopata:vite] Worker module (re)loaded, classes wired (generation ${currentGenerationId})`)
					// Schedule cleanup of old generation after successful reload
					if (viteGenerations.has(previousGenId)) {
						setTimeout(() => viteGenerations.delete(previousGenId), 60_000)
					}
				} catch (err) {
					// Revert generation tracking
					viteGenerations.delete(currentGenerationId)
					currentGenerationId = previousGenId
					if (viteGenerations.has(previousGenId)) {
						viteGenerations.get(previousGenId)!.state = 'active'
					}
					if (previousModule) {
						// Serve old module while Vite module graph settles (e.g. DO class not yet re-exported)
						currentModule = previousModule
						console.warn('[lopata:vite] Module reload failed, serving previous version:', err instanceof Error ? err.message : err)
					} else {
						// First load — no fallback
						currentModule = null
						throw err
					}
				} finally {
					reloadLock = null
					resolveReload()
				}
			}
		}

		return currentModule ?? workerModule
	}

	/**
	 * Resolve a named handler off the worker's default export, honoring both entrypoint
	 * shapes. Shared with the CLI worker thread and the test harness — see
	 * src/entrypoint-handler.ts for why a class entrypoint has to be constructed first.
	 */
	function resolveWorkerHandler(
		activeModule: Record<string, unknown>,
		name: EntrypointHandlerName,
		ctx: unknown,
	): ((...args: unknown[]) => unknown) | null {
		return resolveEntrypointHandler(activeModule.default, name, ctx, env)
	}

	/**
	 * Dispatch a request through the worker's fetch() handler with tracing
	 * and generation tracking. Throws on HMR race conditions so the caller
	 * can retry.
	 */
	async function handleWorkerFetch(req: IncomingMessage, res: ServerResponse, next: Function): Promise<void> {
		await ensureWorkerModule()
		const genId = currentGenerationId
		const request = nodeReqToRequest(req)
		const invocation = createWorkerInvocation({
			name: `${request.method} ${new URL(request.url).pathname}`,
			kind: 'server',
			attributes: { 'http.method': request.method, 'http.url': request.url, 'lopata.generation_id': genId },
		})
		return runWithCompatibility(compatibility, () =>
			invocation.run(async () => {
				const callerStack = new Error()
				const ctx = new ExecutionContext()
				try {
					const response = await runWithExecutionContext(ctx, async () => {
						try {
							// Resolved in here rather than up front because a class entrypoint is
							// constructed at this point, and a throwing constructor deserves the same
							// error page and persisted error as a throwing fetch().
							if (!workerDispatcher) throw new Error('Worker dispatcher is not initialized')
							const resp = await workerDispatcher.fetch(request, 'default', undefined, false, ctx)
							invocation.root.setAttribute('http.status_code', resp.status)

							// Intercept React Router error boundary responses with lopata error page
							const routeError = (globalThis as any).__lopata_routeError
							delete (globalThis as any).__lopata_routeError
							if (routeError) {
								invocation.root.recordException(routeError)
								if (resp.body) ctx.waitUntil(resp.body.cancel(routeError))
								if (routeError instanceof Error) {
									stitchAsyncStack(routeError, callerStack)
								}
								console.error('[lopata:vite] Route error:\n' + (routeError instanceof Error ? routeError.stack : String(routeError)))
								return (renderErrorPage as Function)(routeError, request, env, config)
							}

							return resp
						} catch (err) {
							if (err instanceof Error && err.message === 'Entrypoint "default" does not export a fetch handler') return NO_FETCH_HANDLER
							if (isHmrRaceError(err)) {
								currentModule = null
								throw err
							}
							if (err instanceof Error) {
								stitchAsyncStack(err, callerStack)
							}
							console.error('[lopata:vite] Request error:\n' + (err instanceof Error ? err.stack : String(err)))
							invocation.root.recordException(err instanceof Error ? err : String(err))
							return (renderErrorPage as Function)(err, request, env, config)
						}
					}).finally(() => {
						const release = invocation.retain('wait-until')
						void ctx._awaitAll().finally(release)
					})
					if (response === NO_FETCH_HANDLER) {
						console.error('[lopata:vite] Worker module default export has no fetch() method')
						next()
						return
					}
					const writing = runWithExecutionContext(ctx, () => writeResponse(response, res, invocation))
					invocation.finishHandler(response.status >= 500 ? { kind: 'error', error: new Error(`HTTP ${response.status}`) } : undefined)
					await writing
				} catch (error) {
					invocation.finishHandler({ kind: 'error', error })
					throw error
				} finally {
					invocation.finishHandler()
				}
			}))
	}

	function createWorkerInvocation(options: SpanOptions): InvocationTrace {
		const invocation = createInvocationTrace(options)
		const genId = currentGenerationId
		invocations.add(invocation)
		genActiveRequests.set(genId, (genActiveRequests.get(genId) ?? 0) + 1)
		void invocation.completed.then(() => {
			invocations.delete(invocation)
			const count = genActiveRequests.get(genId) ?? 1
			if (count <= 1) genActiveRequests.delete(genId)
			else genActiveRequests.set(genId, count - 1)
		})
		return invocation
	}

	async function runWorkerEvent(options: SpanOptions, callback: (ctx: CacheContext) => Promise<Response>): Promise<Response> {
		const invocation = createWorkerInvocation(options)
		return runWithCompatibility(compatibility, () =>
			invocation.run(async () => {
				const ctx = new ExecutionContext()
				try {
					workerDispatcher?.attachContext(ctx)
					return await runWithExecutionContext(ctx, () => callback(ctx))
				} catch (error) {
					invocation.finishHandler({ kind: 'error', error })
					throw error
				} finally {
					const release = invocation.retain('wait-until')
					void ctx._awaitAll().finally(release)
					invocation.finishHandler()
				}
			}))
	}

	/**
	 * Dispatch a cron tick through the worker's scheduled() handler.
	 *
	 * The dashboard's manual trigger reaches this via `active.callScheduled()` on the
	 * generation adapter below. Under the CLI that adapter is a real `Generation`, which
	 * hands the cron to its worker thread; in Vite mode the worker lives in this process
	 * behind the SSR runner, so mirror `handleWorkerFetch` instead — same module, env,
	 * ExecutionContext and tracing, with a ScheduledController in place of a Request.
	 */
	async function handleWorkerScheduled(cronExpr: string): Promise<Response> {
		const activeModule = await ensureWorkerModule()
		const genId = currentGenerationId

		const controller = createScheduledController(cronExpr, Date.now())

		return await runWorkerEvent({
			name: 'scheduled',
			kind: 'server',
			attributes: { cron: cronExpr, 'lopata.generation_id': genId },
		}, async ctx => {
			// Resolved inside the span: constructing a class entrypoint runs user code,
			// which belongs in the trace and in persistError like the handler body itself.
			const handler = resolveWorkerHandler(activeModule, 'scheduled', ctx)
			if (!handler) {
				return new Response('No scheduled handler defined', { status: 404 })
			}
			try {
				await handler(controller, env, ctx)
				// waitUntil work outlives the trigger, as it does on a real cron tick — the
				// dev server stays up, so let it settle instead of blocking the response.
				return new Response(`Scheduled handler executed (cron: ${cronExpr})`, { status: 200 })
			} catch (err) {
				console.error('[lopata:vite] scheduled handler error:\n' + (err instanceof Error ? err.stack : String(err)))
				persistError(err, 'scheduled', config.name)
				throw err
			}
		})
	}

	/**
	 * Deliver a message through the worker's email() handler.
	 *
	 * Same story as `handleWorkerScheduled`: the dashboard reaches this via
	 * `active.callEmail()`. Mirrors `Generation.callEmail` — the row lands in
	 * `email_messages` before the handler runs, because `setReject()` / `forward()` on the
	 * message look themselves up there by id.
	 */
	async function handleWorkerEmail(rawBytes: Uint8Array, from: string, to: string): Promise<Response> {
		const activeModule = await ensureWorkerModule()
		const genId = currentGenerationId

		return await runWorkerEvent({
			name: 'email',
			kind: 'server',
			attributes: { 'email.from': from, 'email.to': to, 'lopata.generation_id': genId },
		}, async ctx => {
			// Persist before dispatch, as Generation.callEmail does: a message the worker
			// has no handler for still belongs in the dashboard's list, and setReject() /
			// forward() resolve themselves from this row by id.
			const db = getDatabase()
			const messageId = randomUUIDv7()
			db.run(
				"INSERT INTO email_messages (id, binding, from_addr, to_addr, raw, raw_size, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'received', ?)",
				[messageId, '_incoming', from, to, rawBytes, rawBytes.byteLength, Date.now()],
			)
			const handler = resolveWorkerHandler(activeModule, 'email', ctx)
			if (!handler) {
				return new Response('No email handler defined', { status: 404 })
			}
			try {
				await handler(new ForwardableEmailMessage(db, messageId, from, to, rawBytes), env, ctx)
				return new Response(`Email handled (from: ${from}, to: ${to})`, { status: 200 })
			} catch (err) {
				console.error('[lopata:vite] email handler error:\n' + (err instanceof Error ? err.stack : String(err)))
				persistError(err, 'email', config.name)
				throw err
			}
		})
	}

	/**
	 * Resolve a `?worker=` param on the /cdn-cgi trigger routes.
	 *
	 * Mirrors `resolveWorkerParam` in src/cli/dev.ts: an unknown name — including every
	 * name in a single-worker setup, where there is no auxiliary registry at all — warns
	 * and falls back to the main worker rather than failing the request.
	 */
	function resolveTriggerTarget(params: URLSearchParams): { gen: any } | { inactive: string } | null {
		const name = params.get('worker')
		if (!name || name === config.name) return null
		const manager = workerRegistry?.getManager(name)
		if (!manager) {
			console.warn(`[lopata:vite] Unknown worker "${name}" in ?worker= param, using main worker`)
			return null
		}
		const gen = manager.active
		return gen ? { gen } : { inactive: name }
	}

	/**
	 * Resolve an auxiliary worker for the given request.
	 * Returns null if the request should be handled by the main worker.
	 */
	function resolveAuxWorker(req: IncomingMessage, url: string): { manager: RoutableManager; workerName: string } | null {
		if (!routeDispatcher) return null
		const parsedUrl = new URL(url, 'http://localhost')
		const hostname = extractHostname(req.headers.host ?? '')
		const targetManager = routeDispatcher.resolve(parsedUrl.pathname, hostname)
		if (!routeDispatcher.isFallback(targetManager)) {
			return { manager: targetManager, workerName: (targetManager as any).config?.name ?? 'aux' }
		}
		return null
	}

	return {
		name: 'lopata:dev-server',

		transform(code, id) {
			if (!config) return
			if (this.environment?.name !== options.envName) return
			const entrypoint = resolve(server.config.root, config.main)
			if (id !== entrypoint) return
			return code + '\nif (import.meta.hot) { import.meta.hot.accept() }\n'
		},

		async configureServer(viteServer: ViteDevServer) {
			server = viteServer
			server.httpServer?.once('close', () => {
				for (const invocation of invocations) invocation.terminate('Vite server closed')
				for (const reference of workerDispatchers) reference.deref()?.terminateInvocations('Vite server closed')
			})
			const projectRoot = server.config.root

			// Deeper stacks in dev mode
			Error.stackTraceLimit = 50

			// Prevent unhandled rejections from worker code from crashing the dev server
			process.on('unhandledRejection', (reason) => {
				console.error('[lopata] Unhandled promise rejection:', reason)
			})

			// Lazy import runtime modules — runs through Bun's native loader
			const configMod = await import('../config.ts')
			const envMod = await import('../env.ts')
			const ecMod = await import('../execution-context.ts')
			const spanMod = await import('../tracing/span.ts')
			const ctxMod = await import('../tracing/context.ts')
			const errorPageMod = await import('../error-page-render.ts')
			const dashboardMod = await import('../dashboard-serve.ts')
			const apiMod = await import('../api/index.ts')
			const traceMod = await import('../tracing/store.ts')
			const s3Mod = await import('../s3/proxy.ts')
			const emailMod = await import('../bindings/email.ts')
			const dbMod = await import('../db.ts')

			wireClassRefs = envMod.wireClassRefs
			setGlobalEnv = envMod.setGlobalEnv
			ExecutionContext = ecMod.ExecutionContext
			startSpan = spanMod.startSpan
			setSpanAttribute = spanMod.setSpanAttribute
			persistError = spanMod.persistError
			getActiveContext = ctxMod.getActiveContext
			renderErrorPage = errorPageMod.renderErrorPage
			handleDashboardRequest = dashboardMod.handleDashboardRequest
			handleApiRequest = apiMod.handleApiRequest
			getTraceStore = traceMod.getTraceStore
			handleS3ProxyRequest = s3Mod.handleS3ProxyRequest
			matchS3Path = s3Mod.matchS3Path
			ForwardableEmailMessage = emailMod.ForwardableEmailMessage
			getDatabase = dbMod.getDatabase
			globalThis.__lopata_workerCacheApi = cache
			globalThis.__lopata_tracing = spanMod.tracing
			globalThis.__lopata_waitUntil = promise => {
				const ctx = getActiveExecutionContext()
				if (!ctx) throw new Error('waitUntil() requires an active Worker execution context')
				ctx.waitUntil(promise)
			}

			// 1. Load wrangler config
			const loadedConfig = options.configPath
				? await configMod.loadConfig(resolve(projectRoot, options.configPath))
				: await configMod.autoLoadConfig(projectRoot)
			config = loadedConfig
			compatibility = resolveCompatibility({ date: loadedConfig.compatibility_date, flags: loadedConfig.compatibility_flags })
			installCompatibilityCrypto()
			console.log(`[lopata:vite] Loaded config: ${config.name}`)

			// The Vite plugin drives a worker built by Vite, so the main worker must have
			// an entry module. `loadConfig` accepts an assets-only config (valid on its own
			// via the CLI), but here there would be nothing for the SSR runner to import —
			// fail with the reason instead of an `ERR_INVALID_ARG_TYPE` from `resolve()`.
			if (!configMod.hasScript(config)) {
				throw new Error(
					`[lopata:vite] "${config.name}" has no "main" — an assets-only worker has no module for Vite to build. `
						+ `Serve it with the lopata CLI (or as an auxiliary worker in lopata.config.ts) instead.`,
				)
			}

			// 2. Build env with bindings
			const built = envMod.buildEnv(config, projectRoot)
			env = built.env
			registry = built.registry
			server.httpServer?.once('close', () => {
				for (const entry of built.registry.workflows) entry.binding.terminateTracing('Vite server closed')
			})

			// Set globalEnv immediately so that top-level module code
			// (e.g. `import { env } from "cloudflare:workers"`) sees bindings
			// before the first request triggers worker module import.
			// Also set globalThis.__lopata_env — the modules-plugin env proxy
			// reads from this, bridging the Vite SSR runner ↔ native module graphs.
			setGlobalEnv(env)
			;(globalThis as any).__lopata_env = env
			;(globalThis as any).__lopata_startSpan = startSpan
			;(globalThis as any).__lopata_setSpanStatus = spanMod.setSpanStatus

			// Propagate string vars/secrets to process.env so libraries
			// that read process.env (e.g. better-auth, Sentry) see them.
			for (const [key, value] of Object.entries(env)) {
				if (typeof value === 'string') {
					process.env[key] = value
				}
			}

			// 3. Set up API context
			apiMod.setDashboardConfig(config)

			// 3b. Create generation tracking adapter for dashboard
			const mainAdapter: import('../route-matcher.ts').RoutableManager & Record<string, unknown> = {
				config,
				gracePeriodMs: 0,
				// The Vite generation exists as soon as env and the registry are built; the
				// worker module itself is imported lazily, on first use. Gating this on
				// `currentModule` would report "No active generation" until something loaded
				// the app — precisely the state the dashboard's Trigger buttons are for — so
				// expose the generation right away and let `workerModule` stay null until the
				// import lands. `handleWorkerScheduled` awaits `ensureWorkerModule()` itself.
				get active() {
					return {
						get workerModule() {
							return currentModule
						},
						env,
						registry,
						callFetch(_request: Request, _server: unknown) {
							throw new Error('Main worker in Vite mode should be dispatched via handleWorkerFetch, not callFetch')
						},
						callScheduled(cronExpr: string) {
							return handleWorkerScheduled(cronExpr)
						},
						callEmail(rawBytes: Uint8Array, from: string, to: string) {
							return handleWorkerEmail(rawBytes, from, to)
						},
					}
				},
				list() {
					return Array.from(viteGenerations.values()).map(g => ({
						id: g.id,
						state: g.state,
						createdAt: g.createdAt,
						activeRequests: genActiveRequests.get(g.id) ?? 0,
						workerName: config.name,
						durableObjects: g.state === 'active'
							? registry.durableObjects.map((entry: any) => {
								const executors = entry.namespace._listActiveExecutors()
								return {
									namespace: entry.className,
									activeInstances: executors.length,
									totalWebSockets: executors.reduce((sum: number, e: any) => sum + e.wsCount, 0),
								}
							})
							: undefined,
					}))
				},
				get(id: number) {
					const record = viteGenerations.get(id)
					if (!record) return null
					return {
						getInfo() {
							return {
								id: record.id,
								state: record.state,
								createdAt: record.createdAt,
								activeRequests: genActiveRequests.get(record.id) ?? 0,
								workerName: config.name,
							}
						},
						registry,
					}
				},
				reload() {
					return Promise.reject(new Error('Main worker uses Vite HMR — save a file to trigger reload'))
				},
				stop(id: number) {
					const record = viteGenerations.get(id)
					if (record) {
						record.state = 'stopped'
						setTimeout(() => viteGenerations.delete(id), 60_000)
					}
				},
				setGracePeriod() {},
			}
			apiMod.setGenerationManager(mainAdapter as any) // Dashboard adapter, not RoutableManager

			// 4. Set up auxiliary workers (if configured)
			if (options.auxiliaryWorkers && options.auxiliaryWorkers.length > 0) {
				await import('../plugin.ts')

				const { WorkerRegistry } = await import('../worker-registry.ts')
				const { GenerationManager } = await import('../generation-manager.ts')

				workerRegistry = new WorkerRegistry()
				workerRegistry.register(config.name, mainAdapter as any, true) // Dashboard adapter

				const auxConfigs = new Map<string, { config: any; name: string }>()
				for (const workerDef of options.auxiliaryWorkers) {
					const auxConfigPath = resolve(projectRoot, workerDef.configPath)
					const auxBaseDir = dirname(auxConfigPath)
					const auxConfig = await configMod.loadConfig(auxConfigPath)
					const workerName = workerDef.name ?? auxConfig.name
					auxConfigs.set(workerDef.configPath, { config: auxConfig, name: workerName })
					console.log(`[lopata:vite] Auxiliary worker: ${workerName}`)

					// Aux workers run in their own Bun Worker thread (GenerationManager's
					// universal model) loaded via native Bun import — NOT through Vite's
					// SSR/transform pipeline like the main worker. See `auxiliaryWorkers`
					// in index.ts: author them as plain Bun-resolvable modules.
					const auxManager = new GenerationManager(auxConfig, auxBaseDir, {
						workerName,
						workerRegistry,
						isMain: false,
					})
					workerRegistry.register(workerName, auxManager)

					try {
						const gen = await auxManager.reload()
						console.log(`[lopata:vite] Auxiliary worker "${workerName}" loaded (gen ${gen.id})`)
					} catch (err) {
						console.error(`[lopata:vite] Failed to load auxiliary worker "${workerName}":`, err)
					}

					// File watcher for aux worker reload. An assets-only aux worker has no
					// module to watch — its files are read from disk per request.
					if (!configMod.hasScript(auxConfig)) {
						console.log(`[lopata:vite] Auxiliary worker "${workerName}" is assets-only — no watcher`)
						continue
					}
					const auxSrcDir = dirname(resolve(auxBaseDir, auxConfig.main))
					const auxWatcher = new FileWatcher(auxSrcDir, () => {
						auxManager.reload().then(async gen => {
							console.log(`[lopata:vite] Auxiliary worker "${workerName}" reloaded → generation ${gen.id}`)
							// Re-read config and update routes in case routes changed
							if (routeDispatcher) {
								try {
									const freshConfig = await configMod.loadConfig(auxConfigPath)
									routeDispatcher.addRoutes(freshConfig, auxManager, workerName, workerDef.hosts)
								} catch (err) {
									console.warn(`[lopata:vite] Failed to re-read config for "${workerName}" routes:`, err)
								}
							}
						}).catch(err => {
							console.error(`[lopata:vite] Reload failed for "${workerName}":`, err)
						})
					})
					auxWatcher.start()
					console.log(`[lopata:vite] Watching ${auxSrcDir} for changes (${workerName})`)
				}

				apiMod.setWorkerRegistry(workerRegistry)

				// Warn if main worker has routes — they are ignored because main is the fallback
				if (config.routes && config.routes.length > 0) {
					console.warn(
						'[lopata:vite] Warning: main worker has "routes" in config — these are ignored (main worker is the fallback for unmatched requests)',
					)
				}

				// Build route dispatcher (aux workers only — main is the fallback)
				routeDispatcher = new RouteDispatcher(mainAdapter)

				// Register main worker host patterns so they take priority over wildcard aux hosts
				if (options.hosts?.length) {
					routeDispatcher.addHostWorker(mainAdapter, config.name, options.hosts)
				}

				for (const workerDef of options.auxiliaryWorkers) {
					const cached = auxConfigs.get(workerDef.configPath)
					if (!cached) continue
					const auxMgr = workerRegistry.getManager(cached.name)
					if (!auxMgr) continue
					routeDispatcher.addRoutes(cached.config, auxMgr, cached.name, workerDef.hosts)
					// Workers with hosts but no wrangler routes still need a catch-all entry
					if (workerDef.hosts && (!cached.config.routes || cached.config.routes.length === 0)) {
						routeDispatcher.addHostWorker(auxMgr, cached.name, workerDef.hosts)
					}
				}
				if (routeDispatcher.hasRoutes()) {
					for (const r of routeDispatcher.getRegisteredRoutes()) {
						const hostInfo = r.hostPatterns ? ` (hosts: ${r.hostPatterns.join(', ')})` : ''
						console.log(`[lopata:vite] Route: ${r.pattern} → ${r.workerName}${hostInfo}`)
					}
				}
				apiMod.setRouteDispatcher(routeDispatcher)

				// Expose host routes to the dashboard API
				const hostRoutes: Array<{ pattern: string; workerName: string }> = []
				if (options.hosts?.length) {
					for (const host of options.hosts) {
						hostRoutes.push({ pattern: host, workerName: config.name })
					}
				}
				for (const workerDef of options.auxiliaryWorkers) {
					if (!workerDef.hosts) continue
					const cached = auxConfigs.get(workerDef.configPath)
					if (!cached) continue
					for (const host of workerDef.hosts) {
						hostRoutes.push({ pattern: host, workerName: cached.name })
					}
				}
				if (hostRoutes.length > 0) {
					apiMod.setHostRoutes(hostRoutes)
				}
			}

			// 5. Set up WebSocket trace streaming on httpServer
			setupTraceWebSocket(server)

			// 6. Return middleware callback (post-middleware — runs after framework plugins)
			return () => {
				server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: Function) => {
					const url = req.url
					if (!url) return next()

					// Skip Vite internal paths
					if (url.startsWith('/@') || url.startsWith('/__vite') || url.startsWith('/node_modules/')) {
						return next()
					}

					// API routes (RPC, R2 upload/download)
					if (url.startsWith('/__api')) {
						// WebSocket upgrades are handled separately via httpServer upgrade event
						if (url.startsWith('/__api/traces/ws')) return next()
						try {
							const request = nodeReqToRequest(req)
							const response = await (handleApiRequest as (r: Request) => Response | Promise<Response>)(request)
							await writeResponse(response, res)
						} catch (err) {
							console.error('[lopata:vite] API error:', err)
							if (!res.headersSent) {
								res.writeHead(500, { 'content-type': 'text/plain' })
								res.end(String(err))
							}
						}
						return
					}

					// Dashboard routes (HTML, assets)
					if (url.startsWith('/__dashboard')) {
						try {
							const request = nodeReqToRequest(req)
							const response = await (handleDashboardRequest as (r: Request) => Response | Promise<Response>)(request)
							await writeResponse(response, res)
						} catch (err) {
							console.error('[lopata:vite] Dashboard error:', err)
							if (!res.headersSent) {
								res.writeHead(500, { 'content-type': 'text/plain' })
								res.end(String(err))
							}
						}
						return
					}

					// Manual cron trigger: GET /cdn-cgi/handler/scheduled?cron=<expression>&worker=<name>
					// Same URL shape `bunx lopata dev` exposes (see src/cli/dev.ts), so scripted
					// triggers work identically under Vite.
					if ((url.split('?')[0] ?? url) === '/cdn-cgi/handler/scheduled') {
						try {
							const params = new URL(url, 'http://localhost').searchParams
							const cronExpr = params.get('cron') ?? '* * * * *'
							const target = resolveTriggerTarget(params)
							if (target && 'inactive' in target) {
								res.writeHead(503, { 'content-type': 'text/plain' })
								res.end(`Worker "${target.inactive}" has no active generation`)
								return
							}
							const response = target ? await target.gen.callScheduled(cronExpr) : await handleWorkerScheduled(cronExpr)
							await writeResponse(response, res)
						} catch (err) {
							console.error('[lopata:vite] Scheduled trigger error:', err)
							if (!res.headersSent) {
								res.writeHead(500, { 'content-type': 'text/plain' })
								res.end(String(err))
							}
						}
						return
					}

					// Manual email delivery: POST /cdn-cgi/handler/email?from=…&to=…&worker=<name>
					if ((url.split('?')[0] ?? url) === '/cdn-cgi/handler/email' && req.method === 'POST') {
						try {
							const params = new URL(url, 'http://localhost').searchParams
							const from = params.get('from') ?? ''
							const to = params.get('to') ?? ''
							const raw = new Uint8Array(await nodeReqToRequest(req).arrayBuffer())
							const target = resolveTriggerTarget(params)
							if (target && 'inactive' in target) {
								res.writeHead(503, { 'content-type': 'text/plain' })
								res.end(`Worker "${target.inactive}" has no active generation`)
								return
							}
							const response = target ? await target.gen.callEmail(raw, from, to) : await handleWorkerEmail(raw, from, to)
							await writeResponse(response, res)
						} catch (err) {
							console.error('[lopata:vite] Email trigger error:', err)
							if (!res.headersSent) {
								res.writeHead(500, { 'content-type': 'text/plain' })
								res.end(String(err))
							}
						}
						return
					}

					// S3-compatible proxy: /__s3/{bucket}/{key...} → R2 binding on the main worker env.
					// Routes straight through to lopata's S3 handler without going through the
					// worker's fetch(), so sandbox uploaders etc. can hit R2 bindings directly
					// with the same URL shape that `bunx lopata dev` exposes.
					{
						const pathOnly = url.split('?')[0] ?? url
						const s3Match = matchS3Path(pathOnly)
						if (s3Match) {
							try {
								const response = await handleS3ProxyRequest(nodeReqToRequest(req), s3Match, env)
								await writeResponse(response, res)
							} catch (err) {
								console.error('[lopata:vite] S3 proxy error:', err)
								if (!res.headersSent) {
									res.writeHead(500, { 'content-type': 'text/plain' })
									res.end(String(err))
								}
							}
							return
						}
					}

					// Aux worker dispatch: host-based first, then route-based
					{
						const resolved = resolveAuxWorker(req, url)
						if (resolved) {
							const gen = resolved.manager.active
							if (!gen) {
								if (!res.headersSent) {
									res.writeHead(503, { 'content-type': 'text/plain' })
									res.end('No active generation')
								}
								return
							}
							try {
								const request = nodeReqToRequest(req)
								const parsedUrl = new URL(request.url)
								const response = await (startSpan as Function)({
									name: `${request.method} ${parsedUrl.pathname}`,
									kind: 'server',
									attributes: { 'http.method': request.method, 'http.url': request.url, 'lopata.worker': resolved.workerName },
								}, async () => {
									const resp = await gen.callFetch(request, null) as Response
									;(setSpanAttribute as Function)('http.status_code', resp.status)
									return resp
								}) as Response
								await writeResponse(response, res)
							} catch (err) {
								writeRequestError(res, err)
							}
							return
						}
					}

					try {
						await handleWorkerFetch(req, res, next)
					} catch (err) {
						if (!isHmrRaceError(err)) {
							writeRequestError(res, err)
							return
						}
						// Retry once after a short delay — module graph may be mid-evaluation during HMR
						await new Promise((resolve) => setTimeout(resolve, 200))
						try {
							await handleWorkerFetch(req, res, next)
						} catch (retryErr) {
							writeRequestError(res, retryErr)
						}
					}
				})
			}
		},
	}

	function setupTraceWebSocket(server: ViteDevServer) {
		const httpServer = (server as any).httpServer
		if (!httpServer) return

		// Dynamically import ws (available as Vite dependency)
		import('ws').then(({ WebSocketServer }) => {
			const traceWss = new WebSocketServer({ noServer: true })
			const workerWss = new WebSocketServer({ noServer: true })

			httpServer.on('upgrade', (req: IncomingMessage, socket: any, head: Buffer) => {
				const url = req.url ?? ''

				// Skip Vite HMR WebSocket — Vite uses sec-websocket-protocol
				// "vite-hmr" / "vite-ping" to identify its connections
				const wsProtocol = req.headers['sec-websocket-protocol']
				if (wsProtocol === 'vite-hmr' || wsProtocol === 'vite-ping') return

				if (url.startsWith('/__api/traces/ws')) {
					traceWss.handleUpgrade(req, socket, head, (ws: any) => {
						handleTraceWebSocket(ws, req)
					})
					return
				}

				// Worker WebSocket upgrade — bridge to CF WebSocketPair
				if (req.headers.upgrade?.toLowerCase() === 'websocket') {
					handleWorkerWebSocketUpgrade(workerWss, req, socket, head)
				}
			})

			console.log('[lopata:vite] Dashboard: http://localhost:5173/__dashboard')
		}).catch(() => {
			// ws not available — trace streaming disabled
			console.log('[lopata:vite] Dashboard available (trace streaming disabled — ws package not found)')
		})
	}

	function handleTraceWebSocket(ws: any, req: IncomingMessage) {
		const store = getTraceStore()
		let filter: { path?: string; status?: string; attributeFilters?: Array<{ key: string; value: string; type: 'include' | 'exclude' }> } = {}
		let buffer: any[] = []
		const MAX_BUFFER = 1000
		const allowedTraces = new Set<string>()
		const excludedTraces = new Set<string>()

		function isRootSpanFiltered(span: { name: string; status: string; parentSpanId: string | null; attributes: Record<string, unknown> }): boolean {
			if (filter.status && filter.status !== 'all') {
				if (span.status !== 'unset' && span.status !== filter.status) return true
			}
			if (filter.path) {
				if (!matchGlob(span.name, filter.path)) return true
			}
			if (filter.attributeFilters && filter.attributeFilters.length > 0) {
				const attrs = span.attributes
				for (const af of filter.attributeFilters) {
					const val = attrs[af.key]
					const matches = val !== undefined && String(val).toLowerCase().includes(af.value.toLowerCase())
					if (af.type === 'include' && !matches) return true
					if (af.type === 'exclude' && matches) return true
				}
			}
			return false
		}

		const unsubscribe = store.subscribe((event: any) => {
			const traceId = event.type === 'span.event' ? event.event.traceId : event.span.traceId
			if ((event.type === 'span.start' || event.type === 'span.end') && event.span.parentSpanId === null) {
				if (isRootSpanFiltered(event.span)) {
					excludedTraces.add(traceId)
					allowedTraces.delete(traceId)
					return
				}
				excludedTraces.delete(traceId)
				allowedTraces.add(traceId)
			} else {
				if (excludedTraces.has(traceId)) return
			}
			if (buffer.length < MAX_BUFFER) {
				buffer.push(event)
			}
		})

		const interval = setInterval(() => {
			if (buffer.length > 0) {
				ws.send(JSON.stringify({ type: 'batch', events: buffer }))
				buffer = []
			}
		}, 500)

		// Parse filter from query params
		try {
			const reqUrl = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`)
			const statusParam = reqUrl.searchParams.get('status')
			const pathParam = reqUrl.searchParams.get('path')
			if (statusParam) filter.status = statusParam
			if (pathParam) filter.path = pathParam
		} catch {}

		let sinceMs = 15 * 60 * 1000
		const since = Date.now() - sinceMs
		const recent = store.getRecentTraces(since, 200, filter)
		ws.send(JSON.stringify({ type: 'initial', traces: recent }))

		ws.on('message', (data: any) => {
			try {
				const msg = JSON.parse(typeof data === 'string' ? data : data.toString())
				if (msg.type === 'filter') {
					filter = { path: msg.path, status: msg.status, attributeFilters: msg.attributeFilters }
					if (msg.sinceMs !== undefined) sinceMs = msg.sinceMs
					allowedTraces.clear()
					excludedTraces.clear()
					const freshSince = sinceMs > 0 ? Date.now() - sinceMs : 0
					const freshTraces = store.getRecentTraces(freshSince, 200, filter)
					ws.send(JSON.stringify({ type: 'initial', traces: freshTraces }))
				}
			} catch {}
		})

		ws.on('close', () => {
			unsubscribe()
			clearInterval(interval)
		})
	}

	async function handleWorkerWebSocketUpgrade(wss: any, req: IncomingMessage, socket: any, head: Buffer) {
		try {
			const { CFWebSocket } = await import('../bindings/websocket-pair.ts')

			const request = nodeReqToRequest(req)
			const parsedUrl = new URL(request.url)

			// Aux worker dispatch for WebSocket: host-based first, then route-based
			const resolved = resolveAuxWorker(req, req.url ?? '/')
			if (resolved) {
				const gen = resolved.manager.active
				if (!gen) {
					socket.destroy()
					return
				}
				const response = await (startSpan as Function)({
					name: `WS ${parsedUrl.pathname}`,
					kind: 'server',
					attributes: {
						'http.method': 'GET',
						'http.url': request.url,
						'lopata.worker': resolved.workerName,
						'lopata.websocket': true,
					},
				}, async () => {
					return gen.callFetch(request, null) as Promise<Response & { webSocket?: InstanceType<typeof CFWebSocket> }>
				}) as Response & { webSocket?: InstanceType<typeof CFWebSocket> }
				const cfSocket = response.webSocket
				if (response.status !== 101 || !cfSocket || !(cfSocket instanceof CFWebSocket)) {
					socket.destroy()
					return
				}
				wss.handleUpgrade(req, socket, head, (ws: any) => {
					bridgeCfWebSocket(cfSocket, ws)
				})
				return
			}

			await ensureWorkerModule()
			const response = await runWorkerEvent({
				name: `WS ${parsedUrl.pathname}`,
				kind: 'server',
				attributes: { 'http.url': request.url, 'lopata.websocket': true, 'lopata.generation_id': currentGenerationId },
			}, async ctx => {
				if (!workerDispatcher) throw new Error('Worker dispatcher is not initialized')
				return workerDispatcher.fetch(request, 'default', undefined, false, ctx)
			})

			const cfSocket = (response as Response & { webSocket?: InstanceType<typeof CFWebSocket> }).webSocket
			if (response.status !== 101 || !cfSocket || !(cfSocket instanceof CFWebSocket)) {
				socket.destroy()
				return
			}

			// Complete the upgrade and bridge
			wss.handleUpgrade(req, socket, head, (ws: any) => {
				bridgeCfWebSocket(cfSocket, ws)
			})
		} catch (err) {
			console.error('[lopata:vite] Worker WebSocket upgrade failed:', err)
			socket.destroy()
		}
	}
}

/** Detect transient TypeError from Vite module graph being mid-evaluation during HMR */
function isHmrRaceError(err: unknown): boolean {
	return err instanceof TypeError && err.message.includes('not be null or undefined')
}

function writeRequestError(res: ServerResponse, err: unknown): void {
	console.error('[lopata:vite] Request error:', err)
	if (!res.headersSent) {
		res.writeHead(500, { 'content-type': 'text/plain' })
		res.end(err instanceof Error ? err.stack ?? err.message : String(err))
	}
}

function stitchAsyncStack(err: Error, callerError: Error | null): void {
	if (!callerError) return
	if (!err.stack || !callerError.stack) return
	if (err.stack.includes('--- async ---')) return

	const errFrames = err.stack.split('\n').filter(l => l.trim().startsWith('at '))
	const looksShort = errFrames.length <= 5 || err.stack.includes('processTicksAndRejections')
	if (!looksShort) return

	const callerLines = callerError.stack.split('\n').slice(1)
	const filtered = callerLines.filter(l => !l.includes('/lopata/src/'))
	if (filtered.length === 0) return

	err.stack += '\n    --- async ---\n' + filtered.join('\n')
}

/** Bridge a CFWebSocket (from worker response) to a real ws WebSocket. */
function bridgeCfWebSocket(cfSocket: CFWebSocket, ws: any): void {
	cfSocket._useRawBinaryDelivery()
	// CF → real WS
	cfSocket.addEventListener('message', (ev: Event) => {
		const msgData = (ev as MessageEvent).data
		try {
			ws.send(msgData)
		} catch {}
	})
	cfSocket.addEventListener('close', (ev: Event) => {
		const ce = ev as CloseEvent
		try {
			ws.close(ce.code, ce.reason)
		} catch {}
	})
	// Accept the client side so events from server.send() are dispatched
	cfSocket.accept()

	// Real WS → CF
	ws.on('message', (data: Buffer, isBinary: boolean) => {
		const msgData = isBinary
			? copyWebSocketBytes(data)
			: data.toString('utf-8')
		const evt = { type: 'message' as const, data: msgData }
		if (cfSocket._peer?._accepted) {
			cfSocket._peer._dispatchWSEvent(evt)
		} else if (cfSocket._peer) {
			cfSocket._peer._eventQueue.push(evt)
		}
	})

	ws.on('close', (code: number, reason: Buffer) => {
		if (cfSocket._peer && cfSocket._peer.readyState !== 3) {
			const evt = { type: 'close' as const, code: code ?? 1000, reason: reason?.toString('utf-8') ?? '', wasClean: true }
			if (cfSocket._peer._accepted) {
				cfSocket._peer._dispatchWSEvent(evt)
			} else {
				cfSocket._peer._eventQueue.push(evt)
			}
			cfSocket._peer.readyState = 3
		}
		cfSocket.readyState = 3
	})
}

function matchGlob(text: string, pattern: string): boolean {
	const regex = pattern
		.replace(/\*\*/g, '\0')
		.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		.replace(/\0/g, '.*')
		.replace(/\*/g, '[^/]*')
	return new RegExp(`^${regex}`).test(text)
}

function nodeReqToRequest(req: IncomingMessage): Request {
	const protocol = 'http'
	const host = req.headers.host ?? 'localhost'
	const url = `${protocol}://${host}${req.url}`

	const headers = new Headers()
	for (const [key, value] of Object.entries(req.headers)) {
		if (value === undefined) continue
		if (Array.isArray(value)) {
			for (const v of value) headers.append(key, v)
		} else {
			headers.set(key, value)
		}
	}

	const method = req.method ?? 'GET'
	const hasBody = method !== 'GET' && method !== 'HEAD'

	return new Request(url, {
		method,
		headers,
		body: hasBody ? nodeStreamToReadable(req) : undefined,
		duplex: hasBody ? 'half' : undefined,
	})
}

function nodeStreamToReadable(stream: IncomingMessage): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			stream.on('data', (chunk: Buffer) => {
				controller.enqueue(new Uint8Array(chunk))
			})
			stream.on('end', () => {
				controller.close()
			})
			stream.on('error', (err) => {
				controller.error(err)
			})
		},
	})
}

/**
 * Convert Response headers to a node writeHead record. `set-cookie` must go
 * through `getSetCookie()`: Headers iteration yields it once per cookie (and a
 * keyed record would keep only the last one), so a multi-cookie response —
 * e.g. better-auth's session_token + session_data — would silently lose
 * cookies. `serializeResponseHeaders` emits one pair per cookie; collecting
 * those into an array lets Node write each as its own header line. Exported
 * for tests.
 */
export function buildNodeHeaders(response: Response): Record<string, string | string[]> {
	const headerRecord: Record<string, string | string[]> = {}
	for (const [key, value] of serializeResponseHeaders(response)) {
		if (key.toLowerCase() === 'set-cookie') {
			const existing = headerRecord['set-cookie']
			headerRecord['set-cookie'] = Array.isArray(existing) ? [...existing, value] : [value]
		} else {
			headerRecord[key] = value
		}
	}
	return headerRecord
}

async function writeResponse(response: Response, res: ServerResponse, invocation?: InvocationTrace): Promise<void> {
	const release = invocation?.retain('response-body')
	const context = getActiveExecutionContext()
	const terminal = Promise.withResolvers<TraceCompletion>()
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
	let cancellation: Promise<void> | undefined
	const cancel = (reason: unknown): Promise<void> => {
		const callback = async () => {
			if (reader) await reader.cancel(reason)
			else await response.body?.cancel(reason)
		}
		const run = () => context ? runWithExecutionContext(context, callback) : callback()
		return invocation ? invocation.run(run) : run()
	}
	const onFinish = () => terminal.resolve({ kind: 'complete' })
	const onClose = () => {
		if (res.writableFinished) return
		cancellation ??= cancel('HTTP client disconnected')
		void cancellation.catch(() => {})
		terminal.resolve({ kind: 'cancelled', reason: 'HTTP client disconnected' })
	}
	res.once('finish', onFinish)
	res.once('close', onClose)
	try {
		if (res.writableFinished) onFinish()
		else if (res.destroyed) onClose()
		else {
			reader = response.body?.getReader()
			res.writeHead(response.status, buildNodeHeaders(response))
			while (reader && !res.destroyed) {
				const { done, value } = await reader.read()
				if (done || res.destroyed) break
				res.write(value)
			}
			if (!res.destroyed) res.end()
		}
		const result = await terminal.promise
		await cancellation
		release?.(result)
	} catch (error) {
		try {
			await (cancellation ?? cancel(error))
		} catch {}
		release?.({ kind: 'error', error })
		res.destroy()
	} finally {
		reader?.releaseLock()
		res.off('finish', onFinish)
		res.off('close', onClose)
	}
}

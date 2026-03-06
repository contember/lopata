import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, resolve } from 'node:path'
import type { Plugin, ViteDevServer } from 'vite'
import { FileWatcher } from '../file-watcher.ts'
import { RouteDispatcher } from '../route-matcher.ts'

interface DevServerPluginOptions {
	configPath?: string
	envName: string
	auxiliaryWorkers?: { configPath: string; name?: string }[]
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
	let server: ViteDevServer
	let config: any
	let env: Record<string, unknown>
	let registry: any
	let workerRegistry: any

	// Lazy-loaded runtime functions
	let wireClassRefs: Function
	let setGlobalEnv: Function
	let ExecutionContext: new() => any
	let runWithExecutionContext: <T>(ctx: any, fn: () => T) => T

	// Tracing functions (lazy-loaded)
	let startSpan: Function
	let setSpanAttribute: Function
	let getActiveContext: Function
	let renderErrorPage: Function
	let handleDashboardRequest: Function
	let handleApiRequest: Function
	let getTraceStore: Function

	// Route dispatcher for multi-worker route-based dispatching
	let routeDispatcher: RouteDispatcher | undefined

	// Track current module to detect when Vite HMR invalidates it
	let currentModule: Record<string, unknown> | null = null
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
					wireClassRefs(registry, workerModule, env, workerRegistry, currentGenerationId)
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
	 * Dispatch a request through the worker's fetch() handler with tracing
	 * and generation tracking. Throws on HMR race conditions so the caller
	 * can retry.
	 */
	async function handleWorkerFetch(req: IncomingMessage, res: ServerResponse, next: Function): Promise<void> {
		const activeModule = await ensureWorkerModule()
		const genId = currentGenerationId
		genActiveRequests.set(genId, (genActiveRequests.get(genId) ?? 0) + 1)

		try {
			const request = nodeReqToRequest(req)
			const parsedUrl = new URL(request.url)

			const handler = activeModule.default as Record<string, unknown>
			if (!handler || typeof handler.fetch !== 'function') {
				console.error('[lopata:vite] Worker module default export has no fetch() method')
				next()
				return
			}

			// Capture caller stack before entering the worker (for async stack stitching)
			const callerStack = new Error()

			const ctx = new ExecutionContext()
			const response = await (startSpan as Function)({
				name: `${request.method} ${parsedUrl.pathname}`,
				kind: 'server',
				attributes: { 'http.method': request.method, 'http.url': request.url, 'lopata.generation_id': genId },
			}, () =>
				runWithExecutionContext(ctx, async () => {
					try {
						const resp = await (handler.fetch as Function).call(handler, request, env, ctx) as Response
						;(setSpanAttribute as Function)('http.status_code', resp.status)

						// Intercept React Router error boundary responses with lopata error page
						const routeError = (globalThis as any).__lopata_routeError
						delete (globalThis as any).__lopata_routeError
						if (routeError) {
							if (routeError instanceof Error) {
								stitchAsyncStack(routeError, callerStack)
							}
							console.error('[lopata:vite] Route error:\n' + (routeError instanceof Error ? routeError.stack : String(routeError)))
							return (renderErrorPage as Function)(routeError, request, env, config)
						}

						ctx._awaitAll().catch(() => {})
						return resp
					} catch (err) {
						if (isHmrRaceError(err)) {
							currentModule = null
							throw err
						}
						if (err instanceof Error) {
							stitchAsyncStack(err, callerStack)
						}
						console.error('[lopata:vite] Request error:\n' + (err instanceof Error ? err.stack : String(err)))
						return (renderErrorPage as Function)(err, request, env, config)
					}
				})) as Response

			writeResponse(response, res)
		} finally {
			const count = genActiveRequests.get(genId) ?? 1
			if (count <= 1) genActiveRequests.delete(genId)
			else genActiveRequests.set(genId, count - 1)
		}
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
			const projectRoot = server.config.root

			// Deeper stacks in dev mode
			Error.stackTraceLimit = 50

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

			wireClassRefs = envMod.wireClassRefs
			setGlobalEnv = envMod.setGlobalEnv
			ExecutionContext = ecMod.ExecutionContext
			runWithExecutionContext = ecMod.runWithExecutionContext
			startSpan = spanMod.startSpan
			setSpanAttribute = spanMod.setSpanAttribute
			getActiveContext = ctxMod.getActiveContext
			renderErrorPage = errorPageMod.renderErrorPage
			handleDashboardRequest = dashboardMod.handleDashboardRequest
			handleApiRequest = apiMod.handleApiRequest
			getTraceStore = traceMod.getTraceStore

			// 1. Load wrangler config
			if (options.configPath) {
				config = await configMod.loadConfig(resolve(projectRoot, options.configPath))
			} else {
				config = await configMod.autoLoadConfig(projectRoot)
			}
			console.log(`[lopata:vite] Loaded config: ${config.name}`)

			// 2. Build env with bindings
			const built = envMod.buildEnv(config, projectRoot)
			env = built.env
			registry = built.registry

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
				get active() {
					return currentModule ? {
						workerModule: currentModule,
						env,
						registry,
						callFetch(_request: Request, _server: unknown) {
							throw new Error('Main worker in Vite mode should be dispatched via handleWorkerFetch, not callFetch')
						},
					} : null
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

					// File watcher for aux worker reload
					const auxSrcDir = dirname(resolve(auxBaseDir, auxConfig.main))
					const auxWatcher = new FileWatcher(auxSrcDir, () => {
						auxManager.reload().then(async gen => {
							console.log(`[lopata:vite] Auxiliary worker "${workerName}" reloaded → generation ${gen.id}`)
							// Re-read config and update routes in case routes changed
							if (routeDispatcher) {
								try {
									const freshConfig = await configMod.loadConfig(auxConfigPath)
									routeDispatcher.addRoutes(freshConfig, auxManager, workerName)
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
					console.warn('[lopata:vite] Warning: main worker has "routes" in config — these are ignored (main worker is the fallback for unmatched requests)')
				}

				// Build route dispatcher for aux workers with routes (main worker is the fallback)
				routeDispatcher = new RouteDispatcher(mainAdapter)
				for (const workerDef of options.auxiliaryWorkers) {
					const cached = auxConfigs.get(workerDef.configPath)
					if (!cached) continue
					const auxMgr = workerRegistry.getManager(cached.name)
					if (auxMgr) routeDispatcher.addRoutes(cached.config, auxMgr, cached.name)
				}
				if (routeDispatcher.hasRoutes()) {
					for (const r of routeDispatcher.getRegisteredRoutes()) {
						console.log(`[lopata:vite] Route: ${r.pattern} → ${r.workerName}`)
					}
				}
				apiMod.setRouteDispatcher(routeDispatcher)
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
							writeResponse(response, res)
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
							writeResponse(response, res)
						} catch (err) {
							console.error('[lopata:vite] Dashboard error:', err)
							if (!res.headersSent) {
								res.writeHead(500, { 'content-type': 'text/plain' })
								res.end(String(err))
							}
						}
						return
					}

					// Route-based dispatch: if an aux worker matches, use its GenerationManager directly
					if (routeDispatcher) {
						const parsedUrl = new URL(url, 'http://localhost')
						const targetManager = routeDispatcher.resolve(parsedUrl.pathname)
						// If the resolved manager is not the main adapter, dispatch via aux worker
						if (!routeDispatcher.isFallback(targetManager)) {
							const gen = targetManager.active
							if (!gen) {
								if (!res.headersSent) {
									res.writeHead(503, { 'content-type': 'text/plain' })
									res.end('No active generation for matched route')
								}
								return
							}
							try {
								const request = nodeReqToRequest(req)
								const response = await (startSpan as Function)({
									name: `${request.method} ${parsedUrl.pathname}`,
									kind: 'server',
									attributes: { 'http.method': request.method, 'http.url': request.url, 'lopata.worker': (targetManager as any).config?.name ?? 'aux' },
								}, async () => {
									const resp = await gen.callFetch(request, null) as Response
									;(setSpanAttribute as Function)('http.status_code', resp.status)
									return resp
								}) as Response
								writeResponse(response, res)
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

			// Route-based dispatch: if an aux worker matches, delegate the WebSocket upgrade to it
			if (routeDispatcher) {
				const targetManager = routeDispatcher.resolve(parsedUrl.pathname)
				if (!routeDispatcher.isFallback(targetManager)) {
					const gen = targetManager.active
					if (!gen) {
						socket.destroy()
						return
					}
					const response = await (startSpan as Function)({
						name: `WS ${parsedUrl.pathname}`,
						kind: 'server',
						attributes: { 'http.method': 'GET', 'http.url': request.url, 'lopata.worker': (targetManager as any).config?.name ?? 'aux', 'lopata.websocket': true },
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
			}

			const activeModule = await ensureWorkerModule()
			const handler = activeModule.default as Record<string, unknown>
			if (!handler || typeof handler.fetch !== 'function') {
				socket.destroy()
				return
			}

			const ctx = new ExecutionContext()
			const response = await runWithExecutionContext(ctx, async () => {
				return (handler.fetch as Function).call(handler, request, env, ctx) as Response
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
function bridgeCfWebSocket(cfSocket: any, ws: any): void {
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
			? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
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

async function writeResponse(response: Response, res: ServerResponse): Promise<void> {
	const headerRecord: Record<string, string | string[]> = {}
	response.headers.forEach((value, key) => {
		headerRecord[key] = value
	})
	res.writeHead(response.status, headerRecord)

	if (!response.body) {
		res.end()
		return
	}

	const reader = response.body.getReader()
	try {
		while (true) {
			const { done, value } = await reader.read()
			if (done) break
			res.write(value)
		}
	} finally {
		reader.releaseLock()
		res.end()
	}
}

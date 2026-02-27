import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, resolve } from 'node:path'
import type { Plugin, ViteDevServer } from 'vite'

interface DevServerPluginOptions {
	configPath?: string
	envName: string
	auxiliaryWorkers?: { configPath: string }[]
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

	// Track current module to detect when Vite HMR invalidates it
	let currentModule: Record<string, unknown> | null = null
	// Serializes module reload — prevents concurrent wireClassRefs calls
	let reloadLock: Promise<void> | null = null

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
				try {
					currentModule = workerModule
					wireClassRefs(registry, workerModule, env, workerRegistry)
					setGlobalEnv(env)
					console.log('[lopata:vite] Worker module (re)loaded, classes wired')
				} catch (err) {
					// Reset so next request retries
					currentModule = null
					throw err
				} finally {
					reloadLock = null
					resolveReload()
				}
			}
		}

		return currentModule ?? workerModule
	}

	return {
		name: 'lopata:dev-server',

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

			// 4. Set up auxiliary workers (if configured)
			if (options.auxiliaryWorkers && options.auxiliaryWorkers.length > 0) {
				await import('../plugin.ts')

				const { WorkerRegistry } = await import('../worker-registry.ts')
				const { GenerationManager } = await import('../generation-manager.ts')

				workerRegistry = new WorkerRegistry()

				const mainAdapter = {
					config,
					gracePeriodMs: 0,
					get active() {
						return currentModule ? { workerModule: currentModule, env, registry } : null
					},
					list() {
						return []
					},
				}
				workerRegistry.register(config.name, mainAdapter as any, true)

				for (const workerDef of options.auxiliaryWorkers) {
					const auxConfigPath = resolve(projectRoot, workerDef.configPath)
					const auxBaseDir = dirname(auxConfigPath)
					const auxConfig = await configMod.loadConfig(auxConfigPath)
					console.log(`[lopata:vite] Auxiliary worker: ${auxConfig.name}`)

					const auxManager = new GenerationManager(auxConfig, auxBaseDir, {
						workerName: auxConfig.name,
						workerRegistry,
						isMain: false,
					})
					workerRegistry.register(auxConfig.name, auxManager)

					try {
						const gen = await auxManager.reload()
						console.log(`[lopata:vite] Auxiliary worker "${auxConfig.name}" loaded (gen ${gen.id})`)
					} catch (err) {
						console.error(`[lopata:vite] Failed to load auxiliary worker "${auxConfig.name}":`, err)
					}
				}

				apiMod.setWorkerRegistry(workerRegistry)
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

					try {
						const activeModule = await ensureWorkerModule()

						const request = nodeReqToRequest(req)
						const parsedUrl = new URL(request.url)

						const handler = activeModule.default as Record<string, unknown>
						if (!handler || typeof handler.fetch !== 'function') {
							console.error('[lopata:vite] Worker module default export has no fetch() method')
							return next()
						}

						// Capture caller stack before entering the worker (for async stack stitching)
						const callerStack = new Error()

						const ctx = new ExecutionContext()
						const response = await (startSpan as Function)({
							name: `${request.method} ${parsedUrl.pathname}`,
							kind: 'server',
							attributes: { 'http.method': request.method, 'http.url': request.url },
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
									if (err instanceof Error) {
										stitchAsyncStack(err, callerStack)
									}
									console.error('[lopata:vite] Request error:\n' + (err instanceof Error ? err.stack : String(err)))
									return (renderErrorPage as Function)(err, request, env, config)
								}
							})) as Response

						writeResponse(response, res)
					} catch (err) {
						console.error('[lopata:vite] Request error:', err)
						if (!res.headersSent) {
							res.writeHead(500, { 'content-type': 'text/plain' })
							res.end(err instanceof Error ? err.stack ?? err.message : String(err))
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

			const activeModule = await ensureWorkerModule()
			const handler = activeModule.default as Record<string, unknown>
			if (!handler || typeof handler.fetch !== 'function') {
				socket.destroy()
				return
			}

			const request = nodeReqToRequest(req)
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

				// Real WS → CF
				ws.on('message', (data: any) => {
					if (cfSocket._peer?._accepted) {
						cfSocket._peer._dispatchWSEvent({ type: 'message', data: typeof data === 'string' ? data : data.buffer })
					} else if (cfSocket._peer) {
						cfSocket._peer._eventQueue.push({ type: 'message', data: typeof data === 'string' ? data : data.buffer })
					}
				})

				ws.on('close', (code: number, reason: string) => {
					if (cfSocket._peer && cfSocket._peer.readyState !== 3) {
						const evt = { type: 'close' as const, code: code ?? 1000, reason: reason ?? '', wasClean: true }
						if (cfSocket._peer._accepted) {
							cfSocket._peer._dispatchWSEvent(evt)
						} else {
							cfSocket._peer._eventQueue.push(evt)
						}
						cfSocket._peer.readyState = 3
					}
					cfSocket.readyState = 3
				})
			})
		} catch (err) {
			console.error('[lopata:vite] Worker WebSocket upgrade failed:', err)
			socket.destroy()
		}
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

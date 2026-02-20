// Capture deeper stacks in dev mode (default is 10, async boundaries still truncate)
Error.stackTraceLimit = 50

import '../plugin'
import path from 'node:path'
import { handleApiRequest, setDashboardConfig, setGenerationManager, setWorkerRegistry } from '../api'
import { QueuePullConsumer } from '../bindings/queue'
import type { AckRequest, PullRequest } from '../bindings/queue'
import { CFWebSocket } from '../bindings/websocket-pair'
import { autoLoadConfig, loadConfig } from '../config'
import { handleDashboardRequest } from '../dashboard/api'
import { getDatabase } from '../db'
import { FileWatcher } from '../file-watcher'
import { GenerationManager } from '../generation-manager'
import { loadLopataConfig } from '../lopata-config'
import { addCfProperty } from '../request-cf'
import { getTraceStore } from '../tracing/store'
import type { TraceEvent } from '../tracing/types'
import { WorkerRegistry } from '../worker-registry'
import type { CliContext } from './context'
import { parseFlag } from './context'

export async function run(ctx: CliContext) {
	const envFlag = parseFlag(ctx.args, '--env') ?? parseFlag(ctx.args, '-e')
	const listenFlag = parseFlag(ctx.args, '--listen')
	const portFlag = parseFlag(ctx.args, '--port')

	const baseDir = process.cwd()
	const watchers: FileWatcher[] = []

	// Try to load lopata.config.ts for multi-worker mode
	const lopataConfig = await loadLopataConfig(baseDir)

	let manager: GenerationManager

	if (lopataConfig) {
		// ─── Multi-worker mode ─────────────────────────────────────────
		console.log('[lopata] Multi-worker mode (lopata.config.ts found)')

		// Create executor factory based on isolation mode
		let executorFactory: import('../bindings/do-executor').DOExecutorFactory | undefined
		if (lopataConfig.isolation === 'isolated') {
			const { WorkerExecutorFactory } = await import('../bindings/do-executor-worker')
			executorFactory = new WorkerExecutorFactory()
			console.log('[lopata] DO isolation: isolated (Worker threads)')
		} else if (lopataConfig.isolation && lopataConfig.isolation !== 'dev') {
			console.warn(`[lopata] Unknown isolation mode "${lopataConfig.isolation}", using "dev"`)
		}

		const registry = new WorkerRegistry()

		// Load main worker config
		const mainConfig = await loadConfig(lopataConfig.main, envFlag)
		const mainBaseDir = path.dirname(lopataConfig.main)
		console.log(`[lopata] Main worker: ${mainConfig.name}${envFlag ? ` (env: ${envFlag})` : ''}`)
		setDashboardConfig(mainConfig)

		const mainManager = new GenerationManager(mainConfig, mainBaseDir, {
			workerName: mainConfig.name,
			workerRegistry: registry,
			isMain: true,
			cron: lopataConfig.cron,
			executorFactory,
			configPath: lopataConfig.main,
			browserConfig: lopataConfig.browser,
		})
		registry.register(mainConfig.name, mainManager, true)

		// Load auxiliary workers
		for (const workerDef of lopataConfig.workers ?? []) {
			const auxConfig = await loadConfig(workerDef.config, envFlag)
			const auxBaseDir = path.dirname(workerDef.config)
			console.log(`[lopata] Auxiliary worker: ${workerDef.name} (${auxConfig.name})`)

			const auxManager = new GenerationManager(auxConfig, auxBaseDir, {
				workerName: workerDef.name,
				workerRegistry: registry,
				isMain: false,
				cron: lopataConfig.cron,
				executorFactory,
				configPath: workerDef.config,
			})
			registry.register(workerDef.name, auxManager)

			// Load aux worker first so main's service bindings can resolve
			try {
				const gen = await auxManager.reload()
				console.log(`[lopata] Auxiliary worker "${workerDef.name}" → generation ${gen.id}`)
			} catch (err) {
				console.error(`[lopata] Failed to load auxiliary worker "${workerDef.name}":`, err)
			}

			// File watcher for aux worker
			const auxSrcDir = path.dirname(path.resolve(auxBaseDir, auxConfig.main))
			const auxWatcher = new FileWatcher(auxSrcDir, () => {
				auxManager.reload().then(gen => {
					console.log(`[lopata] Auxiliary worker "${workerDef.name}" reloaded → generation ${gen.id}`)
				}).catch(err => {
					console.error(`[lopata] Reload failed for "${workerDef.name}":`, err)
				})
			})
			auxWatcher.start()
			watchers.push(auxWatcher)
			console.log(`[lopata] Watching ${auxSrcDir} for changes (${workerDef.name})`)
		}

		// Load main worker after aux workers
		const firstGen = await mainManager.reload()
		console.log(`[lopata] Main worker → generation ${firstGen.id}`)

		manager = mainManager
		setGenerationManager(manager)
		setWorkerRegistry(registry)

		// File watcher for main worker
		const mainSrcDir = path.dirname(path.resolve(mainBaseDir, mainConfig.main))
		const mainWatcher = new FileWatcher(mainSrcDir, () => {
			mainManager.reload().then(gen => {
				console.log(`[lopata] Main worker reloaded → generation ${gen.id}`)
			}).catch(err => {
				console.error('[lopata] Reload failed:', err)
			})
		})
		mainWatcher.start()
		watchers.push(mainWatcher)
		console.log(`[lopata] Watching ${mainSrcDir} for changes (main)`)
	} else {
		// ─── Single-worker mode (current behavior) ────────────────────
		const config = await autoLoadConfig(baseDir, envFlag)
		console.log(`[lopata] Loaded config: ${config.name}${envFlag ? ` (env: ${envFlag})` : ''}`)
		setDashboardConfig(config)

		manager = new GenerationManager(config, baseDir)
		const firstGen = await manager.reload()
		console.log(`[lopata] Generation ${firstGen.id} loaded`)
		setGenerationManager(manager)

		// File watcher — watch the source directory
		const srcDir = path.dirname(path.resolve(baseDir, config.main))
		const watcher = new FileWatcher(srcDir, () => {
			manager.reload().then(gen => {
				console.log(`[lopata] Reloaded → generation ${gen.id}`)
			}).catch(err => {
				console.error('[lopata] Reload failed:', err)
			})
		})
		watcher.start()
		watchers.push(watcher)
		console.log(`[lopata] Watching ${srcDir} for changes`)
	}

	// Start server — one Bun.serve(), delegates to active generation
	const port = parseInt(portFlag ?? process.env.PORT ?? '8787', 10)
	const hostname = listenFlag ?? process.env.HOST ?? 'localhost'

	const server = Bun.serve({
		port,
		hostname,
		async fetch(request, server) {
			addCfProperty(request)

			const url = new URL(request.url)

			// Trace WebSocket stream (must be before API/dashboard catch-all for server.upgrade)
			if (url.pathname === '/__api/traces/ws') {
				const upgraded = server.upgrade(request, { data: { type: 'trace-stream', _url: request.url } as any })
				if (!upgraded) return new Response('WebSocket upgrade failed', { status: 500 })
				return undefined as unknown as Response
			}

			// API routes (RPC, R2 upload/download)
			if (url.pathname.startsWith('/__api')) {
				return handleApiRequest(request)
			}

			// Dashboard routes (HTML, assets)
			if (url.pathname.startsWith('/__dashboard')) {
				return handleDashboardRequest(request)
			}

			// Queue pull consumer endpoints: POST /cdn-cgi/handler/queues/<name>/messages/pull and /ack
			const queuePullMatch = url.pathname.match(/^\/cdn-cgi\/handler\/queues\/([^/]+)\/messages\/(pull|ack)$/)
			if (queuePullMatch && request.method === 'POST') {
				const queueName = decodeURIComponent(queuePullMatch[1]!)
				const action = queuePullMatch[2]!
				const queueDb = getDatabase()
				const pullConsumer = new QueuePullConsumer(queueDb, queueName)

				try {
					const body = await request.json() as PullRequest | AckRequest
					if (action === 'pull') {
						const result = pullConsumer.pull(body as PullRequest)
						return Response.json(result)
					} else {
						const result = pullConsumer.ack(body as AckRequest)
						return Response.json(result)
					}
				} catch (err) {
					return Response.json({ error: String(err) }, { status: 400 })
				}
			}

			// Email handler: POST /cdn-cgi/handler/email?from=...&to=...
			if (url.pathname === '/cdn-cgi/handler/email' && request.method === 'POST') {
				const gen = manager.active
				if (!gen) return new Response('No active generation', { status: 503 })
				const from = url.searchParams.get('from') ?? ''
				const to = url.searchParams.get('to') ?? ''
				const raw = await request.arrayBuffer()
				return gen.callEmail(new Uint8Array(raw), from, to)
			}

			// Manual trigger: GET /cdn-cgi/handler/scheduled?cron=<expression>
			if (url.pathname === '/cdn-cgi/handler/scheduled') {
				const gen = manager.active
				if (!gen) return new Response('No active generation', { status: 503 })
				const cronExpr = url.searchParams.get('cron') ?? '* * * * *'
				return gen.callScheduled(cronExpr)
			}

			// Delegate to active generation
			const gen = manager.active
			if (!gen) {
				return new Response('No active generation', { status: 503 })
			}

			return (await gen.callFetch(request, server)) as Response
		},
		websocket: {
			open(ws) {
				const data = ws.data as unknown as Record<string, unknown>
				if (data.type === 'trace-stream') {
					// Trace streaming WebSocket
					const store = getTraceStore()

					let filter: { path?: string; status?: string; attributeFilters?: Array<{ key: string; value: string; type: 'include' | 'exclude' }> } = {}
					let buffer: TraceEvent[] = []
					const MAX_BUFFER = 1000

					// Track which traceIds pass/fail the filter so child spans don't leak
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

					const unsubscribe = store.subscribe((event) => {
						// Determine traceId for this event
						const traceId = event.type === 'span.event'
							? event.event.traceId
							: event.span.traceId

						// For root spans, evaluate filter and track decision
						if ((event.type === 'span.start' || event.type === 'span.end') && event.span.parentSpanId === null) {
							if (isRootSpanFiltered(event.span)) {
								excludedTraces.add(traceId)
								allowedTraces.delete(traceId)
								return
							}
							excludedTraces.delete(traceId)
							allowedTraces.add(traceId)
						} else {
							// Child span or event: check if its trace was already filtered
							if (excludedTraces.has(traceId)) return
							// If we haven't seen the root span yet, allow it through
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

					// Send initial traces (after filter is available from query params)
					try {
						// Parse filter from initial connection URL if provided
						const reqUrl = new URL((data as any)._url ?? 'ws://localhost')
						const statusParam = reqUrl.searchParams.get('status')
						const pathParam = reqUrl.searchParams.get('path')
						if (statusParam) filter.status = statusParam
						if (pathParam) filter.path = pathParam
					} catch {}

					let sinceMs = 15 * 60 * 1000 // default 15 minutes
					const since = Date.now() - sinceMs
					const recent = store.getRecentTraces(since, 200, filter)
					ws.send(JSON.stringify({ type: 'initial', traces: recent })) // Store cleanup handles on ws.data
					;(data as any)._traceCleanup = { unsubscribe, interval }
					;(data as any)._setFilter = (f: typeof filter & { sinceMs?: number }) => {
						filter = f
						if (f.sinceMs !== undefined) sinceMs = f.sinceMs
						// Reset trace tracking when filter changes
						allowedTraces.clear()
						excludedTraces.clear()
						// Re-send filtered initial traces so the client replaces stale data
						const freshSince = sinceMs > 0 ? Date.now() - sinceMs : 0
						const freshTraces = store.getRecentTraces(freshSince, 200, filter)
						ws.send(JSON.stringify({ type: 'initial', traces: freshTraces }))
					}
					return
				}

				// CF WebSocket bridge
				const cfSocket = (data as { cfSocket: CFWebSocket }).cfSocket
				cfSocket.addEventListener('message', (ev: Event) => {
					const msgData = (ev as MessageEvent).data
					ws.send(msgData)
				})
				cfSocket.addEventListener('close', (ev: Event) => {
					const ce = ev as CloseEvent
					ws.close(ce.code, ce.reason)
				})
			},
			message(ws, message) {
				const data = ws.data as unknown as Record<string, unknown>
				if (data.type === 'trace-stream') {
					try {
						const msg = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message))
						if (msg.type === 'filter') {
							const setFilter = (data as any)._setFilter
							if (setFilter) setFilter({ path: msg.path, status: msg.status, attributeFilters: msg.attributeFilters, sinceMs: msg.sinceMs })
						}
					} catch {}
					return
				}

				const cfSocket = (data as { cfSocket: CFWebSocket }).cfSocket
				if (cfSocket._peer?._accepted) {
					cfSocket._peer._dispatchWSEvent({ type: 'message', data: typeof message === 'string' ? message : message.buffer as ArrayBuffer })
				} else if (cfSocket._peer) {
					cfSocket._peer._eventQueue.push({ type: 'message', data: typeof message === 'string' ? message : message.buffer as ArrayBuffer })
				}
			},
			close(ws, code, reason) {
				const data = ws.data as unknown as Record<string, unknown>
				if (data.type === 'trace-stream') {
					const cleanup = (data as any)._traceCleanup
					if (cleanup) {
						cleanup.unsubscribe()
						clearInterval(cleanup.interval)
					}
					return
				}

				const cfSocket = (data as { cfSocket: CFWebSocket }).cfSocket
				if (cfSocket._peer && cfSocket._peer.readyState !== 3 /* CLOSED */) {
					const evt = { type: 'close' as const, code: code ?? 1000, reason: reason ?? '', wasClean: true }
					if (cfSocket._peer._accepted) {
						cfSocket._peer._dispatchWSEvent(evt)
					} else {
						cfSocket._peer._eventQueue.push(evt)
					}
					cfSocket._peer.readyState = 3
				}
				cfSocket.readyState = 3
			},
		},
	})

	console.log(`[lopata] Server running at http://${hostname}:${port}`)
	console.log(`[lopata] Dashboard: http://${hostname}:${port}/__dashboard`)

	// Graceful shutdown
	const shutdown = () => {
		console.log('\n[lopata] Shutting down…')
		for (const w of watchers) w.stop()
		server.stop()
		getTraceStore().close()
		process.exit(0)
	}

	process.on('SIGINT', shutdown)
	process.on('SIGTERM', shutdown)

	// Keep the process alive until signal
	await new Promise(() => {})
}

function matchGlob(text: string, pattern: string): boolean {
	// Placeholder approach: protect ** before escaping special chars
	const regex = pattern
		.replace(/\*\*/g, '\0')
		.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		.replace(/\0/g, '.*')
		.replace(/\*/g, '[^/]*')
	return new RegExp(`^${regex}`).test(text)
}

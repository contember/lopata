/**
 * Worker thread entry point for isolated DO mode.
 *
 * Spawned by WorkerExecutor. Receives configuration via the first
 * postMessage from the main thread (handshake), then initializes.
 */

import type { DOCommand, DOMainMessage, DOResult, DOWorkerMessage } from './do-executor-worker'

declare var self: Worker

interface WorkerConfig {
	modulePath: string
	configPath: string
	dataDir: string
	namespaceName: string
	idStr: string
	idName?: string
}

// Wait for init config from main thread, then set up the worker
self.onmessage = async (event: MessageEvent) => {
	const msg = event.data
	if (msg.type !== 'init') return

	const workerConfig: WorkerConfig = msg.config

	try {
		await initWorker(workerConfig)
	} catch (e) {
		const error = e instanceof Error ? e : new Error(String(e))
		postMessage(
			{
				type: 'result',
				id: -1,
				result: {
					type: 'error',
					message: `Worker init failed: ${error.message}`,
					stack: error.stack,
					name: error.name,
				},
			} satisfies DOMainMessage,
		)
	}
}

// Signal that we're alive and waiting for config
postMessage({ type: 'need-init' })

async function initWorker(workerConfig: WorkerConfig) {
	// Register Bun plugins for cloudflare:workers etc.
	await import('../plugin')

	const { loadConfig } = await import('../config')
	const { buildWorkerEnv, createDoEnvRpc } = await import('./do-worker-env')
	const { DurableObjectStateImpl, DurableObjectIdImpl } = await import('./durable-object')
	const { BridgeWebSocket } = await import('./do-websocket-bridge')
	const { CFWebSocket } = await import('./websocket-pair')
	const { generateId } = await import('../tracing/context')

	const config = await loadConfig(workerConfig.configPath)
	const envRpc = createDoEnvRpc(msg => postMessage(msg))
	const { db, env, doNamespaces } = buildWorkerEnv(config, workerConfig.dataDir, envRpc)

	// Import user's worker module
	const workerModule = await import(workerConfig.modulePath)

	// Wire DO classes for nested DOs
	for (const entry of doNamespaces) {
		const cls = workerModule[entry.className]
		if (cls) {
			entry.namespace._setClass(cls as any, env)
		}
	}

	// Create this DO's instance
	const id = new DurableObjectIdImpl(workerConfig.idStr, workerConfig.idName)
	const cls = workerModule[workerConfig.namespaceName]
	if (!cls) {
		throw new Error(`DO class "${workerConfig.namespaceName}" not exported from worker module`)
	}

	const state = new DurableObjectStateImpl(id, db, workerConfig.namespaceName, workerConfig.dataDir)

	// If this DO has a matching `containers` entry in wrangler config, spin up
	// a `ContainerRuntime` so `ContainerBase` instances can start their image.
	// Mirrors the wiring `InProcessExecutor` used to do on main.
	const containerEntry = config.containers?.find(c => c.class_name === workerConfig.namespaceName)
	let containerRuntime: import('./container').ContainerRuntime | undefined
	if (containerEntry) {
		const { ContainerRuntime, ContainerContext } = await import('./container')
		const { DockerManager } = await import('./container-docker')
		containerRuntime = new ContainerRuntime(
			workerConfig.namespaceName,
			id.toString(),
			containerEntry.image,
			new DockerManager(),
		)
		state.container = new ContainerContext(containerRuntime)
	}

	const instance = new (cls as any)(state, env)

	if (containerRuntime) {
		const { ContainerBase } = await import('./container')
		if (instance instanceof ContainerBase) {
			instance._wireRuntime(containerRuntime)
		}
	}

	state._setInstanceResolver(() => instance)

	const bridgedWebSockets = new Map<string, InstanceType<typeof BridgeWebSocket>>()

	/**
	 * Client peers from `Response{webSocket}` returned by the DO's own fetch().
	 * Each one's events are forwarded to the main thread so the real client sees
	 * them; messages from the real client are dispatched onto the user-facing
	 * server peer (`client._peer`).
	 */
	const fetchBridgedSockets = new Map<string, InstanceType<typeof CFWebSocket>>()

	// Wire alarm callback
	state.storage._setAlarmCallback((time: number | null) => {
		postMessage({ type: 'alarm-set', time } satisfies DOMainMessage)
	})

	// --- Command handler ---

	async function handleCommand(cmd: DOCommand): Promise<DOResult> {
		switch (cmd.type) {
			case 'fetch': {
				await state._enter()
				try {
					const fetchFn = (instance as any).fetch
					if (typeof fetchFn !== 'function') {
						throw new Error('Durable Object does not implement fetch()')
					}
					const request = new Request(cmd.url, {
						method: cmd.method,
						headers: cmd.headers,
						body: cmd.body,
					})
					const response = await fetchFn.call(instance, request)
					const clientWs = (response as { webSocket?: unknown }).webSocket
					const hasWebSocket = response.status === 101 && clientWs instanceof CFWebSocket
					const resBody = !hasWebSocket && response.body ? await response.arrayBuffer() : null
					const resHeaders: [string, string][] = []
					response.headers.forEach((v: string, k: string) => resHeaders.push([k, v]))

					let fetchWebSocketId: string | undefined
					if (hasWebSocket) {
						const ws = clientWs as InstanceType<typeof CFWebSocket>
						fetchWebSocketId = generateId(8)
						fetchBridgedSockets.set(fetchWebSocketId, ws)
						// Forward bytes the user sent on `server` (which dispatch as
						// `message` events on `client`) up to main. Listeners must be
						// attached BEFORE accept() so the flush of any queued events
						// (e.g. user already called server.send() before returning)
						// reaches them.
						ws.addEventListener('message', (ev: Event) => {
							const data = (ev as MessageEvent).data
							postMessage({ type: 'fetch-ws-outgoing', wsId: fetchWebSocketId!, data } satisfies DOMainMessage)
						})
						ws.addEventListener('close', (ev: Event) => {
							const ce = ev as CloseEvent
							postMessage(
								{
									type: 'fetch-ws-close-out',
									wsId: fetchWebSocketId!,
									code: ce.code ?? 1000,
									reason: ce.reason ?? '',
									wasClean: ce.wasClean ?? true,
								} satisfies DOMainMessage,
							)
							fetchBridgedSockets.delete(fetchWebSocketId!)
						})
						ws.accept()
					}

					return {
						type: 'fetch',
						status: response.status,
						statusText: response.statusText,
						headers: resHeaders,
						body: resBody,
						fetchWebSocketId,
					}
				} finally {
					state._exit()
				}
			}

			case 'rpc-call': {
				await state._enter()
				try {
					const val = (instance as any)[cmd.method]
					if (typeof val !== 'function') {
						throw new Error(`"${cmd.method}" is not a method on the Durable Object`)
					}
					const result = await val.call(instance, ...cmd.args)
					return { type: 'rpc-call', value: result }
				} finally {
					state._exit()
				}
			}

			case 'rpc-get': {
				await state._enter()
				try {
					const val = (instance as any)[cmd.prop]
					if (typeof val === 'function') {
						return { type: 'rpc-get', value: '__function__' }
					}
					return { type: 'rpc-get', value: val }
				} finally {
					state._exit()
				}
			}

			case 'alarm': {
				await state._enter()
				try {
					const alarmFn = (instance as any).alarm
					if (typeof alarmFn === 'function') {
						await alarmFn.call(instance, {
							retryCount: cmd.retryCount,
							isRetry: cmd.retryCount > 0,
						})
					}
					return { type: 'alarm' }
				} finally {
					state._exit()
				}
			}

			case 'ws-create': {
				const bridgeWs = new BridgeWebSocket(cmd.wsId, (msg: any) => {
					postMessage({ type: 'ws-bridge', payload: msg } satisfies DOMainMessage)
				})
				bridgedWebSockets.set(cmd.wsId, bridgeWs)
				return { type: 'ws-created', wsId: cmd.wsId }
			}

			default:
				throw new Error(`Unknown command type: ${(cmd as any).type}`)
		}
	}

	// Replace the init handler with the command handler
	self.onmessage = async (event: MessageEvent<DOWorkerMessage>) => {
		const msg = event.data

		// Env-binding RPC results from main (service-binding fetches, etc.)
		if (envRpc.handle(msg)) return

		if (msg.type === 'command') {
			try {
				const result = await handleCommand(msg.command)
				postMessage({ type: 'result', id: msg.id, result } satisfies DOMainMessage)
			} catch (e) {
				const error = e instanceof Error ? e : new Error(String(e))
				postMessage(
					{
						type: 'result',
						id: msg.id,
						result: {
							type: 'error',
							message: error.message,
							stack: error.stack,
							name: error.name,
						},
					} satisfies DOMainMessage,
				)
			}
		} else if (msg.type === 'ws-message') {
			const ws = bridgedWebSockets.get(msg.wsId)
			if (ws) ws._onMessage(msg.data)
		} else if (msg.type === 'ws-close') {
			const ws = bridgedWebSockets.get(msg.wsId)
			if (ws) {
				ws._onClose(msg.code, msg.reason, msg.wasClean)
				bridgedWebSockets.delete(msg.wsId)
			}
		} else if (msg.type === 'ws-error') {
			const ws = bridgedWebSockets.get(msg.wsId)
			if (ws) ws._onError()
		} else if (msg.type === 'fetch-ws-incoming') {
			// Real client wrote bytes → deliver to the user's `server` peer.
			const client = fetchBridgedSockets.get(msg.wsId)
			client?._peer?.dispatchOrQueue({ type: 'message', data: msg.data })
		} else if (msg.type === 'fetch-ws-close-in') {
			const client = fetchBridgedSockets.get(msg.wsId)
			const server = client?._peer
			if (server) {
				server.dispatchOrQueue({ type: 'close', code: msg.code, reason: msg.reason, wasClean: msg.wasClean })
				server.readyState = 3
			}
			if (client) client.readyState = 3
			fetchBridgedSockets.delete(msg.wsId)
		}
	}

	// Signal ready
	postMessage({ type: 'ready' } satisfies DOMainMessage)
}

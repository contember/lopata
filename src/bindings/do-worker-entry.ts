/**
 * Worker thread entry point for isolated DO mode.
 *
 * Spawned by WorkerExecutor. Receives configuration via the first
 * postMessage from the main thread (handshake), then initializes.
 */

import { deserializeError } from '../worker-thread/protocol'
import { OutboundStreamRegistry, pumpStream, StreamReceiver } from '../worker-thread/stream-shared'
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
	const { WsGuestBridge } = await import('../worker-thread/ws-bridge-shared')
	const { ContainerBase, ContainerContext, ContainerRuntime } = await import('./container')
	const { DockerManager } = await import('./container-docker')
	const { containerLabels } = await import('./container-cleanup')

	const config = await loadConfig(workerConfig.configPath)
	const envRpc = createDoEnvRpc(msg => postMessage(msg))
	const { db, env, doNamespaces } = buildWorkerEnv(config, workerConfig.dataDir, envRpc, workerConfig.namespaceName)

	// Import user's worker module
	const workerModule = await import(workerConfig.modulePath)

	// Wire the host DO class — `buildWorkerEnv` only emits an entry for the
	// binding whose `class_name` matches this worker's namespace (the only one
	// with a real local namespace; cross-DO bindings are loud-throw stubs).
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

	// Mirrors the `ContainerRuntime` wiring `InProcessExecutor` did on main —
	// without it, `ContainerBase` instances fail with "Container runtime not
	// initialized" on the first `startAndWaitForPorts` call.
	const containerEntry = config.containers?.find(c => c.class_name === workerConfig.namespaceName)
	let containerRuntime: InstanceType<typeof ContainerRuntime> | undefined
	if (containerEntry) {
		// `DockerManager` itself stays per-worker (the hot path is `docker
		// inspect` polling — no point routing every health check through
		// main). Cleanup tracking, however, lives on main: the worker posts
		// `container-registered` / `container-removed` so main's `exit`
		// handler can rm -f everything regardless of which worker spawned it.
		const dockerManager = new DockerManager({
			onRegister: name => postMessage({ type: 'container-registered', name } satisfies DOMainMessage),
			onRemove: name => postMessage({ type: 'container-removed', name } satisfies DOMainMessage),
			labels: containerLabels(),
		})
		containerRuntime = new ContainerRuntime(
			workerConfig.namespaceName,
			id.toString(),
			containerEntry.image,
			dockerManager,
		)
		state.container = new ContainerContext(containerRuntime)
	}

	const instance = new (cls as any)(state, env)

	if (containerRuntime && instance instanceof ContainerBase) {
		instance._wireRuntime(containerRuntime)
	}

	state._setInstanceResolver(() => instance)

	const bridgedWebSockets = new Map<string, InstanceType<typeof BridgeWebSocket>>()

	/**
	 * Bridge for `Response{webSocket}` returned by the DO's own fetch(). Forwards
	 * the user-facing peer's events up to main and dispatches inbound real-client
	 * events onto the user-facing peer.
	 */
	const fetchWsBridge = new WsGuestBridge<DOMainMessage>(msg => postMessage(msg), {
		remoteMessage: (wsId, data) => ({ type: 'fetch-ws-outgoing', wsId, data }),
		remoteClose: (wsId, code, reason, wasClean) => ({ type: 'fetch-ws-close-out', wsId, code, reason, wasClean }),
	})

	/** Active body pumps for streamed DO-fetch responses, keyed by `streamId`,
	 *  so an inbound `do-stream-cancel` can stop the source reader. */
	const fetchStreams = new OutboundStreamRegistry()

	/** Active reconstructed DO-fetch request bodies (main → DO worker). Chunks
	 *  arriving before the controller registers queue inside the receiver. */
	const requestStreams = new StreamReceiver((streamId) => {
		postMessage({ type: 'do-req-stream-cancel', streamId } satisfies DOMainMessage)
	})

	function pumpFetchBody(streamId: number, body: ReadableStream<Uint8Array>): void {
		type Chunk = Extract<DOMainMessage, { type: 'do-stream-chunk' }>
		type End = Extract<DOMainMessage, { type: 'do-stream-end' }>
		type Err = Extract<DOMainMessage, { type: 'do-stream-error' }>
		pumpStream<Chunk, End, Err>(
			streamId,
			body,
			fetchStreams,
			msg => postMessage(msg),
			{
				chunk: (id, chunk) => ({ type: 'do-stream-chunk', streamId: id, chunk }),
				end: (id) => ({ type: 'do-stream-end', streamId: id }),
				error: (id, error) => ({ type: 'do-stream-error', streamId: id, error }),
			},
		)
	}

	// Wire alarm callback
	state.storage._setAlarmCallback((time: number | null) => {
		postMessage({ type: 'alarm-set', time } satisfies DOMainMessage)
	})

	// --- Command handler ---

	/**
	 * Some commands need to perform side effects *after* their result message is
	 * posted — specifically, streamed fetch responses must wait for main to see
	 * the `streamId` on the `result` before chunk messages arrive (otherwise the
	 * first chunks land before `start()` registers the controller and have to
	 * sit in `_pendingStreamEvents`). The handler returns a continuation so the
	 * dispatcher can post the result first and then start the pump.
	 */
	interface HandledCommand {
		result: DOResult
		afterPost?: () => void
	}

	async function handleCommand(cmd: DOCommand): Promise<HandledCommand> {
		switch (cmd.type) {
			case 'fetch': {
				await state._enter()
				try {
					const fetchFn = (instance as any).fetch
					if (typeof fetchFn !== 'function') {
						throw new Error('Durable Object does not implement fetch()')
					}
					const reqBody = cmd.streamId !== undefined ? requestStreams.open(cmd.streamId) : cmd.body
					const request = new Request(cmd.url, {
						method: cmd.method,
						headers: cmd.headers,
						body: reqBody,
					})
					const response = await fetchFn.call(instance, request)
					const clientWs = (response as { webSocket?: unknown }).webSocket
					const hasWebSocket = response.status === 101 && clientWs instanceof CFWebSocket
					const resHeaders: [string, string][] = []
					response.headers.forEach((v: string, k: string) => resHeaders.push([k, v]))

					let fetchWebSocketId: string | undefined
					if (hasWebSocket) {
						fetchWebSocketId = fetchWsBridge.register(clientWs as InstanceType<typeof CFWebSocket>)
					}

					let streamId: number | undefined
					let afterPost: (() => void) | undefined
					if (!hasWebSocket && response.body) {
						streamId = fetchStreams.allocateId()
						const body = response.body
						afterPost = () => pumpFetchBody(streamId!, body)
					}

					return {
						result: {
							type: 'fetch',
							status: response.status,
							statusText: response.statusText,
							headers: resHeaders,
							body: null,
							fetchWebSocketId,
							streamId,
						},
						afterPost,
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
					return { result: { type: 'rpc-call', value: result } }
				} finally {
					state._exit()
				}
			}

			case 'rpc-get': {
				await state._enter()
				try {
					const val = (instance as any)[cmd.prop]
					if (typeof val === 'function') {
						return { result: { type: 'rpc-get', value: '__function__' } }
					}
					return { result: { type: 'rpc-get', value: val } }
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
					return { result: { type: 'alarm' } }
				} finally {
					state._exit()
				}
			}

			case 'ws-create': {
				const bridgeWs = new BridgeWebSocket(cmd.wsId, (msg: any) => {
					postMessage({ type: 'ws-bridge', payload: msg } satisfies DOMainMessage)
				})
				bridgedWebSockets.set(cmd.wsId, bridgeWs)
				return { result: { type: 'ws-created', wsId: cmd.wsId } }
			}

			default:
				throw new Error(`Unknown command type: ${(cmd as any).type}`)
		}
	}

	// Replace the init handler with the command handler
	self.onmessage = async (event: MessageEvent<DOWorkerMessage>) => {
		const msg = event.data

		// Env-binding RPC replies from main (service-binding fetches, etc.)
		if (envRpc.handle(msg as { type: string })) return

		if (msg.type === 'command') {
			try {
				const { result, afterPost } = await handleCommand(msg.command)
				postMessage({ type: 'result', id: msg.id, result } satisfies DOMainMessage)
				// Post-result side effects: for streamed fetch responses, start the
				// body pump *after* `result` ships so main has registered the
				// `streamId` before any chunk arrives.
				afterPost?.()
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
		} else if (msg.type === 'do-stream-cancel') {
			fetchStreams.cancel(msg.streamId)
		} else if (msg.type === 'do-req-stream-chunk') {
			requestStreams.push(msg.streamId, msg.chunk)
		} else if (msg.type === 'do-req-stream-end') {
			requestStreams.end(msg.streamId)
		} else if (msg.type === 'do-req-stream-error') {
			requestStreams.error(msg.streamId, deserializeError(msg.error))
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
			fetchWsBridge.deliverClientMessage(msg.wsId, msg.data)
		} else if (msg.type === 'fetch-ws-close-in') {
			fetchWsBridge.deliverClientClose(msg.wsId, msg.code, msg.reason, msg.wasClean)
		}
	}

	// Signal ready
	postMessage({ type: 'ready' } satisfies DOMainMessage)
}

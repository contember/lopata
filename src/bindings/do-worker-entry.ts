/**
 * Worker thread entry point for isolated DO mode.
 *
 * Spawned by WorkerExecutor. Receives configuration via the first
 * postMessage from the main thread (handshake), then initializes.
 */

import '../worker-thread/request-clone-fix' // global Request shim — must load before DO code
import { dirname } from 'node:path'
import { type CompatibilitySelection, resolveCompatibility } from '../compatibility'
import { initializeIsolateCompatibility } from '../compatibility-context'
import { ExecutionContext, getActiveExecutionContext, runWithExecutionContext } from '../execution-context'
import { runWithParentContext } from '../tracing/context'
import { createInvocationTrace, getActiveInvocation, type TraceCompletion } from '../tracing/invocation'
import { setTraceStoreOverride } from '../tracing/store'
import { deserializeError, serializeError } from '../worker-thread/protocol'
import { RemoteTraceStore } from '../worker-thread/remote-trace-store'
import { serializeResponseHeaders } from '../worker-thread/serialize'
import { OutboundStreamRegistry, pumpStream, STREAM_BACKPRESSURE_WINDOW, StreamReceiver } from '../worker-thread/stream-shared'
import type { DOCommand, DOMainMessage, DOResult, DOWorkerMessage } from './do-executor-worker'
import type { DurableObjectBase } from './durable-object'
import { isWorkerResponse } from './worker-dispatcher'

declare var self: Worker

interface WorkerConfig {
	compatibility?: CompatibilitySelection
	modulePath: string
	configPath: string
	/** Main's parsed, env-overridden config. When present it's used verbatim so
	 *  the DO env honors `--env` overrides; absent (e.g. standalone test factory)
	 *  we fall back to re-loading from `configPath`. */
	wranglerConfig?: import('../config').WranglerConfig
	/** Runtime settings the worker env gets too (Artifacts URL, browser config). */
	runtime?: import('./do-executor').DOWorkerRuntimeOptions
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
		const message = e instanceof Error ? e.message : String(e)
		postMessage(
			{
				type: 'result',
				id: -1,
				result: { type: 'error', error: serializeError(new Error(`Worker init failed: ${message}`, { cause: e })) },
			} satisfies DOMainMessage,
		)
	}
}

// Signal that we're alive and waiting for config
postMessage({ type: 'need-init' })

async function initWorker(workerConfig: WorkerConfig) {
	setTraceStoreOverride(
		new RemoteTraceStore(message => {
			if (message.type.startsWith('trace-')) postMessage(message)
		}),
	)
	// Register Bun plugins for cloudflare:workers etc.
	await import('../plugin')

	const { buildWorkerEnv, createDoEnvRpc } = await import('./do-worker-env')
	const { DurableObjectStateImpl, DurableObjectIdImpl } = await import('./durable-object')
	const { CFWebSocket } = await import('./websocket-pair')
	const { WsGuestBridge } = await import('../worker-thread/ws-bridge-shared')
	const { ContainerBase, ContainerContext, ContainerRuntime } = await import('./container')
	const { DockerManager } = await import('./container-docker')
	const { containerLabels } = await import('./container-cleanup')

	// Prefer main's already-parsed, env-overridden config; only re-load from disk
	// (WITHOUT --env overrides) when no parsed config was threaded through — e.g.
	// the standalone test factory.
	const config = workerConfig.wranglerConfig ?? await (await import('../config')).loadConfig(workerConfig.configPath)
	const compatibility = workerConfig.compatibility
		? resolveCompatibility({ date: workerConfig.compatibility.date ?? undefined, flags: workerConfig.compatibility.flags })
		: resolveCompatibility({ date: config.compatibility_date, flags: config.compatibility_flags })
	initializeIsolateCompatibility(compatibility)
	// Per-worker dir for `.dev.vars`/`.env`/assets — the config file's directory.
	const baseDir = dirname(workerConfig.configPath)
	const envRpc = createDoEnvRpc(msg => postMessage(msg))

	/**
	 * Bridge for `Response{webSocket}` returned from env-binding fetches the
	 * DO worker calls (e.g. `this.env.SVC.fetch('/ws')`). The user-facing peer
	 * lives here; bytes sent / closes on it travel through this bridge back to
	 * the upstream CFWebSocket adopted on main.
	 */
	const envWsBridge = new WsGuestBridge<DOMainMessage>(msg => postMessage(msg), {
		remoteMessage: (wsId, data) => ({ type: 'env-ws-outgoing', wsId, data }),
		remoteClose: (wsId, code, reason, wasClean) => ({ type: 'env-ws-close-out', wsId, code, reason, wasClean }),
	})

	const { db, env } = buildWorkerEnv(
		config,
		workerConfig.dataDir,
		baseDir,
		envRpc,
		workerConfig.namespaceName,
		envWsBridge,
		workerConfig.runtime,
	)

	// Publish env to `globalEnv` so top-level `import { env } from
	// 'cloudflare:workers'` in the user module sees this DO worker's env (not
	// an empty default). Must happen BEFORE the dynamic import below.
	const { setGlobalEnv } = await import('../env')
	setGlobalEnv(env)

	// Import user's worker module
	const workerModule = await import(workerConfig.modulePath)

	// Create this DO's instance
	const id = new DurableObjectIdImpl(workerConfig.idStr, workerConfig.idName)
	const cls = workerModule[workerConfig.namespaceName]
	if (!cls) {
		throw new Error(`DO class "${workerConfig.namespaceName}" not exported from worker module`)
	}

	const state = new DurableObjectStateImpl(id, db, workerConfig.namespaceName, workerConfig.dataDir, undefined, compatibility)
	state.storage._setAlarmCallback((time: number | null) => {
		postMessage({ type: 'alarm-set', time } satisfies DOMainMessage)
	})
	if (!config.containers?.some(container => container.class_name === workerConfig.namespaceName)) {
		state._setAbortCallback(policy => {
			postMessage({ type: 'do-abort', policy } satisfies DOMainMessage)
		})
	}

	// Mirror the instance's abort/block lifecycle to main so the idle reaper
	// evicts an aborted instance (every subsequent command throws — it must be
	// recreated fresh) and never evicts mid-blockConcurrencyWhile. Main only sees
	// commands/WS traffic, so without these signals it can't observe either.
	const postState = () => {
		postMessage({ type: 'do-state', aborted: state._isAborted(), blocked: state._isBlocked() } satisfies DOMainMessage)
	}
	const originalAbort = state.abort.bind(state)
	state.abort = (reason?: string, options?: { retryAlarm?: boolean }) => {
		try {
			originalAbort(reason, options)
		} finally {
			postState()
		}
	}
	const originalBlock = state.blockConcurrencyWhile.bind(state)
	state.blockConcurrencyWhile = <T>(cb: () => Promise<T>): Promise<T> => {
		const p = originalBlock(cb)
		postState() // entered the block
		// left it — both-callbacks form so a rejecting callback (the caller's
		// to handle via the returned `p`) can't float an unhandled rejection
		p.then(postState, postState)
		return p
	}

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

	let instance: DurableObjectBase | undefined
	let constructionFailure: { error: unknown } | undefined
	function ensureInstance(): DurableObjectBase {
		if (constructionFailure) throw constructionFailure.error
		if (!instance) {
			try {
				instance = new cls(state, env)
			} catch (error) {
				constructionFailure = { error }
				throw error
			}
			if (!instance) throw new Error('Durable Object construction failed')
			if (containerRuntime && instance instanceof ContainerBase) instance._wireRuntime(containerRuntime)
			state._setInstanceResolver(() => instance ?? null)
		}
		return instance
	}

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
	const fetchCancellations = new Map<number, () => void>()

	/** Active reconstructed DO-fetch request bodies (main → DO worker). Chunks
	 *  arriving before the controller registers queue inside the receiver. */
	const requestStreams = new StreamReceiver(
		(streamId) => {
			postMessage({ type: 'do-req-stream-cancel', streamId } satisfies DOMainMessage)
		},
		{
			window: STREAM_BACKPRESSURE_WINDOW,
			onCredit: (streamId) => postMessage({ type: 'do-req-stream-ack', streamId } satisfies DOMainMessage),
		},
	)

	function pumpFetchBody(streamId: number, body: ReadableStream<Uint8Array>, complete?: (completion: TraceCompletion) => void): void {
		const invocation = getActiveInvocation()
		const context = getActiveExecutionContext()
		fetchCancellations.set(streamId, () => {
			const cancel = () => context ? runWithExecutionContext(context, () => fetchStreams.cancel(streamId)) : fetchStreams.cancel(streamId)
			if (invocation) invocation.run(cancel)
			else cancel()
		})
		type Chunk = Extract<DOMainMessage, { type: 'do-stream-chunk' }>
		type End = Extract<DOMainMessage, { type: 'do-stream-end' }>
		type Err = Extract<DOMainMessage, { type: 'do-stream-error' }>
		let terminal: End | Err | undefined
		pumpStream<Chunk, End, Err>(
			streamId,
			body,
			fetchStreams,
			msg => {
				if (msg.type === 'do-stream-chunk') postMessage(msg)
				else terminal = msg
			},
			{
				chunk: (id, chunk) => ({ type: 'do-stream-chunk', streamId: id, chunk }),
				end: (id) => ({ type: 'do-stream-end', streamId: id }),
				error: (id, error) => ({ type: 'do-stream-error', streamId: id, error }),
			},
			undefined,
			STREAM_BACKPRESSURE_WINDOW,
			completion => {
				fetchCancellations.delete(streamId)
				complete?.(completion)
				// Publish completion before EOF so main's activity state is current when the body settles.
				queueMicrotask(() => {
					if (terminal) postMessage(terminal)
				})
			},
		)
	}

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
		cancelResponse?: (error: unknown) => Promise<void>
	}

	async function handleCommand(cmd: DOCommand): Promise<HandledCommand> {
		if (cmd.type === 'cleanup') {
			await containerRuntime?.cleanup()
			return { result: { type: 'cleanup' } }
		}
		const target = ensureInstance()
		switch (cmd.type) {
			case 'fetch': {
				await state._enter()
				try {
					const fetchFn: unknown = Reflect.get(target, 'fetch')
					if (typeof fetchFn !== 'function') {
						throw new Error('Durable Object does not implement fetch()')
					}
					const reqBody = cmd.streamId !== undefined ? requestStreams.open(cmd.streamId) : cmd.body
					const request = new Request(cmd.url, {
						method: cmd.method,
						headers: cmd.headers,
						body: reqBody,
					})
					let response: Response
					try {
						const result: unknown = await fetchFn.call(target, request)
						if (!isWorkerResponse(result)) throw new TypeError('Durable Object fetch() must return a Response')
						response = result
					} catch (e) {
						// The instance's fetch errored without draining the streamed
						// request body — cancel the receiver so main stops pumping and
						// buffered chunks are dropped. Mirrors dispatchRpcFetch's contract.
						if (cmd.streamId !== undefined) requestStreams.cancel(cmd.streamId)
						throw e
					}
					// Resolved but the body wasn't consumed (e.g. a 401 before reading) —
					// cancel the receiver so main's pump doesn't park forever holding the
					// source. Preserve the transport's existing unread-body policy.
					if (cmd.streamId !== undefined && !request.bodyUsed) {
						requestStreams.cancel(cmd.streamId)
					}
					const clientWs: unknown = Reflect.get(response, 'webSocket')
					const hasWebSocket = response.status === 101 && clientWs instanceof CFWebSocket
					const resHeaders = serializeResponseHeaders(response)

					let fetchWebSocketId: string | undefined
					if (hasWebSocket) {
						// Main pins the executor on this id (hibernation or plain socket
						// alike) when it processes the result and unpins on close, so no
						// separate accept signal is needed.
						fetchWebSocketId = fetchWsBridge.register(clientWs)
					}

					let streamId: number | undefined
					let afterPost: (() => void) | undefined
					let cancelResponse: ((error: unknown) => Promise<void>) | undefined
					if (!hasWebSocket && response.body) {
						streamId = fetchStreams.allocateId()
						const body = response.body
						const release = getActiveInvocation()?.retain('response-body')
						afterPost = () => pumpFetchBody(streamId!, body, release)
						cancelResponse = async error => {
							try {
								await body.cancel(error)
							} finally {
								release?.({ kind: 'error', error })
							}
						}
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
						cancelResponse,
					}
				} finally {
					state._exit()
				}
			}

			case 'rpc-call': {
				await state._enter()
				try {
					const val: unknown = Reflect.get(target, cmd.method)
					if (typeof val !== 'function') {
						throw new Error(`"${cmd.method}" is not a method on the Durable Object`)
					}
					const result: unknown = await val.call(target, ...cmd.args)
					return { result: { type: 'rpc-call', value: result } }
				} finally {
					state._exit()
				}
			}

			case 'rpc-get': {
				await state._enter()
				try {
					const val: unknown = await Reflect.get(target, cmd.prop)
					if (typeof val === 'function') {
						return { result: { type: 'rpc-get', kind: 'function' } }
					}
					return { result: { type: 'rpc-get', kind: 'value', value: val } }
				} finally {
					state._exit()
				}
			}

			case 'alarm': {
				await state._enter()
				try {
					const alarmFn: unknown = Reflect.get(target, 'alarm')
					if (typeof alarmFn === 'function') {
						await alarmFn.call(target, {
							retryCount: cmd.retryCount,
							isRetry: cmd.retryCount > 0,
						})
					}
					return { result: { type: 'alarm' } }
				} finally {
					state._exit()
				}
			}

			default:
				throw new Error('Unknown Durable Object command')
		}
	}

	// Replace the init handler with the command handler
	self.onmessage = async (event: MessageEvent<DOWorkerMessage>) => {
		const msg = event.data

		// Env-binding RPC replies from main (service-binding fetches, etc.)
		if (envRpc.handle(msg)) return

		if (msg.type === 'command') {
			const scope = msg.command.type === 'cleanup' ? undefined : runWithParentContext(msg.parent, () =>
				createInvocationTrace({
					name: `do.${msg.command.type} ${workerConfig.namespaceName}`,
					kind: 'server',
					workerName: config.name,
					attributes: { 'do.namespace': workerConfig.namespaceName, 'do.id': workerConfig.idStr },
				}))
			if (scope) {
				postMessage({ type: 'do-invocation-start', id: msg.id } satisfies DOMainMessage)
				void scope.completed.then(() => postMessage({ type: 'do-invocation-end', id: msg.id } satisfies DOMainMessage))
			}
			const dispatch = async () => {
				const { result, afterPost, cancelResponse } = await handleCommand(msg.command)
				try {
					postMessage({ type: 'result', id: msg.id, result } satisfies DOMainMessage)
				} catch (error) {
					await cancelResponse?.(error)
					throw error
				}
				afterPost?.()
				postState()
			}
			try {
				if (scope) await scope.run(() => runWithExecutionContext(new ExecutionContext(), dispatch))
				else await dispatch()
				scope?.finishHandler()
			} catch (e) {
				scope?.finishHandler({ kind: 'error', error: e })
				postMessage(
					{
						type: 'result',
						id: constructionFailure ? -1 : msg.id,
						result: { type: 'error', error: serializeError(e) },
					} satisfies DOMainMessage,
				)
				// The command may have thrown because the instance was aborted
				// (state._enter() rejects once aborted) — make sure main learns of it.
				postState()
			}
		} else if (msg.type === 'do-stream-ack') {
			fetchStreams.grantCredit(msg.streamId)
		} else if (msg.type === 'do-stream-cancel') {
			fetchCancellations.get(msg.streamId)?.()
		} else if (msg.type === 'do-req-stream-chunk') {
			requestStreams.push(msg.streamId, msg.chunk)
		} else if (msg.type === 'do-req-stream-end') {
			requestStreams.end(msg.streamId)
		} else if (msg.type === 'do-req-stream-error') {
			requestStreams.error(msg.streamId, deserializeError(msg.error))
		} else if (msg.type === 'fetch-ws-incoming') {
			fetchWsBridge.deliverClientMessage(msg.wsId, msg.data)
		} else if (msg.type === 'fetch-ws-close-in') {
			fetchWsBridge.deliverClientClose(msg.wsId, msg.code, msg.reason, msg.wasClean)
		} else if (msg.type === 'env-ws-incoming') {
			envWsBridge.deliverClientMessage(msg.wsId, msg.data)
		} else if (msg.type === 'env-ws-close-in') {
			envWsBridge.deliverClientClose(msg.wsId, msg.code, msg.reason, msg.wasClean)
		}
	}

	// Signal ready
	postMessage({ type: 'ready' } satisfies DOMainMessage)
}

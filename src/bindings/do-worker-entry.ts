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
	const { buildWorkerEnv } = await import('./do-worker-env')
	const { DurableObjectStateImpl, DurableObjectIdImpl } = await import('./durable-object')
	const { BridgeWebSocket } = await import('./do-websocket-bridge')

	const config = await loadConfig(workerConfig.configPath)
	const { db, env, doNamespaces } = buildWorkerEnv(config, workerConfig.dataDir)

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
	const instance = new (cls as any)(state, env)

	state._setInstanceResolver(() => instance)

	const bridgedWebSockets = new Map<string, InstanceType<typeof BridgeWebSocket>>()

	// Wire alarm callback
	state.storage._setAlarmCallback((time: number | null) => {
		postMessage({ type: 'alarm-set', time } satisfies DOMainMessage)
	})

	// --- Command handler ---

	async function handleCommand(cmd: DOCommand): Promise<DOResult> {
		switch (cmd.type) {
			case 'fetch': {
				const unlock = await state._lock()
				try {
					await state._waitForReady()
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
					const resBody = response.body ? await response.arrayBuffer() : null
					const resHeaders: [string, string][] = []
					response.headers.forEach((v: string, k: string) => resHeaders.push([k, v]))
					return {
						type: 'fetch',
						status: response.status,
						statusText: response.statusText,
						headers: resHeaders,
						body: resBody,
					}
				} finally {
					unlock()
				}
			}

			case 'rpc-call': {
				const unlock = await state._lock()
				try {
					await state._waitForReady()
					const val = (instance as any)[cmd.method]
					if (typeof val !== 'function') {
						throw new Error(`"${cmd.method}" is not a method on the Durable Object`)
					}
					const result = await val.call(instance, ...cmd.args)
					return { type: 'rpc-call', value: result }
				} finally {
					unlock()
				}
			}

			case 'rpc-get': {
				const unlock = await state._lock()
				try {
					await state._waitForReady()
					const val = (instance as any)[cmd.prop]
					if (typeof val === 'function') {
						return { type: 'rpc-get', value: '__function__' }
					}
					return { type: 'rpc-get', value: val }
				} finally {
					unlock()
				}
			}

			case 'alarm': {
				const unlock = await state._lock()
				try {
					await state._waitForReady()
					const alarmFn = (instance as any).alarm
					if (typeof alarmFn === 'function') {
						await alarmFn.call(instance, {
							retryCount: cmd.retryCount,
							isRetry: cmd.retryCount > 0,
						})
					}
					return { type: 'alarm' }
				} finally {
					unlock()
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
		}
	}

	// Signal ready
	postMessage({ type: 'ready' } satisfies DOMainMessage)
}

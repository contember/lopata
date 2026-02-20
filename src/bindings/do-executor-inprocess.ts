import { warnInvalidRpcArgs } from '../rpc-validate'
import type { DOExecutor, DOExecutorFactory, ExecutorConfig } from './do-executor'
import { type DurableObjectBase, DurableObjectStateImpl } from './durable-object'
import { createRpcFunctionStub, wrapRpcReturnValue } from './rpc-stub'

export class InProcessExecutor implements DOExecutor {
	private _state: DurableObjectStateImpl
	private _instance: DurableObjectBase
	private _containerRuntime?: import('./container').ContainerRuntime

	constructor(config: ExecutorConfig) {
		const { id, db, namespaceName, cls, env, dataDir, limits, containerConfig, onAlarmSet } = config

		this._state = new DurableObjectStateImpl(id, db, namespaceName, dataDir, limits)

		// Wire container runtime if configured
		if (containerConfig) {
			const { ContainerRuntime, ContainerContext } = require('./container') as typeof import('./container')
			this._containerRuntime = new ContainerRuntime(
				containerConfig.className,
				id.toString(),
				containerConfig.image,
				containerConfig.dockerManager,
			)
			this._state.container = new ContainerContext(this._containerRuntime)
		}

		this._instance = new cls(this._state, env)

		// Wire container runtime to ContainerBase instance
		if (this._containerRuntime) {
			const { ContainerBase } = require('./container') as typeof import('./container')
			if (this._instance instanceof ContainerBase) {
				this._instance._wireRuntime(this._containerRuntime)
			}
		}

		// Wire instance resolver for WebSocket handler delegation
		this._state._setInstanceResolver(() => this._instance)

		// Wire alarm callback
		if (onAlarmSet) {
			this._state.storage._setAlarmCallback(onAlarmSet)
		}
	}

	async executeFetch(request: Request): Promise<Response> {
		const unlock = await this._state._lock()
		try {
			await this._state._waitForReady()
			const fetchFn = (this._instance as unknown as Record<string, unknown>).fetch
			if (typeof fetchFn !== 'function') {
				throw new Error('Durable Object does not implement fetch()')
			}
			return await (fetchFn as (req: Request) => Promise<Response>).call(this._instance, request)
		} finally {
			unlock()
		}
	}

	async executeRpc(method: string, args: unknown[]): Promise<unknown> {
		warnInvalidRpcArgs(args, method)
		const unlock = await this._state._lock()
		try {
			await this._state._waitForReady()
			const val = (this._instance as unknown as Record<string, unknown>)[method]
			if (typeof val === 'function') {
				const result = await (val as (...a: unknown[]) => unknown).call(this._instance, ...args)
				return wrapRpcReturnValue(result, method)
			}
			throw new Error(`"${method}" is not a method on the Durable Object`)
		} finally {
			unlock()
		}
	}

	async executeRpcGet(prop: string): Promise<unknown> {
		const unlock = await this._state._lock()
		try {
			await this._state._waitForReady()
			const val = (this._instance as unknown as Record<string, unknown>)[prop]
			if (typeof val === 'function') {
				return createRpcFunctionStub(val as Function, this._instance)
			}
			return wrapRpcReturnValue(val, prop)
		} finally {
			unlock()
		}
	}

	async executeAlarm(retryCount: number): Promise<void> {
		const unlock = await this._state._lock()
		try {
			await this._state._waitForReady()
			const alarmFn = (this._instance as unknown as Record<string, unknown>).alarm
			if (typeof alarmFn === 'function') {
				await alarmFn.call(this._instance, {
					retryCount,
					isRetry: retryCount > 0,
				})
			}
		} finally {
			unlock()
		}
	}

	isActive(): boolean {
		return this._state._hasActiveRequests()
	}

	isBlocked(): boolean {
		return this._state._isBlocked()
	}

	activeWebSocketCount(): number {
		return this._state.getWebSockets().length
	}

	isAborted(): boolean {
		return this._state._isAborted()
	}

	async dispose(): Promise<void> {
		if (this._containerRuntime) {
			await this._containerRuntime.cleanup()
		}
	}

	/** @internal Get the raw DO instance (for testing/dashboard) */
	get _rawInstance(): DurableObjectBase {
		return this._instance
	}

	/** @internal Get the state (for testing/alarm access) */
	get _rawState(): DurableObjectStateImpl {
		return this._state
	}
}

export class InProcessExecutorFactory implements DOExecutorFactory {
	create(config: ExecutorConfig): DOExecutor {
		return new InProcessExecutor(config)
	}
}

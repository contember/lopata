import type { CompatibilitySelection } from '../compatibility'
import { legacyCompatibility, runWithCompatibility } from '../compatibility-context'
import { warnInvalidRpcArgs } from '../rpc-validate'
import type { DOAbortPolicy, DOExecutor, DOExecutorFactory, ExecutorConfig } from './do-executor'
import { type DurableObjectBase, DurableObjectStateImpl } from './durable-object'
import { isRpcTarget, type RpcExecutionScope, wrapRpcReturnValue } from './rpc-stub'

export class InProcessExecutor implements DOExecutor {
	private _state: DurableObjectStateImpl
	private _instance: DurableObjectBase
	private _containerRuntime?: import('./container').ContainerRuntime
	private compatibility: CompatibilitySelection
	private abortPolicy?: DOAbortPolicy
	private abortSignal = Promise.withResolvers<never>()

	constructor(config: ExecutorConfig) {
		this.compatibility = config.compatibility ?? legacyCompatibility
		const { id, db, namespaceName, cls, env, dataDir, limits, containerConfig, onAlarmSet } = config

		this._state = new DurableObjectStateImpl(id, db, namespaceName, dataDir, limits, this.compatibility)
		if (onAlarmSet) this._state.storage._setAlarmCallback(onAlarmSet)
		void this.abortSignal.promise.catch(() => {})
		if (!containerConfig) {
			this._state._setAbortCallback(policy => {
				this.abortPolicy = policy
				this.abortSignal.reject(new Error(policy.reason))
			})
		}

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

		this._instance = this._construct(cls, env)

		// Wire container runtime to ContainerBase instance
		if (this._containerRuntime) {
			const { ContainerBase } = require('./container') as typeof import('./container')
			if (this._instance instanceof ContainerBase) {
				this._instance._wireRuntime(this._containerRuntime)
			}
		}

		// Wire instance resolver for WebSocket handler delegation
		this._state._setInstanceResolver(() => this._instance)
	}

	private _construct(cls: new(ctx: DurableObjectStateImpl, env: unknown) => DurableObjectBase, env: unknown): DurableObjectBase {
		return runWithCompatibility(this.compatibility, () => new cls(this._state, env))
	}

	private readonly scope: RpcExecutionScope = { run: callback => runWithCompatibility(this.compatibility, callback) }

	private async _invoke<T>(callback: () => Promise<T>): Promise<T> {
		if (this.abortPolicy) throw new Error(this.abortPolicy.reason)
		// In-process handlers cannot be killed; abort only detaches their callers.
		return Promise.race([runWithCompatibility(this.compatibility, callback), this.abortSignal.promise])
	}

	async executeFetch(request: Request): Promise<Response> {
		return this._invoke(async () => {
			await this._state._enter()
			try {
				const fetchFn = (this._instance as unknown as Record<string, unknown>).fetch
				if (typeof fetchFn !== 'function') {
					throw new Error('Durable Object does not implement fetch()')
				}
				return await (fetchFn as (req: Request) => Promise<Response>).call(this._instance, request)
			} finally {
				this._state._exit()
			}
		})
	}

	async executeRpc(method: string, args: unknown[]): Promise<unknown> {
		return this._invoke(async () => {
			warnInvalidRpcArgs(args, method)
			await this._state._enter()
			try {
				const val = (this._instance as unknown as Record<string, unknown>)[method]
				if (typeof val === 'function') {
					// Plain values stay raw — the namespace `get()` stub validates them once.
					// Capabilities are pre-scoped so their calls keep this DO's compatibility selection.
					const result: unknown = await (val as (...a: unknown[]) => unknown).call(this._instance, ...args)
					return typeof result === 'function' || isRpcTarget(result) ? wrapRpcReturnValue(result, method, this.scope) : result
				}
				throw new Error(`"${method}" is not a method on the Durable Object`)
			} finally {
				this._state._exit()
			}
		})
	}

	async executeRpcGet(prop: string): Promise<unknown> {
		return this._invoke(async () => {
			await this._state._enter()
			try {
				const val = (this._instance as unknown as Record<string, unknown>)[prop]
				if (typeof val === 'function') {
					// Re-dispatching callable (mirrors WorkerExecutor.executeRpcGet); the
					// stub wraps it once. Avoids the double function-stub wrap.
					return (...args: unknown[]) => this.executeRpc(prop, args)
				}
				return val
			} finally {
				this._state._exit()
			}
		})
	}

	async executeAlarm(retryCount: number): Promise<void> {
		return this._invoke(async () => {
			await this._state._enter()
			try {
				const alarmFn = (this._instance as unknown as Record<string, unknown>).alarm
				if (typeof alarmFn === 'function') {
					await alarmFn.call(this._instance, {
						retryCount,
						isRetry: retryCount > 0,
					})
				}
			} finally {
				this._state._exit()
			}
		})
	}

	getAbortPolicy(): DOAbortPolicy | undefined {
		return this.abortPolicy
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

	reloadClass(cls: new(ctx: DurableObjectStateImpl, env: unknown) => DurableObjectBase, env: unknown, compatibility = this.compatibility): void {
		this.compatibility = compatibility
		this._state.storage._setCompatibility(compatibility)
		this._instance = this._construct(cls, env)
		this._state._setInstanceResolver(() => this._instance)
	}

	async dispose(): Promise<void> {
		// Close all accepted WebSockets so clients can reconnect to new instance
		for (const ws of this._state.getWebSockets()) {
			try {
				ws.close(1012, 'Service restart')
			} catch {}
		}
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

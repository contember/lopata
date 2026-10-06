import type { CompatibilitySelection } from '../compatibility'
import { getActiveCompatibility, legacyCompatibility, runWithCompatibility } from '../compatibility-context'
import { ExecutionContext, getActiveExecutionContext, runWithExecutionContext } from '../execution-context'
import { warnInvalidRpcArgs } from '../rpc-validate'
import { createInvocationTrace, getActiveInvocation, type InvocationTrace } from '../tracing/invocation'
import type { DOExecutor, DOExecutorFactory, ExecutorConfig } from './do-executor'
import { type DurableObjectBase, DurableObjectStateImpl } from './durable-object'
import { createRpcSession, type RpcSession } from './rpc-session'
import { createRpcFunctionStub, wrapRpcReturnValue } from './rpc-stub'
import { isWorkerResponse, trackInvocationResponse } from './worker-cache'

export class InProcessExecutor implements DOExecutor {
	private _state: DurableObjectStateImpl
	private _instance: DurableObjectBase
	private _containerRuntime?: import('./container').ContainerRuntime
	private _invocations = new Set<InvocationTrace>()
	private _rpcSessions = new Set<RpcSession>()
	// Keep empty sets until caller completion so repeated RPCs share one completion listener.
	private _callerSessions = new WeakMap<InvocationTrace, Set<RpcSession>>()
	private _namespaceName: string
	private _disposed = false
	private compatibility: CompatibilitySelection

	constructor(config: ExecutorConfig) {
		this.compatibility = config.compatibility ?? legacyCompatibility
		const { id, db, namespaceName, cls, env, dataDir, limits, containerConfig, onAlarmSet } = config
		this._namespaceName = namespaceName

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

		// Wire alarm callback
		if (onAlarmSet) {
			this._state.storage._setAlarmCallback(onAlarmSet)
		}
	}

	private _startInvocation(operation: string): InvocationTrace {
		if (this._disposed) throw new Error('Durable Object executor has been disposed')
		const scope = createInvocationTrace({
			name: `do.${operation} ${this._namespaceName}`,
			kind: 'server',
			attributes: { 'do.namespace': this._namespaceName, 'do.id': this._state.id.toString() },
		})
		this._invocations.add(scope)
		void scope.completed.then(() => this._invocations.delete(scope))
		return scope
	}

	private _construct(cls: new(ctx: DurableObjectStateImpl, env: unknown) => DurableObjectBase, env: unknown): DurableObjectBase {
		const scope = this._startInvocation('constructor')
		try {
			const instance = runWithCompatibility(
				this.compatibility,
				() => scope.run(() => runWithExecutionContext(new ExecutionContext(), () => new cls(this._state, env))),
			)
			scope.finishHandler()
			return instance
		} catch (error) {
			scope.finishHandler({ kind: 'error', error })
			scope.terminate('Durable Object construction failed')
			throw error
		}
	}

	private async _invoke<T>(operation: string, callback: (scope: InvocationTrace, context: ExecutionContext) => Promise<T>): Promise<T> {
		const scope = this._startInvocation(operation)
		try {
			const result = await runWithCompatibility(this.compatibility, () =>
				scope.run(() => {
					const context = new ExecutionContext()
					return runWithExecutionContext(context, () => callback(scope, context))
				}))
			scope.finishHandler()
			return result
		} catch (error) {
			scope.finishHandler({ kind: 'error', error })
			throw error
		}
	}

	private _invokeRpc(operation: string, member: string, callback: (session: RpcSession) => Promise<unknown>): Promise<unknown> {
		const caller = getActiveInvocation()
		let callerSessions = caller ? this._callerSessions.get(caller) : undefined
		if (caller && !callerSessions) {
			const sessions = new Set<RpcSession>()
			const registry = this._callerSessions
			registry.set(caller, sessions)
			callerSessions = sessions
			void caller.completed.then(() => {
				for (const session of sessions) session.close()
				sessions.clear()
				registry.delete(caller)
			})
		}
		return this._invoke(operation, async (invocation, context) => {
			const compatibility = getActiveCompatibility()
			const session: RpcSession = createRpcSession({
				run: callback => runWithCompatibility(compatibility, () => invocation.run(() => runWithExecutionContext(context, callback))),
				retain: () => {
					const release = invocation.retain('handler')
					return () => {
						this._rpcSessions.delete(session)
						callerSessions?.delete(session)
						release()
					}
				},
				isClosed: () => invocation.closed || this._disposed || caller?.closed === true,
			})
			this._rpcSessions.add(session)
			callerSessions?.add(session)
			try {
				return await session.run(async () => {
					const result = await callback(session)
					return session.run(() => wrapRpcReturnValue(result, member, session))
				})
			} catch (error) {
				session.close()
				throw error
			} finally {
				session.finish()
			}
		})
	}

	async executeFetch(request: Request): Promise<Response> {
		return this._invoke('fetch', async scope => {
			await this._state._enter()
			try {
				const fetchFn: unknown = Reflect.get(this._instance, 'fetch')
				if (typeof fetchFn !== 'function') {
					throw new Error('Durable Object does not implement fetch()')
				}
				const response: unknown = await fetchFn.call(this._instance, request)
				if (!isWorkerResponse(response)) throw new TypeError('Durable Object fetch() must return a Response')
				return trackInvocationResponse(response, scope, getActiveExecutionContext())
			} finally {
				this._state._exit()
			}
		})
	}

	async executeRpc(method: string, args: unknown[]): Promise<unknown> {
		return this._invokeRpc('rpc-call', method, async () => {
			warnInvalidRpcArgs(args, method)
			await this._state._enter()
			try {
				const val: unknown = Reflect.get(this._instance, method)
				if (typeof val === 'function') {
					return await val.call(this._instance, ...args)
				}
				throw new Error(`"${method}" is not a method on the Durable Object`)
			} finally {
				this._state._exit()
			}
		})
	}

	async executeRpcGet(prop: string): Promise<unknown> {
		return this._invokeRpc('rpc-get', prop, async session => {
			await this._state._enter()
			try {
				const val: unknown = Reflect.get(this._instance, prop)
				if (typeof val === 'function') {
					const instance = this._instance
					return createRpcFunctionStub(
						async (...args: unknown[]) => {
							await this._state._enter()
							try {
								return await Reflect.apply(val, instance, args)
							} finally {
								this._state._exit()
							}
						},
						undefined,
						session,
					)
				}
				return val
			} finally {
				this._state._exit()
			}
		})
	}

	async executeAlarm(retryCount: number): Promise<void> {
		return this._invoke('alarm', async () => {
			await this._state._enter()
			try {
				const alarmFn: unknown = Reflect.get(this._instance, 'alarm')
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

	isActive(): boolean {
		return this._state._hasActiveRequests() || this._invocations.size > 0
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
		this._instance = this._construct(cls, env)
		this._state._setInstanceResolver(() => this._instance)
	}

	async dispose(): Promise<void> {
		this._disposed = true
		for (const scope of this._invocations) scope.terminate('Durable Object executor disposed')
		this._invocations.clear()
		for (const session of this._rpcSessions) session.close()
		this._rpcSessions.clear()
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

	isDisposed(): boolean {
		return this._disposed
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

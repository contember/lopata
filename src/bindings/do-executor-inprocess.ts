import type { CompatibilitySelection } from '../compatibility'
import { getActiveCompatibility, legacyCompatibility, runWithCompatibility } from '../compatibility-context'
import { ExecutionContext, getActiveExecutionContext, runWithExecutionContext } from '../execution-context'
import { warnInvalidRpcArgs } from '../rpc-validate'
import { createInvocationTrace, getActiveInvocation, type InvocationTrace } from '../tracing/invocation'
import type { DOAbortPolicy, DOAlarmAborted, DOExecutor, DOExecutorFactory, ExecutorConfig } from './do-executor'
import { type DurableObjectBase, DurableObjectStateImpl } from './durable-object'
import { createRpcSession, type RpcSession } from './rpc-session'
import { createRpcFunctionStub, wrapRpcReturnValue } from './rpc-stub'
import { isWorkerResponse, trackInvocationResponse } from './worker-dispatcher'

export class InProcessExecutor implements DOExecutor {
	private _state: DurableObjectStateImpl
	private _instance: DurableObjectBase | undefined
	private _containerRuntime?: import('./container').ContainerRuntime
	private _invocations = new Set<InvocationTrace>()
	private _rpcSessions = new Set<RpcSession>()
	// Keep empty sets until caller completion so repeated RPCs share one completion listener.
	private _callerSessions = new WeakMap<InvocationTrace, Set<RpcSession>>()
	private _namespaceName: string
	private _disposed = false
	private compatibility: CompatibilitySelection
	private abortPolicy?: DOAbortPolicy
	private abortSignal = Promise.withResolvers<never>()
	private handlers = new Set<Promise<unknown>>()

	constructor(config: ExecutorConfig) {
		this.compatibility = config.compatibility ?? legacyCompatibility
		const { id, db, namespaceName, cls, env, dataDir, limits, containerConfig, onAlarmSet } = config
		this._namespaceName = namespaceName

		this._state = new DurableObjectStateImpl(id, db, namespaceName, dataDir, limits, this.compatibility)
		if (onAlarmSet) this._state.storage._setAlarmCallback(onAlarmSet)
		void this.abortSignal.promise.catch(() => {})
		if (!containerConfig) {
			this._state._setAbortCallback(policy => {
				this.abortPolicy = policy
				this.abortSignal.reject(new Error(policy.reason))
				for (const scope of this._invocations) scope.terminate(policy.reason)
				for (const session of this._rpcSessions) session.close()
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
		this._state._setInstanceResolver(() => this._instance ?? null)
	}

	private _startInvocation(operation: string): InvocationTrace {
		if (this._disposed) throw new Error('Durable Object executor has been disposed')
		if (this.abortPolicy) throw new Error(this.abortPolicy.reason)
		const scope = createInvocationTrace({
			name: `do.${operation} ${this._namespaceName}`,
			kind: 'server',
			attributes: { 'do.namespace': this._namespaceName, 'do.id': this._state.id.toString() },
		})
		this._invocations.add(scope)
		void scope.completed.then(() => this._invocations.delete(scope))
		return scope
	}

	private _construct(cls: new(ctx: DurableObjectStateImpl, env: unknown) => DurableObjectBase, env: unknown): DurableObjectBase | undefined {
		const scope = this._startInvocation('constructor')
		try {
			const instance = this._state.storage._runAlarmAttempt(undefined, () =>
				runWithCompatibility(
					this.compatibility,
					() => scope.run(() => runWithExecutionContext(new ExecutionContext(), () => new cls(this._state, env))),
				))
			scope.finishHandler()
			return instance
		} catch (error) {
			scope.finishHandler({ kind: 'error', error })
			scope.terminate('Durable Object construction failed')
			if (this.abortPolicy) return undefined
			throw error
		}
	}

	private async _invoke<T>(operation: string, callback: (scope: InvocationTrace, context: ExecutionContext) => Promise<T>): Promise<T> {
		const scope = this._startInvocation(operation)
		try {
			const pending = this._state.storage._runAlarmAttempt(undefined, () =>
				runWithCompatibility(this.compatibility, () =>
					scope.run(() => {
						const context = new ExecutionContext()
						return runWithExecutionContext(context, () => callback(scope, context))
					})))
			this.handlers.add(pending)
			const settled = pending.finally(() => this.handlers.delete(pending))
			const result = await Promise.race([settled, this.abortSignal.promise])
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
				run: callback =>
					this._state.storage._runAlarmAttempt(
						undefined,
						() => runWithCompatibility(compatibility, () => invocation.run(() => runWithExecutionContext(context, callback))),
					),
				trackCall: () => {
					const call = Promise.withResolvers<void>()
					this.handlers.add(call.promise)
					return () => {
						this.handlers.delete(call.promise)
						call.resolve()
					}
				},
				awaitResult: pending => Promise.race([pending, this.abortSignal.promise]),
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
				const fetchFn: unknown = Reflect.get(this._rawInstance, 'fetch')
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
				const val: unknown = Reflect.get(this._rawInstance, method)
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
				const val: unknown = Reflect.get(this._rawInstance, prop)
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

	async executeAlarm(retryCount: number, attemptId?: number): Promise<void | DOAlarmAborted> {
		try {
			await this._invoke('alarm', async () => {
				await this._state._enter()
				try {
					const alarmFn: unknown = Reflect.get(this._rawInstance, 'alarm')
					if (typeof alarmFn === 'function') {
						await this._state.storage._runAlarmAttempt(attemptId, () =>
							alarmFn.call(this._instance, {
								retryCount,
								isRetry: retryCount > 0,
							}))
					}
				} finally {
					this._state._exit()
				}
			})
		} catch (error) {
			if (!this.abortPolicy) throw error
			return { type: 'aborted', policy: this.abortPolicy }
		}
	}

	async whenStopped(): Promise<void> {
		await Promise.resolve()
		await Promise.allSettled([...this.handlers, this._state._waitForReady()])
	}

	getAbortPolicy(): DOAbortPolicy | undefined {
		return this.abortPolicy
	}

	isActive(): boolean {
		return (this.abortPolicy !== undefined && this._state._isBlocked()) || this.handlers.size > 0 || this._state._hasActiveRequests()
			|| this._invocations.size > 0
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
		this._state._setInstanceResolver(() => this._instance ?? null)
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
		if (!this._instance) throw new Error(this.abortPolicy?.reason ?? 'Durable Object construction failed')
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

import type { ReadableStreamDefaultReader } from 'node:stream/web'
import type { CompatibilitySelection } from '../compatibility'
import { getActiveCompatibility, legacyCompatibility, runWithCompatibility } from '../compatibility-context'
import { resolveEntrypointHandler } from '../entrypoint-handler'
import { getActiveExecutionContext, runWithExecutionContext } from '../execution-context'
import { warnInvalidRpcArgs } from '../rpc-validate'
import { createInvocationTrace, getActiveInvocation, type InvocationTrace, type TraceCompletion } from '../tracing/invocation'
import { createRpcSession, type RpcSession } from './rpc-session'
import { createRpcFunctionStub, makeBindingProxy, type RpcExecutionScope, wrapRpcReturnValue } from './rpc-stub'
import type { WorkerCacheApi } from './worker-cache'

export interface DispatchExecutionContext {
	readonly props: Record<string, unknown>
	readonly cache: WorkerCacheApi
	exports: Record<string, unknown>
	waitUntil(promise: Promise<unknown>): void
	passThroughOnException(): void
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isWorkerResponse(value: unknown): value is Response {
	let constructor: unknown = Response
	while (typeof constructor === 'function' && constructor.prototype) {
		if (value instanceof constructor) return true
		constructor = Object.getPrototypeOf(constructor)
	}
	return false
}

export function toRequest(input: Request | string | URL, init?: RequestInit): Request {
	if (input instanceof Request) return init ? new Request(input, init) : input
	return new Request(input instanceof URL ? input.href : input, init)
}

type ContextFactory = (props?: Record<string, unknown>) => DispatchExecutionContext
const dispatchers = new WeakMap<object, WeakMap<object, WorkerDispatcher>>()

export function getWorkerDispatcher(module: object, env: object): WorkerDispatcher | undefined {
	return dispatchers.get(module)?.get(env)
}

type CloneableResponse = Pick<Response, 'url' | 'redirected' | 'type' | 'clone'>

function preserveResponseMetadata<T extends CloneableResponse>(response: T, original: CloneableResponse): T {
	const clone = response.clone
	// Native prototype getters/clone bypass these own properties; public constructors cannot restore their internal metadata.
	Object.defineProperties(response, {
		url: { value: original.url, configurable: true, enumerable: true },
		redirected: { value: original.redirected, configurable: true, enumerable: true },
		type: { value: original.type, configurable: true, enumerable: true },
		clone: {
			configurable: true,
			writable: true,
			value: function(this: CloneableResponse): ReturnType<Response['clone']> {
				return preserveResponseMetadata(clone.call(this), this)
			},
		},
	})
	return response
}

export function trackInvocationResponse(response: Response, invocation: InvocationTrace, context?: DispatchExecutionContext): Response {
	if (!response.body || response.status === 0 || response.status === 101) return response
	const release = invocation.retain('response-body')
	const compatibility = getActiveCompatibility()
	const run = <T>(callback: () => T): T =>
		runWithCompatibility(compatibility, () => invocation.run(() => context ? runWithExecutionContext(context, callback) : callback()))
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
	const body = response.body
	let cancelling = false
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			return run(async () => {
				try {
					reader ??= body.getReader()
					const result = await reader.read()
					if (cancelling) return
					if (result.done) {
						controller.close()
						reader.releaseLock()
						release()
					} else controller.enqueue(result.value)
				} catch (error) {
					if (cancelling) return
					controller.error(error)
					reader?.releaseLock()
					release({ kind: 'error', error })
				}
			})
		},
		cancel(reason) {
			cancelling = true
			return run(async () => {
				try {
					if (reader) await reader.cancel(reason)
					else await body.cancel(reason)
					release({ kind: 'cancelled', reason: String(reason ?? 'Response cancelled') })
				} catch (error) {
					release({ kind: 'error', error })
					throw error
				} finally {
					reader?.releaseLock()
				}
			})
		},
	}, { highWaterMark: 0 })
	try {
		return preserveResponseMetadata(
			new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers }),
			response,
		)
	} catch (error) {
		release({ kind: 'error', error })
		throw error
	}
}

export class WorkerDispatcher {
	private attachedContexts = new WeakSet<DispatchExecutionContext>()
	private invocations = new Set<InvocationTrace>()
	private rpcSessions = new Set<RpcSession>()
	private rpcSessionOwners = new WeakMap<InvocationTrace, Set<RpcSession>>()
	constructor(
		private module: Record<string, unknown>,
		private env: Record<string, unknown>,
		private createContext: ContextFactory,
		readonly compatibility: CompatibilitySelection = legacyCompatibility,
		private legacyFetch?: (request: Request, ctx: DispatchExecutionContext) => Promise<Response>,
	) {
		let environments = dispatchers.get(module)
		if (!environments) {
			environments = new WeakMap()
			dispatchers.set(module, environments)
		}
		environments.set(env, this)
	}

	terminateInvocations(reason: string): void {
		for (const invocation of this.invocations) invocation.terminate(reason)
		for (const session of this.rpcSessions) session.close()
	}

	private trackInvocation(invocation: InvocationTrace): InvocationTrace {
		this.invocations.add(invocation)
		void invocation.completed.then(() => this.invocations.delete(invocation))
		return invocation
	}

	context(props?: Record<string, unknown>): DispatchExecutionContext {
		return this.attachContext(this.createContext(props))
	}

	attachContext(ctx: DispatchExecutionContext): DispatchExecutionContext {
		const parent = getActiveExecutionContext()
		if (parent && parent !== ctx && !this.attachedContexts.has(ctx)) {
			const waitUntil = ctx.waitUntil.bind(ctx)
			ctx.waitUntil = promise => {
				waitUntil(promise)
				parent.waitUntil(Promise.resolve(promise).catch(() => {}))
			}
		}
		this.attachedContexts.add(ctx)
		ctx.exports = this.loopbacks()
		return ctx
	}

	async fetch(
		request: Request,
		entrypoint = 'default',
		props?: Record<string, unknown>,
		context?: DispatchExecutionContext,
	): Promise<Response> {
		return runWithCompatibility(this.compatibility, () => this.fetchInScope(request, entrypoint, props, context))
	}

	private async fetchInScope(
		request: Request,
		entrypoint: string,
		props: Record<string, unknown> | undefined,
		context: DispatchExecutionContext | undefined,
	): Promise<Response> {
		if (!context) {
			const invocation = this.trackInvocation(createInvocationTrace({ name: `${request.method} ${new URL(request.url).pathname}`, kind: 'server' }))
			return invocation.run(async () => {
				try {
					const ctx = this.context(props)
					const response = trackInvocationResponse(await this.fetch(request, entrypoint, props, ctx), invocation, ctx)
					invocation.root.setAttribute('http.status_code', response.status)
					invocation.finishHandler(response.status >= 500 ? { kind: 'error', error: new Error(`HTTP ${response.status}`) } : undefined)
					return response
				} catch (error) {
					invocation.finishHandler({ kind: 'error', error })
					throw error
				}
			})
		}
		const ctx = this.attachContext(context)
		return runWithExecutionContext(ctx, async () => {
			const handler = resolveEntrypointHandler(this.module[entrypoint], 'fetch', ctx, this.env)
			if (!handler && entrypoint === 'default' && this.legacyFetch) return this.legacyFetch(request, ctx)
			if (!handler) throw new Error(`Entrypoint "${entrypoint}" does not export a fetch handler`)
			const response = await handler(request, this.env, ctx)
			if (!isWorkerResponse(response)) throw new TypeError('Worker fetch must return a Response')
			return response
		})
	}

	private loopbacks(): Record<string, unknown> {
		const exports: Record<string, unknown> = {}
		for (const [name, value] of Object.entries(this.module)) {
			if (typeof value !== 'function' || !value.prototype || !(Symbol.for('lopata.WorkerEntrypoint') in value.prototype)) continue
			const binding = (props?: Record<string, unknown>): Record<string, unknown> =>
				makeBindingProxy({
					fetch: (input, init) => this.fetch(toRequest(input, init), name, init && 'props' in init && record(init.props) ? init.props : props),
					call: async (method, args) => {
						warnInvalidRpcArgs(args, method)
						return this.rpc(name, method, args, props)
					},
					getProperty: property => this.property(name, property, props),
				})
			const defaultBinding = binding()
			exports[name] = new Proxy((options?: { props?: Record<string, unknown> }) => binding(options?.props), {
				get: (_target, property) => typeof property === 'string' ? defaultBinding[property] : undefined,
			})
		}
		return exports
	}

	async rpc(
		entrypoint: string | undefined,
		method: string,
		args: unknown[],
		props?: Record<string, unknown>,
		context?: DispatchExecutionContext,
	): Promise<unknown> {
		const name = entrypoint ?? 'default'
		return this.invokeRpc(
			name,
			method,
			async (ctx, scope) => {
				const value = this.module[name]
				const target: unknown = typeof value === 'function' ? Reflect.construct(value, [ctx, this.env]) : value
				if (!record(target) || typeof target[method] !== 'function') throw new Error(`Entrypoint "${name}" has no RPC method "${method}"`)
				return wrapRpcReturnValue(await Reflect.apply(target[method], target, args), method, scope)
			},
			props,
			context,
		)
	}

	async property(
		entrypoint: string | undefined,
		property: string,
		props?: Record<string, unknown>,
		context?: DispatchExecutionContext,
	): Promise<unknown> {
		const name = entrypoint ?? 'default'
		return this.invokeRpc(
			name,
			property,
			async (ctx, scope) => {
				const value = this.module[name]
				const target: unknown = typeof value === 'function' ? Reflect.construct(value, [ctx, this.env]) : value
				if (!record(target)) throw new Error('Invalid WorkerEntrypoint instance')
				const member = target[property]
				if (typeof member === 'function') {
					return createRpcFunctionStub(member, target, scope)
				}
				return wrapRpcReturnValue(await member, property, scope)
			},
			props,
			context,
		)
	}

	private rpcSession(ctx: DispatchExecutionContext, invocation?: InvocationTrace, caller?: InvocationTrace): RpcSession {
		const owners = new Set([invocation, caller].filter(owner => owner !== undefined))
		const session = createRpcSession({
			run: callback =>
				runWithCompatibility(this.compatibility, () =>
					invocation
						? invocation.run(() => runWithExecutionContext(ctx, callback))
						: runWithExecutionContext(ctx, callback)),
			retain: () => {
				const release = invocation?.retain('handler')
				return () => {
					this.rpcSessions.delete(session)
					for (const owner of owners) this.rpcSessionOwners.get(owner)?.delete(session)
					release?.()
				}
			},
			isClosed: () => invocation?.closed === true || caller?.closed === true,
		})
		this.rpcSessions.add(session)
		for (const owner of owners) {
			let sessions = this.rpcSessionOwners.get(owner)
			if (!sessions) {
				sessions = new Set<RpcSession>()
				this.rpcSessionOwners.set(owner, sessions)
				const ownedSessions = sessions
				void owner.completed.then(() => {
					for (const owned of ownedSessions) owned.close()
					ownedSessions.clear()
				})
			}
			sessions.add(session)
		}
		return session
	}

	private async invokeRpc(
		name: string,
		method: string,
		callback: (ctx: DispatchExecutionContext, scope: RpcExecutionScope) => Promise<unknown>,
		props?: Record<string, unknown>,
		context?: DispatchExecutionContext,
	): Promise<unknown> {
		const caller = context ? undefined : getActiveInvocation()
		const invocation = context ? getActiveInvocation() : this.trackInvocation(createInvocationTrace({ name: `rpc ${name}.${method}`, kind: 'server' }))
		const run = async () => {
			let session: RpcSession | undefined
			let completion: TraceCompletion = { kind: 'complete' }
			try {
				const ctx = context ? this.attachContext(context) : this.context(props)
				session = this.rpcSession(ctx, invocation, caller)
				const scope = session
				return await scope.run(() => callback(ctx, scope))
			} catch (error) {
				completion = { kind: 'error', error }
				session?.close()
				throw error
			} finally {
				session?.finish()
				if (!context) invocation?.finishHandler(completion)
			}
		}
		return runWithCompatibility(this.compatibility, () => invocation ? invocation.run(run) : run())
	}
}

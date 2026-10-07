import type { CompatibilitySelection } from '../compatibility'
import { legacyCompatibility, runWithCompatibility } from '../compatibility-context'
import { resolveEntrypointHandler } from '../entrypoint-handler'
import { getActiveExecutionContext, runWithExecutionContext } from '../execution-context'
import { warnInvalidRpcArgs } from '../rpc-validate'
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

export class WorkerDispatcher {
	private attachedContexts = new WeakSet<DispatchExecutionContext>()
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
		const ctx = context ? this.attachContext(context) : this.context(props)
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

	private async invokeRpc(
		callback: (ctx: DispatchExecutionContext, scope: RpcExecutionScope) => Promise<unknown>,
		props?: Record<string, unknown>,
		context?: DispatchExecutionContext,
	): Promise<unknown> {
		const ctx = context ? this.attachContext(context) : this.context(props)
		const scope: RpcExecutionScope = {
			run: callback => runWithCompatibility(this.compatibility, () => runWithExecutionContext(ctx, callback)),
		}
		return scope.run(() => callback(ctx, scope))
	}
}

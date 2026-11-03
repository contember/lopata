import { describe, expect, test } from 'bun:test'
import { WorkerEntrypoint } from 'cloudflare:workers'
import { ServiceBinding } from '../src/bindings/service-binding'
import { WorkerDispatcher } from '../src/bindings/worker-dispatcher'
import { legacyCompatibility } from '../src/compatibility-context'
import { ExecutionContext } from '../src/execution-context'

// workerd calls a handler object's RPC method as (arg, env, ctx) and rejects any other shape
// (workerd `api/tests/js-rpc-test.js`, `basicServiceBinding`). Class entrypoints keep the caller's arguments.

const ARITY_ERROR = 'Cannot call handler function "twoArgs" over RPC because it has the wrong number of arguments. '
	+ 'A simple function handler can only be called over RPC if it has exactly the arguments (arg, env, ctx), where only the first '
	+ 'argument comes from the client. To support multi-argument RPC functions, use class-based syntax (extending WorkerEntrypoint) instead.'

function argumentCountError(name: string): string {
	return `Attempted to call RPC function "${name}" with the wrong number of arguments. When calling a top-level handler function `
		+ 'that is not declared as part of a class, you must always send exactly one argument. In order to support variable numbers '
		+ 'of arguments, the server must use class-based syntax (extending WorkerEntrypoint) instead.'
}

type Env = { FACTOR: number }

function createModule(): Record<string, unknown> {
	return {
		default: {
			fetch: () => new Response('ok'),
			async oneArg(i: number, env: Env, ctx: ExecutionContext) {
				return { value: i * env.FACTOR, props: ctx.props }
			},
			async oneArgOmitCtx(i: number, env: Env) {
				return i * env.FACTOR + 1
			},
			async oneArgOmitEnvCtx(i: number) {
				return i * 2
			},
			async twoArgs(i: number, j: number, _env: Env, _ctx: ExecutionContext) {
				return i * j
			},
			async noArgs(_x: unknown, _env: Env, _ctx: ExecutionContext) {
				return 13
			},
		},
		Api: class extends WorkerEntrypoint<Env> {
			twoArgsMethod(i: number, j: number) {
				return i * j + this.env.FACTOR
			}
		},
	}
}

async function call(binding: ServiceBinding, method: string, ...args: unknown[]): Promise<unknown> {
	const fn: unknown = Reflect.get(binding.toProxy(), method)
	if (typeof fn !== 'function') throw new Error(`Missing RPC method: ${method}`)
	return Reflect.apply(fn, undefined, args)
}

const routes: Array<[string, (module: Record<string, unknown>, env: Env, entrypoint?: string) => ServiceBinding]> = [
	['the shared dispatcher', (module, env, entrypoint) => {
		// Constructing a dispatcher registers it for service bindings to the same module and env.
		new WorkerDispatcher(module, env, props => new ExecutionContext(props), legacyCompatibility)
		const binding = new ServiceBinding('svc', entrypoint, undefined, { tenant: 'a' })
		binding._wire(() => ({ kind: 'in-process', workerModule: module, env, compatibility: legacyCompatibility }))
		return binding
	}],
	['the in-process fallback', (module, env, entrypoint) => {
		const binding = new ServiceBinding('svc', entrypoint, undefined, { tenant: 'a' })
		binding._wire(module, { FACTOR: env.FACTOR })
		return binding
	}],
]

describe.each(routes)('handler-object RPC through %s', (_route, bind) => {
	test('the method receives the one client argument, env and ctx', async () => {
		const binding = bind(createModule(), { FACTOR: 12 })
		expect(await call(binding, 'oneArg', 3)).toEqual({ value: 36, props: { tenant: 'a' } })
		expect(await call(binding, 'oneArgOmitCtx', 3)).toBe(37)
		expect(await call(binding, 'oneArgOmitEnvCtx', 3)).toBe(6)
	})

	test('other argument shapes fail with the workerd TypeErrors', async () => {
		const binding = bind(createModule(), { FACTOR: 12 })
		const failures: Array<[string, unknown[], string]> = [
			['twoArgs', [123, 2], ARITY_ERROR],
			['noArgs', [], argumentCountError('noArgs')],
			['oneArg', [1, 2], argumentCountError('oneArg')],
		]
		for (const [method, args, message] of failures) {
			let error: unknown
			try {
				await call(binding, method, ...args)
			} catch (e) {
				error = e
			}
			if (!(error instanceof TypeError)) throw new Error(`expected a TypeError from ${method}`)
			expect(error.message).toBe(message)
		}
	})

	test('a class entrypoint keeps the caller arguments', async () => {
		const binding = bind(createModule(), { FACTOR: 12 }, 'Api')
		expect(await call(binding, 'twoArgsMethod', 123, 2)).toBe(258)
	})
})

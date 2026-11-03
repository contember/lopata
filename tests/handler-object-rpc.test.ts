import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { WorkerEntrypoint } from 'cloudflare:workers'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ServiceBinding } from '../src/bindings/service-binding'
import { WorkerDispatcher } from '../src/bindings/worker-dispatcher'
import { legacyCompatibility } from '../src/compatibility-context'
import type { WranglerConfig } from '../src/config'
import { ExecutionContext } from '../src/execution-context'
import { WorkerThreadExecutor } from '../src/worker-thread/executor'

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
		alternate: {
			greet(name: string, env: Env, ctx: ExecutionContext) {
				return `${String(ctx.props.tenant)}: ${name} x${env.FACTOR}`
			},
			fetch(_request: Request, env: Env, ctx: ExecutionContext) {
				return Response.json({ factor: env.FACTOR, props: ctx.props })
			},
		},
		inherited: Object.assign(
			Object.create({
				greet(name: string) {
					return name
				},
				get sideEffect() {
					getterReads++
					return () => 'inherited getter'
				},
			}),
			{ fetch: () => new Response('ok') },
		),
		// An own getter that removes itself still counts as an own method: ownership is checked before the read.
		selfDeleting: (selfDeleting = {
			get once() {
				delete selfDeleting.once
				return (arg: string, env: Env) => `${arg} x${env.FACTOR}`
			},
		}),
	}
}

let getterReads = 0
let selfDeleting: Record<string, unknown> = {}

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

	test('a named handler object is served with (arg, env, ctx)', async () => {
		const binding = bind(createModule(), { FACTOR: 12 }, 'alternate')
		expect(await call(binding, 'greet', 'Dave')).toBe('a: Dave x12')
	})

	test('a handler object exposes only its own methods, checked before the property is read', async () => {
		const binding = bind(createModule(), { FACTOR: 12 }, 'inherited')
		getterReads = 0
		for (const method of ['greet', 'sideEffect']) {
			let error: unknown
			try {
				await call(binding, method, 'Dave')
			} catch (e) {
				error = e
			}
			if (!(error instanceof TypeError)) throw new Error(`expected a TypeError from ${method}`)
			expect(error.message).toBe(`The RPC receiver does not implement the method "${method}".`)
		}
		expect(getterReads).toBe(0)
		expect(await call(bind(createModule(), { FACTOR: 12 }, 'selfDeleting'), 'once', 'x')).toBe('x x12')
	})

	test("a named handler object's fetch gets (request, env, ctx)", async () => {
		const binding = bind(createModule(), { FACTOR: 12 }, 'alternate')
		expect(await (await binding.fetch('http://svc/')).json()).toEqual({ factor: 12, props: { tenant: 'a' } })
	})

	test('a class entrypoint keeps the caller arguments', async () => {
		const binding = bind(createModule(), { FACTOR: 12 }, 'Api')
		expect(await call(binding, 'twoArgsMethod', 123, 2)).toBe(258)
	})
})

describe('handler-object RPC through a worker thread', () => {
	let directory: string
	let executor: WorkerThreadExecutor
	let binding: ServiceBinding

	beforeAll(async () => {
		directory = mkdtempSync(join(tmpdir(), 'lopata-handler-rpc-'))
		writeFileSync(
			join(directory, 'worker.js'),
			`export default {
				fetch() { return new Response('ok') },
				oneArg(i, env, ctx) { return { value: i * Number(env.FACTOR), props: ctx.props } },
				pair(...args) { return args },
			}
			export const alternate = {
				greet(name, env, ctx) { return ctx.props.tenant + ': ' + name + ' x' + env.FACTOR },
			}`,
		)
		const config: WranglerConfig = { name: 'handler-rpc', main: 'worker.js', vars: { FACTOR: '12' } }
		executor = new WorkerThreadExecutor({ modulePath: join(directory, 'worker.js'), config, baseDir: directory, mainEnv: {} })
		await executor.ready()
		binding = new ServiceBinding('svc', undefined, undefined, { tenant: 'a' })
		binding._wire(() => ({ kind: 'thread', env: {}, executor }))
	})

	afterAll(() => {
		executor.dispose()
		rmSync(directory, { recursive: true, force: true })
	})

	test('a method call gets (arg, env, ctx) and rejects a second argument', async () => {
		expect(await call(binding, 'oneArg', 3)).toEqual({ value: 36, props: { tenant: 'a' } })
		let error: unknown
		try {
			await call(binding, 'pair', 'x', 'y')
		} catch (e) {
			error = e
		}
		if (!(error instanceof Error)) throw new Error(`expected an error, got ${String(error)}`)
		expect({ name: error.name, message: error.message }).toEqual({ name: 'TypeError', message: argumentCountError('pair') })
	})

	test('a named handler object is served across the thread', async () => {
		const named = new ServiceBinding('svc', 'alternate', undefined, { tenant: 'b' })
		named._wire(() => ({ kind: 'thread', env: {}, executor }))
		expect(await call(named, 'greet', 'Eve')).toBe('b: Eve x12')
	})

	test('a function read as a property keeps the caller arguments', async () => {
		const fn: unknown = await Reflect.get(binding.toProxy(), 'pair')
		if (typeof fn !== 'function') throw new Error('expected a function stub')
		expect(await fn()).toEqual([])
		expect(await fn('x')).toEqual(['x'])
		expect(await fn('x', 'y')).toEqual(['x', 'y'])
	})
})

describe('handler-object RPC through the in-process fallback, export edge cases', () => {
	test('an empty entrypoint name serves the default handler object under the same rule', async () => {
		const binding = new ServiceBinding('svc', '')
		binding._wire(createModule(), { FACTOR: 12 })
		expect(await call(binding, 'oneArgOmitCtx', 3)).toBe(37)
		await expect(call(binding, 'oneArg', 1, 2)).rejects.toThrow(argumentCountError('oneArg'))
	})

	test('a callable export is not a handler object and keeps the caller arguments', async () => {
		const binding = new ServiceBinding('svc')
		binding._wire({ default: Object.assign(() => new Response('ok'), { pair: (...args: unknown[]) => args }) }, { FACTOR: 12 })
		expect(await call(binding, 'pair', 'x', 'y')).toEqual(['x', 'y'])
	})
})

import { describe, expect, test } from 'bun:test'
import { constructEntrypoint, handlerFromInstance, isClassEntrypoint, resolveEntrypointHandler } from '../src/entrypoint-handler'

/**
 * The one resolver behind all three dispatch paths — CLI worker thread, Vite dev server
 * and the test harness — so the shapes a worker can legally be written in are accepted
 * identically everywhere.
 */

const ctx = { waitUntil() {} }
const env = { GREETING: 'ahoj' }

describe('resolveEntrypointHandler', () => {
	test('object export: handler is bound to the object, and takes (…, env, ctx)', async () => {
		const worker = {
			self: 'the-object',
			async scheduled(this: any, controller: any, e: any, c: any) {
				return { self: this.self, cron: controller.cron, greeting: e.GREETING, hasCtx: c === ctx }
			},
		}

		const handler = resolveEntrypointHandler(worker, 'scheduled', ctx, env)
		expect(await handler!({ cron: '* * * * *' }, env, ctx)).toEqual({
			self: 'the-object',
			cron: '* * * * *',
			greeting: 'ahoj',
			hasCtx: true,
		})
	})

	test('class export: prototype method runs on an instance built with (ctx, env)', async () => {
		class Entrypoint {
			constructor(readonly ctx: any, readonly env: any) {}
			async scheduled(controller: any) {
				return { greeting: this.env.GREETING, hasCtx: this.ctx === ctx, cron: controller.cron }
			}
		}

		const handler = resolveEntrypointHandler(Entrypoint, 'scheduled', ctx, env)
		expect(await handler!({ cron: '@daily' }, env, ctx)).toEqual({ greeting: 'ahoj', hasCtx: true, cron: '@daily' })
	})

	// The reason this constructs before inspecting: a field initialiser does not exist on
	// the prototype, only on a built instance. workerd accepts this shape.
	test('class export: handler declared as an instance field also resolves', async () => {
		class Entrypoint {
			constructor(readonly ctx: any, readonly env: any) {}
			email = async (message: any) => ({ from: message.from, greeting: this.env.GREETING })
		}

		const handler = resolveEntrypointHandler(Entrypoint, 'email', ctx, env)
		expect(await handler!({ from: 'a@example.com' }, env, ctx)).toEqual({ from: 'a@example.com', greeting: 'ahoj' })
	})

	test('missing handler resolves to null for both shapes', () => {
		class Bare {
			constructor(readonly ctx: any, readonly env: any) {}
		}

		expect(resolveEntrypointHandler({ fetch() {} }, 'scheduled', ctx, env)).toBeNull()
		expect(resolveEntrypointHandler(Bare, 'scheduled', ctx, env)).toBeNull()
		expect(resolveEntrypointHandler(undefined, 'fetch', ctx, env)).toBeNull()
		expect(resolveEntrypointHandler({ fetch: 'not a function' }, 'fetch', ctx, env)).toBeNull()
	})

	test('a class handler ignores the trailing (env, ctx) arguments callers pass', async () => {
		class Entrypoint {
			constructor(readonly ctx: any, readonly env: any) {}
			async fetch(request: Request) {
				return new Response(`${request.url}|${this.env.GREETING}`)
			}
		}

		// One calling convention for both shapes — the extra args are simply unused here.
		const handler = resolveEntrypointHandler(Entrypoint, 'fetch', ctx, env)
		const res = await handler!(new Request('http://localhost/x'), env, ctx) as Response
		expect(await res.text()).toBe('http://localhost/x|ahoj')
	})
})

describe('isClassEntrypoint', () => {
	test('separates class exports from handler objects', () => {
		expect(isClassEntrypoint(class {})).toBe(true)
		expect(isClassEntrypoint(function named() {})).toBe(true)
		expect(isClassEntrypoint({ fetch() {} })).toBe(false)
		expect(isClassEntrypoint(() => {})).toBe(false) // arrow functions have no prototype
		expect(isClassEntrypoint(undefined)).toBe(false)
	})
})

describe('constructEntrypoint / handlerFromInstance', () => {
	// Callers that need several handlers from one invocation reuse the instance rather
	// than constructing repeatedly, since a constructor can run user code.
	test('an instance can be built once and probed for several handlers', async () => {
		let constructed = 0
		class Entrypoint {
			constructor(readonly ctx: any, readonly env: any) {
				constructed++
			}
			async fetch() {
				return 'fetched'
			}
			scheduled = async () => 'ticked'
		}

		const instance = constructEntrypoint(Entrypoint, ctx, env)
		expect(constructed).toBe(1)
		expect(await handlerFromInstance(instance, 'fetch')!()).toBe('fetched')
		expect(await handlerFromInstance(instance, 'scheduled')!()).toBe('ticked')
		expect(handlerFromInstance(instance, 'queue')).toBeNull()
		expect(constructed).toBe(1)
	})
})

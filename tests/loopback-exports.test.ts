import { afterEach, describe, expect, test } from 'bun:test'
import { DurableObject, exports as importedExports, WorkerEntrypoint, WorkflowEntrypoint } from 'cloudflare:workers'
import type { TestEnv } from '../src/testing'
import { createTestEnv } from '../src/testing'

let t: TestEnv | null = null

afterEach(() => {
	t?.dispose()
	t = null
})

class Greeter extends WorkerEntrypoint {
	greet(name: string): string {
		return `${this.ctx.props.prefix ?? 'hi'} ${name}`
	}

	async fetch(request: Request): Promise<Response> {
		return Response.json({ path: new URL(request.url).pathname, props: this.ctx.props })
	}
}

class Counter extends DurableObject {
	async viaLoopback(): Promise<string> {
		return this.ctx.exports.Greeter({ props: { prefix: 'from-do' } }).greet('counter')
	}
}

class Unconfigured extends DurableObject {}

class Flow extends WorkflowEntrypoint {
	override async run(): Promise<void> {}
}

const handlers = {
	async fetch(request: Request, env: any, ctx: any): Promise<Response> {
		const url = new URL(request.url)
		if (url.pathname === '/keys') return Response.json(Object.keys(ctx.exports).sort())
		if (url.pathname === '/props') {
			const props = { prefix: 'hello' }
			const stub = ctx.exports.Greeter({ props })
			props.prefix = 'mutated'
			return new Response(await stub.greet('world'))
		}
		if (url.pathname === '/no-props') return ctx.exports.Greeter.fetch('http://greeter/plain')
		if (url.pathname === '/imported') return new Response(await importedExports.Greeter({ props: { prefix: 'imported' } }).greet('x'))
		if (url.pathname === '/namespace') return new Response(String(ctx.exports.Counter === env.COUNTER))
		if (url.pathname === '/do') return new Response(await env.COUNTER.getByName('a').viaLoopback())
		if (url.pathname === '/default') return new Response('default handler')
		return ctx.exports.default.fetch('http://self/default')
	},
}

async function setup(): Promise<TestEnv> {
	return createTestEnv({
		worker: { default: handlers, Greeter, Counter, Unconfigured, Flow, VERSION: 3 },
		bindings: {
			COUNTER: { type: 'durable-object', className: 'Counter' },
			FLOW: { type: 'workflow', className: 'Flow' },
		},
	})
}

describe('ctx.exports', () => {
	test('lists entrypoints and configured Durable Object namespaces, not Workflows or storage-less classes', async () => {
		t = await setup()
		expect(await (await t.fetch('/keys')).json()).toEqual(['Counter', 'Greeter', 'default'])
	})

	test('a loopback specialized with props exposes them as ctx.props, copied at specialization', async () => {
		t = await setup()
		expect(await (await t.fetch('/props')).text()).toBe('hello world')
	})

	test('an unspecialized loopback is a Fetcher with empty props', async () => {
		t = await setup()
		expect(await (await t.fetch('/no-props')).json()).toEqual({ path: '/plain', props: {} })
	})

	test('the default export is reachable as ctx.exports.default', async () => {
		t = await setup()
		expect(await (await t.fetch('/')).text()).toBe('default handler')
	})

	test("import { exports } from 'cloudflare:workers' resolves the same loopbacks", async () => {
		t = await setup()
		expect(await (await t.fetch('/imported')).text()).toBe('imported x')
	})

	test('a configured Durable Object class maps to its namespace', async () => {
		t = await setup()
		expect(await (await t.fetch('/namespace')).text()).toBe('true')
	})

	test('a Durable Object reaches the loopbacks through its own ctx.exports', async () => {
		t = await setup()
		expect(await (await t.fetch('/do')).text()).toBe('from-do counter')
	})
})

export class Counter {
	state: any
	value = 0

	constructor(state: any) {
		this.state = state
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)
		if (url.pathname === '/inc') {
			const stored = (await this.state.storage.get('value')) as number | undefined
			this.value = (stored ?? 0) + 1
			await this.state.storage.put('value', this.value)
			return new Response(String(this.value))
		}
		if (url.pathname === '/get') {
			const stored = (await this.state.storage.get('value')) as number | undefined
			return new Response(String(stored ?? 0))
		}
		if (url.pathname === '/name') {
			return new Response(String(this.state.id.name ?? ''))
		}
		return new Response('not found', { status: 404 })
	}

	async greet(name: string): Promise<string> {
		return `hello ${name} from ${(this.state.id as any).toString().slice(0, 8)}`
	}
}

export default {
	async fetch(request: Request, env: any): Promise<Response> {
		const url = new URL(request.url)

		if (url.pathname.startsWith('/counter/')) {
			const name = url.pathname.split('/')[2] ?? 'default'
			const action = url.pathname.split('/')[3] ?? 'get'
			const id = env.COUNTER.idFromName(name)
			const stub = env.COUNTER.get(id)
			const res = await stub.fetch(`http://do/${action}`)
			return new Response(`${name}:${await res.text()}`)
		}

		if (url.pathname.startsWith('/greet/')) {
			const name = url.pathname.split('/')[2] ?? 'anon'
			const stub = env.COUNTER.get(env.COUNTER.idFromName(name))
			const greeting = await stub.greet(name)
			return new Response(greeting)
		}

		// Drive N binding RPC calls within ONE top-level request so the
		// worker-side subrequest budget (shared per-request via
		// AsyncLocalStorage) can be exercised end-to-end.
		if (url.pathname === '/spam-rpc') {
			const n = Number(url.searchParams.get('n') ?? '0')
			const stub = env.COUNTER.get(env.COUNTER.idFromName('spam'))
			try {
				for (let i = 0; i < n; i++) await stub.greet('x')
				return new Response('ok')
			} catch (e: any) {
				return new Response(`error: ${e?.message ?? e}`, { status: 500 })
			}
		}

		return new Response('not found', { status: 404 })
	},
}

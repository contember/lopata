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
		if (url.pathname === '/echo') {
			// Reads the forwarded request BODY across the worker → main → DO-worker
			// bridge. Regression guard: a Worker that re-wraps its incoming request via
			// `new Request(request, { headers })` to forward it used to deadlock here
			// (Bun's Request clone hangs on a JS ReadableStream body).
			const data = await request.json()
			return Response.json({ echoed: data })
		}
		if (url.pathname === '/cookies') {
			// Two Set-Cookie headers — regression guard for header serialization
			// across the DO-worker → main bridge folding them into one value.
			const headers = new Headers()
			headers.append('set-cookie', 'a=1; Path=/')
			headers.append('set-cookie', 'b=2; Path=/; HttpOnly')
			return new Response('cookies', { headers })
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

		// Forward the incoming POST to the DO by RE-WRAPPING the incoming request via
		// `new Request(request, { headers })` — the idiomatic proxy-to-DO pattern, and
		// the case that used to deadlock the DO's `await request.json()`. The DO
		// response is returned directly.
		if (url.pathname === '/echo') {
			const stub = env.COUNTER.get(env.COUNTER.idFromName('echo'))
			const headers = new Headers(request.headers)
			headers.set('x-forwarded-by', 'worker')
			return stub.fetch(new Request(request, { headers }))
		}

		// Forward the DO response (carrying two Set-Cookie headers) directly to the
		// caller so the test can assert they survive both bridge hops un-folded.
		if (url.pathname === '/cookies') {
			const stub = env.COUNTER.get(env.COUNTER.idFromName('cookies'))
			return stub.fetch('http://do/cookies')
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

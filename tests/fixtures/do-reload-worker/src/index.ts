// Bump this marker to force a (successful) reload: vA
export class Thing {
	state: any
	constructor(state: any) {
		this.state = state
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)
		if (url.pathname === '/inc') {
			const next = (((await this.state.storage.get('n')) as number | undefined) ?? 0) + 1
			await this.state.storage.put('n', next)
			return new Response(String(next))
		}
		if (url.pathname === '/get') {
			return new Response(String((await this.state.storage.get('n')) ?? 0))
		}
		if (url.pathname === '/set-alarm') {
			await this.state.storage.put('fired', false)
			await this.state.storage.setAlarm(Date.now() + 1500)
			return new Response('set')
		}
		if (url.pathname === '/fired') {
			return new Response(String((await this.state.storage.get('fired')) ?? false))
		}
		return new Response('not found', { status: 404 })
	}

	async alarm(): Promise<void> {
		await this.state.storage.put('fired', true)
	}
}

export default {
	async fetch(request: Request, env: any): Promise<Response> {
		const url = new URL(request.url)
		if (url.pathname === '/ping') return new Response('pong')
		const stub = env.DO.get(env.DO.idFromName('singleton'))
		return stub.fetch(request)
	},
}

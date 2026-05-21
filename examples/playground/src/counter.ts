import { DurableObject } from 'cloudflare:workers'

export class Counter extends DurableObject<Env> {
	private subscribers: WebSocket[] = []

	async getCount(): Promise<number> {
		return (await this.ctx.storage.get<number>('count')) ?? 0
	}

	override async alarm(): Promise<void> {
		console.log('Alarm triggered! Current count:', await this.getCount())
	}

	async increment(): Promise<number> {
		const count = (await this.getCount()) + 1
		await this.ctx.storage.put('count', count)
		this.broadcast(count)
		return count
	}

	async decrement(): Promise<number> {
		const count = (await this.getCount()) - 1
		await this.ctx.storage.put('count', count)
		this.broadcast(count)
		return count
	}

	async reset(): Promise<void> {
		await this.ctx.storage.delete('count')
		this.broadcast(0)
	}

	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade') !== 'websocket') {
			return new Response('Expected websocket', { status: 426 })
		}
		const pair = new WebSocketPair()
		const [client, server] = Object.values(pair)
		server.accept()
		this.subscribers.push(server)

		// Send the current count so a fresh client sees state immediately.
		server.send(JSON.stringify({ type: 'count', value: await this.getCount() }))

		server.addEventListener('message', async (event: MessageEvent) => {
			const msg = typeof event.data === 'string' ? event.data : ''
			if (msg === 'inc') await this.increment()
			else if (msg === 'dec') await this.decrement()
			else if (msg === 'reset') await this.reset()
		})

		server.addEventListener('close', () => {
			this.subscribers = this.subscribers.filter(ws => ws !== server)
		})

		return new Response(null, { status: 101, webSocket: client } as any)
	}

	private broadcast(value: number): void {
		const payload = JSON.stringify({ type: 'count', value })
		for (const ws of this.subscribers) ws.send(payload)
	}
}

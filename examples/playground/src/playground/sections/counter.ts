import { registerSection } from '../registry'

registerSection({
	slug: 'counter',
	title: 'Durable Object — Counter',
	html: `
  <form onsubmit="api('GET','/counter/'+formVal('do-name'));return false">
    <label>Name <input id="do-name" value="my-counter"></label>
    <button type="submit" class="secondary">GET count</button>
    <button type="button" onclick="api('POST','/counter/'+formVal('do-name')+'/increment')">INCREMENT</button>
    <button type="button" onclick="api('POST','/counter/'+formVal('do-name')+'/decrement')">DECREMENT</button>
    <button type="button" class="danger" onclick="api('POST','/counter/'+formVal('do-name')+'/reset')">RESET</button>
  </form>
  `,
	async handle(request, env) {
		const url = new URL(request.url)
		const path = url.pathname
		const method = request.method
		const counterMatch = path.match(/^\/counter\/([^/]+)(\/(.+))?$/)
		if (!counterMatch) return null
		// Avoid colliding with the /ws/counter/* WebSocket route (handled in websocket section).
		if (path.startsWith('/ws/')) return null

		const name = decodeURIComponent(counterMatch[1]!)
		const action = counterMatch[3]
		const id = env.COUNTER.idFromName(name)
		const stub = env.COUNTER.get(id)

		if (!action && method === 'GET') {
			const count = await stub.getCount()
			return Response.json({ name, count })
		}
		if (action === 'increment' && method === 'POST') {
			const count = await stub.increment()
			return Response.json({ name, count })
		}
		if (action === 'decrement' && method === 'POST') {
			const count = await stub.decrement()
			return Response.json({ name, count })
		}
		if (action === 'reset' && method === 'POST') {
			await stub.reset()
			return Response.json({ name, count: 0 })
		}
		return null
	},
})

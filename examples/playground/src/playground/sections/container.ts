import { registerSection } from '../registry'

registerSection({
	slug: 'container',
	title: 'Container',
	html: `
  <div class="links">
    <a href="#" onclick="api('GET','/container/status');return false">GET status</a>
    <a href="#" onclick="api('POST','/container/start');return false">Start</a>
    <a href="#" onclick="api('POST','/container/stop');return false">Stop</a>
  </div>
  <form onsubmit="api('POST','/container/fetch',formVal('ctr-path'));return false">
    <label>Path <input id="ctr-path" value="/"></label>
    <button type="submit" class="secondary">Fetch container</button>
  </form>
  `,
	async handle(request, env) {
		const url = new URL(request.url)
		const path = url.pathname
		const method = request.method

		if (!path.startsWith('/container')) return null
		const id = env.MY_CONTAINER.idFromName('singleton')
		const stub = env.MY_CONTAINER.get(id)

		if (path === '/container/status' && method === 'GET') {
			const state = await stub.getState()
			return Response.json(state)
		}
		if (path === '/container/start' && method === 'POST') {
			stub.start()
			return Response.json({ success: true })
		}
		if (path === '/container/stop' && method === 'POST') {
			await stub.stop()
			return Response.json({ success: true })
		}
		if (path === '/container/fetch' && method === 'POST') {
			const targetPath = await request.text() || '/'
			const res = await stub.fetch(new Request(`http://container${targetPath}`))
			return new Response(await res.text(), {
				status: res.status,
				headers: res.headers,
			})
		}
		return null
	},
})

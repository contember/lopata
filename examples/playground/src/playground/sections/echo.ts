import { registerSection } from '../registry'

registerSection({
	slug: 'echo',
	title: 'Echo Worker (Service Binding)',
	html: `
  <div class="links">
    <a href="#" onclick="api('GET','/echo');return false">Ping echo worker</a>
    <a href="#" onclick="api('GET','/echo/info');return false">RPC: info()</a>
  </div>
  <form onsubmit="api('GET','/echo/greet?name='+encodeURIComponent(formVal('echo-name')));return false">
    <label>Name <input id="echo-name" value="Lopata"></label>
    <button type="submit" class="secondary">RPC: greet(name)</button>
  </form>
  <form onsubmit="api('POST','/echo/fetch',formVal('echo-body'));return false">
    <label>Body <input id="echo-body" value="hello from main worker"></label>
    <button type="submit">Fetch echo worker</button>
  </form>
  `,
	async handle(request, env) {
		const url = new URL(request.url)
		const path = url.pathname
		const method = request.method

		if (path === '/echo' && method === 'GET') {
			const res = await env.ECHO.fetch(new Request('http://echo/ping'))
			return new Response(await res.text())
		}
		if (path === '/echo/fetch' && method === 'POST') {
			const res = await env.ECHO.fetch(new Request('http://echo/echo', { method: 'POST', body: await request.text() }))
			return res
		}
		if (path === '/echo/greet' && method === 'GET') {
			const name = url.searchParams.get('name') ?? 'world'
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const greeting = await (env.ECHO as any).greet(name)
			return Response.json({ greeting })
		}
		if (path === '/echo/info' && method === 'GET') {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const info = await (env.ECHO as any).info()
			return Response.json(info)
		}
		return null
	},
})

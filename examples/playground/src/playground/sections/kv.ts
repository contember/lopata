import { registerSection } from '../registry'

registerSection({
	slug: 'kv',
	title: 'KV Store',
	html: `
  <div class="links">
    <a href="#" onclick="api('GET','/kv/test-key');return false">GET /kv/test-key</a>
    <a href="#" onclick="api('GET','/kv?list=1');return false">LIST all keys</a>
  </div>
  <form onsubmit="api('PUT','/kv/'+formVal('kv-key'),formVal('kv-val'));return false">
    <label>Key <input id="kv-key" value="test-key"></label>
    <label>Value <input id="kv-val" value="hello world"></label>
    <button type="submit">PUT</button>
  </form>
  <form onsubmit="api('GET','/kv/'+formVal('kv-get-key'));return false">
    <label>Key <input id="kv-get-key" value="test-key"></label>
    <button type="submit" class="secondary">GET</button>
  </form>
  <form onsubmit="api('DELETE','/kv/'+formVal('kv-del-key'));return false">
    <label>Key <input id="kv-del-key" value="test-key"></label>
    <button type="submit" class="danger">DELETE</button>
  </form>
  `,
	async handle(request, env) {
		const url = new URL(request.url)
		const path = url.pathname
		const method = request.method

		if (path === '/kv' && method === 'GET') {
			const list = await env.KV.list()
			return Response.json(list)
		}
		const kvMatch = path.match(/^\/kv\/(.+)$/)
		if (kvMatch) {
			const key = decodeURIComponent(kvMatch[1]!)
			if (method === 'GET') {
				const value = await env.KV.get(key)
				if (value === null) return new Response('Not found', { status: 404 })
				return new Response(value)
			}
			if (method === 'PUT') {
				const body = await request.text()
				await env.KV.put(key, body)
				return new Response('OK', { status: 201 })
			}
			if (method === 'DELETE') {
				await env.KV.delete(key)
				return new Response('Deleted', { status: 200 })
			}
		}
		return null
	},
})

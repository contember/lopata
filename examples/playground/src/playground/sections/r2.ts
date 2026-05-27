import { registerSection } from '../registry'

registerSection({
	slug: 'r2',
	title: 'R2 Bucket',
	html: `
  <div class="links">
    <a href="#" onclick="api('GET','/r2?list=1');return false">LIST objects</a>
    <a href="#" onclick="api('GET','/r2/demo.txt');return false">GET /r2/demo.txt</a>
  </div>
  <form onsubmit="api('PUT','/r2/'+formVal('r2-key'),formVal('r2-val'));return false">
    <label>Key <input id="r2-key" value="demo.txt"></label>
    <label>Value <textarea id="r2-val">Hello from R2!</textarea></label>
    <button type="submit">PUT</button>
  </form>
  <form onsubmit="api('GET','/r2/'+formVal('r2-get-key'));return false">
    <label>Key <input id="r2-get-key" value="demo.txt"></label>
    <button type="submit" class="secondary">GET</button>
  </form>
  <form onsubmit="api('DELETE','/r2/'+formVal('r2-del-key'));return false">
    <label>Key <input id="r2-del-key" value="demo.txt"></label>
    <button type="submit" class="danger">DELETE</button>
  </form>
  `,
	async handle(request, env) {
		const url = new URL(request.url)
		const path = url.pathname
		const method = request.method

		if (path === '/r2' && method === 'GET') {
			const list = await env.R2.list()
			return Response.json({
				objects: list.objects.map((o) => ({
					key: o.key,
					size: o.size,
					uploaded: o.uploaded,
				})),
				truncated: list.truncated,
			})
		}
		const r2Match = path.match(/^\/r2\/(.+)$/)
		if (r2Match) {
			const key = decodeURIComponent(r2Match[1]!)
			if (method === 'GET') {
				const object = await env.R2.get(key)
				if (!object) return new Response('Not found', { status: 404 })
				return new Response(object.body, {
					headers: {
						'Content-Type': object.httpMetadata?.contentType
							?? 'application/octet-stream',
						'ETag': object.etag,
					},
				})
			}
			if (method === 'PUT') {
				const body = await request.arrayBuffer()
				const ct = request.headers.get('content-type')
				await env.R2.put(key, body, {
					httpMetadata: ct ? { contentType: ct } : undefined,
				})
				return new Response('OK', { status: 201 })
			}
			if (method === 'DELETE') {
				await env.R2.delete(key)
				return new Response('Deleted', { status: 200 })
			}
		}
		return null
	},
})

import { registerSection } from '../registry'

registerSection({
	slug: 'error-bridge',
	title: 'Error Propagation (DO → service binding → worker)',
	html: `
  <p class="note">ErrorBridge DO calls failing-worker through a service binding. Open links directly to see the error page.</p>
  <div class="links">
    <a href="/error-bridge/fetch/ok">fetch /ok (no error)</a>
    <a href="/error-bridge/fetch/throw">fetch /throw</a>
    <a href="/error-bridge/fetch/async-throw">fetch /async-throw</a>
    <a href="/error-bridge/fetch/deep-throw">fetch /deep-throw</a>
  </div>
  <div class="links">
    <a href="/error-bridge/do-throw">DO throw (no service binding)</a>
    <a href="/error-bridge/rpc/ping">RPC ping (no error)</a>
    <a href="/error-bridge/rpc/syncExplode">RPC syncExplode</a>
    <a href="/error-bridge/rpc/asyncExplode">RPC asyncExplode</a>
    <a href="/error-bridge/rpc/deepExplode">RPC deepExplode</a>
  </div>
  `,
	async handle(request, env) {
		const url = new URL(request.url)
		const path = url.pathname
		const method = request.method

		const ebFetchMatch = path.match(/^\/error-bridge\/fetch\/(.+)$/)
		if (ebFetchMatch && method === 'GET') {
			const id = env.ERROR_BRIDGE.idFromName('singleton')
			const stub = env.ERROR_BRIDGE.get(id)
			const text = await stub.callFetch('/' + ebFetchMatch[1]!)
			return new Response(text)
		}
		const ebRpcMatch = path.match(/^\/error-bridge\/rpc\/(.+)$/)
		if (ebRpcMatch && method === 'GET') {
			const id = env.ERROR_BRIDGE.idFromName('singleton')
			const stub = env.ERROR_BRIDGE.get(id)
			const result = await stub.callRpc(ebRpcMatch[1]!)
			return Response.json({ result })
		}
		if (path === '/error-bridge/do-throw' && method === 'GET') {
			const id = env.ERROR_BRIDGE.idFromName('singleton')
			const stub = env.ERROR_BRIDGE.get(id)
			await stub.doThrow()
			return new Response('unreachable')
		}
		return null
	},
})

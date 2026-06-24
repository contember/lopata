export default {
	async fetch(request: Request, env: any): Promise<Response> {
		const url = new URL(request.url)

		if (url.pathname === '/ping') {
			return new Response('pong')
		}

		// Flagship — an unknown flag returns the caller's default (reason DEFAULT),
		// proving the SQLite-backed binding surfaces in the worker thread.
		if (url.pathname === '/flagship') {
			const details = await env.FLAGS.getBooleanValueDetails('unknown-flag', true)
			return Response.json(details)
		}

		// VPC Networks — pass-through fetch to an absolute URL supplied by the caller.
		if (url.pathname === '/vpc') {
			const target = url.searchParams.get('target')
			if (!target) return new Response('missing target', { status: 400 })
			const res = await env.MY_VPC.fetch(target)
			return new Response(await res.text())
		}

		// Worker Loader — spawn a dynamic Worker (nested Bun thread) and fetch it.
		if (url.pathname === '/worker-loader') {
			const stub = env.LOADER.load({
				compatibilityDate: '2026-02-12',
				mainModule: 'index.js',
				modules: {
					'index.js': 'export default { async fetch() { return new Response("dynamic-worker-ok") } }',
				},
			})
			const res = await stub.getEntrypoint().fetch(new Request('http://dynamic/'))
			return new Response(await res.text())
		}

		// Artifacts — create a repo; the returned `remote` is served by main's
		// git-over-HTTP endpoint (proving thread→main shared SQLite + the git route).
		if (url.pathname === '/artifacts/create') {
			const repo = await env.ARTIFACTS.create('e2e-repo')
			return Response.json(repo)
		}

		// AI Search — presence check (a live search would hit the real CF API).
		if (url.pathname === '/ai-search') {
			return new Response(typeof env.SEARCH.get)
		}

		return new Response('not found', { status: 404 })
	},
}

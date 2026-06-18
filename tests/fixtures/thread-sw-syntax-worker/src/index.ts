// Legacy service-worker syntax: no `export default { fetch }`, just a global
// fetch listener. The thread runtime must dispatch through it.
addEventListener('fetch', (event: any) => {
	const url = new URL(event.request.url)
	if (url.pathname === '/async') {
		event.respondWith(
			(async () => {
				await new Promise(r => setTimeout(r, 10))
				return new Response('async-ok')
			})(),
		)
		return
	}
	event.respondWith(new Response('sw-ok'))
})

import { expect, test } from 'bun:test'
import { setupCloudflareGlobals } from '../src/setup-globals'

test('native responses are instances of the global Response', async () => {
	setupCloudflareGlobals()
	const server = Bun.serve({ port: 0, fetch: () => new Response('ok') })
	try {
		expect((await fetch(server.url)) instanceof Response).toBe(true)
	} finally {
		server.stop(true)
	}
	expect(Response.json({}) instanceof Response).toBe(true)
	expect(Response.redirect('http://localhost/') instanceof Response).toBe(true)
})

test('a subclass of the global Response does not claim plain responses', () => {
	setupCloudflareGlobals()
	class JsonResponse extends Response {}
	expect(Response.json({}) instanceof JsonResponse).toBe(false)
	expect(new JsonResponse('{}') instanceof Response).toBe(true)
})

test('Response.json keeps the status, status text and content type of a Response used as init', () => {
	setupCloudflareGlobals()
	const response = Response.json({ a: 1 }, new Response(null, { status: 201, statusText: 'Made', headers: { 'content-type': 'text/x-json' } }))
	expect(response.status).toBe(201)
	expect(response.statusText).toBe('Made')
	expect(response.headers.get('content-type')).toBe('text/x-json')
	expect(Response.json({}).headers.get('content-type')).toBe('application/json')
})

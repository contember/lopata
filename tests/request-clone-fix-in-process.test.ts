import { expect, test } from 'bun:test'
import { setupCloudflareGlobals } from '../src/setup-globals'

// The Vite plugin runs the main worker and in-process Durable Objects in the process that calls
// setupCloudflareGlobals(); a request a DO receives there carries a JS ReadableStream body.
test('a re-wrapped stream-bodied request stays readable after setupCloudflareGlobals()', async () => {
	setupCloudflareGlobals()
	const source = new Request('http://localhost/echo', {
		method: 'POST',
		body: new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('{"hello":"world"}'))
				controller.close()
			},
		}),
		duplex: 'half',
	} as RequestInit)
	const rewrapped = new Request(source, { redirect: 'manual' })
	const body = await Promise.race([rewrapped.text(), Bun.sleep(2_000).then(() => 'timed out')])
	expect(body).toBe('{"hello":"world"}')
})

test('a request the runtime built is still an instance of the global Request', async () => {
	setupCloudflareGlobals()
	const server = Bun.serve({ port: 0, fetch: request => new Response(String(request instanceof Request)) })
	try {
		expect(await (await fetch(server.url)).text()).toBe('true')
	} finally {
		server.stop(true)
	}
})

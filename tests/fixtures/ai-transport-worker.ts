import assert from 'node:assert/strict'
import type { AiBinding } from '../../src/bindings/ai'

const nativeFetch = globalThis.fetch
const contentType = 'multipart/form-data; boundary="worker-binary"'
const first = new TextEncoder().encode('--worker-binary\r\nContent-Disposition: form-data; name="input_image_0"\r\n\r\n')
const last = new Uint8Array([0, 255, 128, ...new TextEncoder().encode('private-image\r\n--worker-binary--\r\n')])
let uploadRelease = Promise.withResolvers<void>()
let responseRelease = Promise.withResolvers<void>()
let uploadComplete = false
let responseCancelled = false
let uploadCancelled = false

globalThis.fetch = Object.assign(async (...[input, init]: Parameters<typeof fetch>) => {
	const url = new URL(input instanceof Request ? input.url : String(input))
	assert.equal(url.origin, 'https://api.cloudflare.com')
	assert.equal(init?.method, 'POST')
	const headers = new Headers(init?.headers)
	assert.equal(headers.get('Authorization'), 'Bearer fixture-secret')
	if (url.pathname.endsWith('/abort')) {
		assert.ok(init?.body instanceof ReadableStream)
		assert.ok(init.signal instanceof AbortSignal)
		const body = init.body
		const signal = init.signal
		return new Promise<Response>((_resolve, reject) => {
			signal.addEventListener('abort', () => {
				void body.cancel(signal.reason).then(() => reject(signal.reason))
			}, { once: true })
		})
	}
	if (url.pathname.endsWith('/multipart')) {
		assert.equal(headers.get('Content-Type'), contentType)
		assert.ok(init?.body instanceof ReadableStream)
		const reader = init.body.getReader()
		assert.deepEqual((await reader.read()).value, first)
		assert.equal(uploadComplete, false)
		uploadRelease.resolve()
		assert.deepEqual((await reader.read()).value, last)
		assert.equal((await reader.read()).done, true)
		return Response.json({ result: { exactBytes: true, incrementalUpload: true } })
	}
	if (url.pathname.endsWith('/stream')) {
		responseRelease = Promise.withResolvers<void>()
		responseCancelled = false
		let sent = false
		return new Response(
			new ReadableStream<Uint8Array>({
				async pull(controller) {
					if (!sent) {
						sent = true
						controller.enqueue(new TextEncoder().encode('first\n'))
						return
					}
					await responseRelease.promise
					if (responseCancelled) return
					controller.enqueue(new TextEncoder().encode('last\n'))
					controller.close()
				},
				cancel() {
					responseCancelled = true
					responseRelease.resolve()
				},
			}, { highWaterMark: 0 }),
			{ headers: { 'Content-Type': 'text/event-stream', 'cf-aig-log-id': 'worker-stream-log' } },
		)
	}
	assert.equal(headers.get('Content-Type'), 'application/json')
	assert.equal(typeof init?.body, 'string')
	return Response.json({ result: { body: init?.body, gateway: headers.get('cf-aig-gateway-id') } })
}, { preconnect: nativeFetch.preconnect })

export default {
	async fetch(request: Request, env: { AI: AiBinding }): Promise<Response> {
		const path = new URL(request.url).pathname
		if (path === '/release') {
			responseRelease.resolve()
			return new Response('released')
		}
		if (path === '/cancelled') return Response.json({ responseCancelled })
		if (path === '/multipart') {
			uploadRelease = Promise.withResolvers<void>()
			uploadComplete = false
			let sent = false
			const body = new ReadableStream<Uint8Array>({
				async pull(controller) {
					if (!sent) {
						sent = true
						controller.enqueue(first)
						return
					}
					await uploadRelease.promise
					controller.enqueue(last)
					controller.close()
					uploadComplete = true
				},
			})
			return Response.json(await env.AI.run('@cf/test/multipart', { multipart: { body, contentType } }))
		}
		if (path === '/abort') {
			uploadCancelled = false
			const body = new ReadableStream({
				cancel() {
					uploadCancelled = true
				},
			})
			const controller = new AbortController()
			const run = env.AI.run('@cf/test/abort', { multipart: { body, contentType } }, { signal: controller.signal })
			setTimeout(() => controller.abort(new Error('worker aborted')), 0)
			try {
				await run
				throw new Error('Abort should reject')
			} catch (error) {
				assert.ok(error instanceof Error)
				assert.equal(error.message, 'worker aborted')
			}
			return Response.json({ uploadCancelled })
		}
		if (path === '/stream') {
			const result = await env.AI.run('@cf/test/stream', { stream: true })
			assert.ok(result instanceof ReadableStream)
			return new Response(result, { headers: { 'cf-aig-log-id': env.AI.aiGatewayLogId ?? '' } })
		}
		const rejectIfBusy = path === '/busy/true' ? true : path === '/busy/false' ? false : undefined
		return Response.json(
			await env.AI.run('@cf/test/json', { prompt: 'worker', options: { seed: 7 } }, {
				rejectIfBusy,
				gateway: { id: 'worker-gateway' },
			}),
		)
	},
}

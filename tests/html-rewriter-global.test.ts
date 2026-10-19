import { expect, test } from 'bun:test'

// No import of lopata's class: Worker code reaches HTMLRewriter as the global the test preload installs.
test('the global HTMLRewriter fires handlers on a streamed body', async () => {
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('<h1>Title</h1>'))
			controller.close()
		},
	})
	const titles: string[] = []
	await new HTMLRewriter()
		.on('h1', {
			text(chunk) {
				titles.push(chunk.text)
			},
		})
		.transform(new Response(body))
		.text()
	expect(titles.join('')).toBe('Title')
})

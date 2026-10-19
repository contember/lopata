import { DurableObject } from 'cloudflare:workers'

const PAGE = '<!DOCTYPE html><html><head><title>Docs &amp; guides</title></head>'
	+ '<body><a href="/a?x=1&amp;y=2">A</a><!-- draft --><a href="/b">B</a></body></html>'

// A JS ReadableStream in small chunks, so tags and attributes are split across chunks.
function streamedPage(): Response {
	const encoder = new TextEncoder()
	let offset = 0
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (offset >= PAGE.length) {
				controller.close()
				return
			}
			controller.enqueue(encoder.encode(PAGE.slice(offset, offset + 16)))
			offset += 16
		},
	})
	return new Response(body, { headers: { 'content-type': 'text/html' } })
}

async function readPage(describeLink: (href: string) => Promise<string>): Promise<{ title: string; links: string[] }> {
	let title = ''
	const links: string[] = []
	await new HTMLRewriter()
		.on('title', {
			text(chunk) {
				title += chunk.text
			},
		})
		.on('a[href]', {
			async element(element) {
				links.push(await describeLink(element.getAttribute('href') ?? ''))
			},
		})
		.transform(streamedPage())
		.text()
	return { title, links }
}

export class PageReader extends DurableObject {
	describe(href: string): string {
		return `link:${href}`
	}

	async fetch(): Promise<Response> {
		return Response.json(
			await readPage(async href => {
				await scheduler.wait(1)
				return `do:${href}`
			}),
		)
	}
}

export default {
	async fetch(request: Request, env: { READER: DurableObjectNamespace<PageReader> }): Promise<Response> {
		const url = new URL(request.url)
		const reader = env.READER.get(env.READER.idFromName('reader'))

		// The async handler awaits a Durable Object RPC call while the rewrite is in progress.
		if (url.pathname === '/read') {
			return Response.json(await readPage(href => reader.describe(href)))
		}

		if (url.pathname === '/read-in-do') {
			return reader.fetch('http://do/read')
		}

		if (url.pathname === '/rewrite') {
			return new HTMLRewriter()
				.on('a', {
					element(element) {
						element.setAttribute('rel', 'nofollow')
					},
				})
				.on('body', {
					comments(comment) {
						comment.replace('[draft]')
					},
				})
				.transform(streamedPage())
		}

		return new Response('not found', { status: 404 })
	},
}

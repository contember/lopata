import type { DocumentHandlers, ElementHandlers } from 'html-rewriter-wasm'

type RawHTMLRewriterType = new (sink: (chunk: Uint8Array) => void) => {
	on(selector: string, handler: ElementHandlers): void
	onDocument(handler: DocumentHandlers): void
	write(chunk: Uint8Array): Promise<void>
	end(): Promise<void>
	free(): void
}

let RawHTMLRewriter: RawHTMLRewriterType | null = null
try {
	;({ HTMLRewriter: RawHTMLRewriter } = await import('html-rewriter-wasm'))
} catch {
	// html-rewriter-wasm not installed — passthrough mode
}

let _warned = false

/**
 * Cloudflare-compatible HTMLRewriter that wraps html-rewriter-wasm.
 * Usage: new HTMLRewriter().on(selector, handler).onDocument(handler).transform(response)
 */
export class HTMLRewriter {
	private elementHandlers: Array<[string, ElementHandlers]> = []
	private documentHandlers: DocumentHandlers[] = []

	on(selector: string, handler: ElementHandlers): this {
		this.elementHandlers.push([selector, handler])
		return this
	}

	onDocument(handler: DocumentHandlers): this {
		this.documentHandlers.push(handler)
		return this
	}

	transform(response: Response): Response {
		// If body is null, return as-is (e.g. 204 No Content)
		if (response.body === null) {
			return new Response(null, {
				status: response.status,
				statusText: response.statusText,
				headers: new Headers(response.headers),
			})
		}

		if (!RawHTMLRewriter) {
			if (!_warned) {
				console.warn('[lopata] html-rewriter-wasm is not installed — HTMLRewriter is a passthrough. Install it: bun add html-rewriter-wasm')
				_warned = true
			}
			return response
		}

		const elementHandlers = this.elementHandlers
		const documentHandlers = this.documentHandlers

		const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
		const writer = writable.getWriter()

		const rewriter = new RawHTMLRewriter((chunk: Uint8Array) => {
			writer.write(chunk)
		})

		for (const [selector, handler] of elementHandlers) {
			rewriter.on(selector, handler)
		}
		for (const handler of documentHandlers) {
			rewriter.onDocument(handler)
		}

		const encoder = new TextEncoder()
		const reader = response.body.getReader()
		;(async () => {
			try {
				while (true) {
					const { done, value } = await reader.read()
					if (done) break
					// value can be Uint8Array or string
					const chunk = typeof value === 'string' ? encoder.encode(value) : value
					await rewriter.write(chunk)
				}
				await rewriter.end()
			} catch (err) {
				await writer.abort(err instanceof Error ? err : new Error(String(err)))
				return
			} finally {
				rewriter.free()
			}
			await writer.close()
		})()

		// Copy headers but remove content-length since streaming transform changes size
		const headers = new Headers(response.headers)
		headers.delete('content-length')

		return new Response(readable, {
			status: response.status,
			statusText: response.statusText,
			headers,
		})
	}
}

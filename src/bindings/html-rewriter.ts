import { HTMLRewriter as LolHtmlRewriter } from 'html-rewriter-wasm'
import type { DocumentHandlers, Element, ElementHandlers } from 'html-rewriter-wasm'

type Handler<T> = (arg: T) => void | Promise<void>

/**
 * Cloudflare-compatible HTMLRewriter on html-rewriter-wasm (lol-html, the engine Cloudflare uses).
 * The wasm build awaits async handlers without blocking the thread, so a handler can await a
 * binding call that is answered by another thread.
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

		const reader = response.body.getReader()
		const elementHandlers = this.elementHandlers
		const documentHandlers = this.documentHandlers
		const encoder = new TextEncoder()

		const body = new ReadableStream<Uint8Array>({
			async start(controller) {
				const rewriter = new LolHtmlRewriter(chunk => controller.enqueue(chunk))
				const handlerErrors = new HandlerErrors()
				for (const [selector, handler] of elementHandlers) {
					rewriter.on(selector, handlerErrors.guardElementHandlers(handler))
				}
				for (const handler of documentHandlers) {
					rewriter.onDocument(handlerErrors.guardDocumentHandlers(handler))
				}

				try {
					while (true) {
						const { done, value } = await reader.read()
						if (done) break
						// value can be Uint8Array or string
						const chunk = typeof value === 'string' ? encoder.encode(value) : value
						await rewriter.write(chunk)
						handlerErrors.throwIfFailed()
					}
					await rewriter.end()
					handlerErrors.throwIfFailed()
					controller.close()
				} catch (err) {
					controller.error(err)
				} finally {
					rewriter.free()
				}
			},
			cancel(reason) {
				return reader.cancel(reason)
			},
		})

		// Copy headers but remove content-length since streaming transform changes size
		const headers = new Headers(response.headers)
		headers.delete('content-length')

		return new Response(body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		})
	}
}

/**
 * Keeps handler errors away from the wasm rewriter. A rejected async handler leaves the
 * rewriter mid-call, after which free() throws "recursive use of an object". So the first
 * error is recorded, later handlers are skipped, and transform() fails the body with it.
 */
class HandlerErrors {
	private failure: { error: unknown } | null = null

	guardElementHandlers(handlers: ElementHandlers): ElementHandlers {
		const { element, comments, text } = handlers
		return {
			element: element && this.guard((el: Element) => {
				this.guardEndTagHandlers(el)
				return element.call(handlers, el)
			}),
			comments: comments && this.guard(comments.bind(handlers)),
			text: text && this.guard(text.bind(handlers)),
		}
	}

	guardDocumentHandlers(handlers: DocumentHandlers): DocumentHandlers {
		const { doctype, comments, text, end } = handlers
		return {
			doctype: doctype && this.guard(doctype.bind(handlers)),
			comments: comments && this.guard(comments.bind(handlers)),
			text: text && this.guard(text.bind(handlers)),
			end: end && this.guard(end.bind(handlers)),
		}
	}

	throwIfFailed(): void {
		if (this.failure) {
			throw this.failure.error
		}
	}

	private guardEndTagHandlers(el: Element): void {
		const onEndTag = el.onEndTag.bind(el)
		el.onEndTag = handler => onEndTag(this.guard(handler.bind(el)))
	}

	private guard<T extends object>(handler: Handler<T>): Handler<T> {
		return arg => {
			if (this.failure) return
			const streamed = new StreamedContent(arg)
			try {
				const result = handler(arg)
				if (result instanceof Promise || streamed.isPending()) {
					return Promise.resolve(result).then(() => streamed.flush()).catch(error => this.record(error))
				}
			} catch (error) {
				this.record(error)
			}
		}
	}

	private record(error: unknown): void {
		this.failure ??= { error }
	}
}

const CONTENT_METHODS = ['before', 'after', 'prepend', 'append', 'replace', 'setInnerContent']

/**
 * workerd's content methods also take a ReadableStream or a Response; lol-html's take strings. Once a handler passes a
 * stream, that call and every later content call on the same object are queued, and applied in order after the
 * handler has finished, each stream read to text first. The rewriter awaits the returned promise.
 */
class StreamedContent {
	private queue: Array<() => Promise<void>> | null = null

	constructor(target: object) {
		for (const method of CONTENT_METHODS) {
			const original: unknown = Reflect.get(target, method)
			if (typeof original !== 'function') continue
			Reflect.set(target, method, (content: unknown, options?: unknown) => {
				if (this.queue === null && !isStreamedContent(content)) return Reflect.apply(original, target, [content, options])
				this.queue ??= []
				this.queue.push(async () => {
					Reflect.apply(original, target, [isStreamedContent(content) ? await readContent(content) : content, options])
				})
				return target
			})
		}
	}

	isPending(): boolean {
		return this.queue !== null
	}

	async flush(): Promise<void> {
		// Reset first: the same object may reach another handler, whose calls must not land in this finished queue.
		const queue = this.queue ?? []
		this.queue = null
		for (const apply of queue) await apply()
	}
}

function isStreamedContent(content: unknown): content is ReadableStream | Response {
	return content instanceof ReadableStream || content instanceof Response
}

async function readContent(content: ReadableStream | Response): Promise<string> {
	const bytes = await (content instanceof Response ? content : new Response(content)).arrayBuffer()
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
	} catch {
		throw new Error('Parser error: Invalid UTF-8')
	}
}

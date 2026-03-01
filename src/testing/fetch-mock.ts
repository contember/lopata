import { AsyncLocalStorage } from 'node:async_hooks'

export interface FetchCall {
	request: Request
	url: string
	method: string
	response: Response | null
	mocked: boolean
	timestamp: number
}

type MatchFn = (req: Request) => boolean
type HandlerFn = (req: Request) => Response | Promise<Response>

interface MockRoute {
	match: MatchFn
	handler: HandlerFn
	method?: string
}

const fetchMockStorage = new AsyncLocalStorage<FetchMock>()

export function getActiveFetchMock(): FetchMock | undefined {
	return fetchMockStorage.getStore()
}

export function runWithFetchMock<T>(mock: FetchMock, fn: () => T): T {
	return fetchMockStorage.run(mock, fn)
}

function toHandlerFn(handler: Response | HandlerFn): HandlerFn {
	if (typeof handler === 'function') return handler
	return () => (handler as any).clone()
}

export class FetchMock {
	private routes: MockRoute[] = []
	private _calls: FetchCall[] = []
	private _passthrough = true

	/** Add a mock route. Unmatched requests will throw unless passthrough() is called. */
	on(match: string | RegExp | ((req: Request) => boolean), handler: Response | HandlerFn): this {
		const matchFn = this.toMatchFn(match)
		this.routes.push({ match: matchFn, handler: toHandlerFn(handler) })
		this._passthrough = false
		return this
	}

	/** Add a mock route for GET requests only. */
	onGet(match: string | RegExp | ((req: Request) => boolean), handler: Response | HandlerFn): this {
		const matchFn = this.toMatchFn(match)
		this.routes.push({ match: matchFn, handler: toHandlerFn(handler), method: 'GET' })
		this._passthrough = false
		return this
	}

	/** Add a mock route for POST requests only. */
	onPost(match: string | RegExp | ((req: Request) => boolean), handler: Response | HandlerFn): this {
		const matchFn = this.toMatchFn(match)
		this.routes.push({ match: matchFn, handler: toHandlerFn(handler), method: 'POST' })
		this._passthrough = false
		return this
	}

	/** Allow unmatched requests to pass through to the real network. */
	passthrough(): this {
		this._passthrough = true
		return this
	}

	/** All recorded fetch calls. */
	get calls(): readonly FetchCall[] {
		return this._calls
	}

	/** Get recorded calls, optionally filtered by URL match. */
	getCalls(match?: string | RegExp | ((req: Request) => boolean)): FetchCall[] {
		if (!match) return [...this._calls]
		const matchFn = this.toMatchFn(match)
		return this._calls.filter(c => matchFn(c.request))
	}

	/** Reset all routes and recorded calls. */
	reset(): void {
		this.routes = []
		this._calls = []
		this._passthrough = true
	}

	/** @internal Handle a fetch request from the intercepted globalThis.fetch */
	async _handle(request: Request): Promise<{ response: Response; mocked: boolean } | null> {
		for (const route of this.routes) {
			if (route.method && request.method !== route.method) continue
			if (route.match(request)) {
				const response = await route.handler(request)
				const call: FetchCall = {
					request,
					url: request.url,
					method: request.method,
					response,
					mocked: true,
					timestamp: Date.now(),
				}
				this._calls.push(call)
				return { response, mocked: true }
			}
		}

		// No route matched
		if (this._passthrough) {
			return null // let the original fetch handle it
		}

		// Strict mode — no route matched and passthrough is disabled
		const call: FetchCall = {
			request,
			url: request.url,
			method: request.method,
			response: null,
			mocked: false,
			timestamp: Date.now(),
		}
		this._calls.push(call)
		throw new Error(`FetchMock: no route matched for ${request.method} ${request.url} (passthrough disabled)`)
	}

	/** @internal Record a passthrough call */
	_recordPassthrough(request: Request, response: Response): void {
		this._calls.push({
			request,
			url: request.url,
			method: request.method,
			response,
			mocked: false,
			timestamp: Date.now(),
		})
	}

	private toMatchFn(match: string | RegExp | ((req: Request) => boolean)): MatchFn {
		if (typeof match === 'function') return match
		if (match instanceof RegExp) return (req) => match.test(req.url)
		// String: prefix match
		return (req) => req.url.startsWith(match)
	}
}

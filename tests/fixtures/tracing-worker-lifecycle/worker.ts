import { tracing, waitUntil, WorkerEntrypoint } from 'cloudflare:workers'
import type { WorkerExecutionContext } from '../../../src/worker-thread/execution-context'

const gates = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()

function gate(id: string): Promise<void> {
	let value = gates.get(id)
	if (!value) {
		value = Promise.withResolvers<void>()
		gates.set(id, value)
	}
	return value.promise
}

export class Control extends WorkerEntrypoint {
	release(id: string): void {
		gate(id)
		gates.get(id)?.resolve()
	}

	rpc(): string {
		this.ctx.tracing.startSpan('rpc-manual')
		return 'rpc-ok'
	}

	get property(): string {
		this.ctx.tracing.startSpan('property-manual')
		return 'property-ok'
	}

	get broken(): never {
		tracing.startSpan('broken-getter')
		throw new Error('getter failed')
	}

	uncloneable(): () => void {
		tracing.startSpan('uncloneable')
		return () => {}
	}

	crash(): void {
		setTimeout(() => {
			throw new Error('worker crashed')
		}, 10)
	}
}

export class BrokenConstructor extends WorkerEntrypoint {
	constructor(ctx: WorkerExecutionContext, env: unknown) {
		super(ctx, env)
		tracing.startSpan('constructor-manual')
		throw new Error('constructor failed')
	}

	fetch(): Response {
		return new Response('unreachable')
	}
}

export default {
	async fetch(request: Request, _env: unknown, ctx: WorkerExecutionContext): Promise<Response> {
		const url = new URL(request.url)
		const id = url.searchParams.get('id') ?? 'default'
		if (ctx.tracing !== tracing) throw new Error('Tracing namespace differs from context')
		tracing.getActiveSpan()?.setAttribute('request.id', id)
		const manual = tracing.startSpan(`manual:${id}`)
		if (url.pathname === '/burst') {
			for (let i = 0; i < 100; i++) tracing.startSpan(`burst:${i}`).setAttribute('before-termination', true)
			await gate(id)
			return new Response(null, { status: 204 })
		}
		if (url.pathname === '/background') {
			waitUntil(
				gate(`${id}:first`).then(() => {
					ctx.waitUntil(
						gate(`${id}:second`).then(() => {
							manual.setAttribute('nested', true)
							throw new Error(`background failed:${id}`)
						}),
					)
				}),
			)
			return new Response(null, { status: 204 })
		}
		if (url.pathname === '/cancel') {
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new Uint8Array([1]))
					},
					async cancel() {
						manual.setAttribute('cancel-started', true)
						await gate(`${id}:cancel`)
						manual.setAttribute('cancel-finished', true)
						tracing.enterSpan(`cancel-cleanup:${id}`, () => {})
					},
				}),
			)
		}
		if (url.pathname === '/locked') {
			const response = new Response('locked')
			response.body?.getReader()
			return response
		}
		if (url.pathname === '/throw') throw new Error('handler failed')
		if (url.pathname === '/handler') {
			await gate(id)
			manual.setAttribute('handler-done', true)
			return new Response(null, { status: 204 })
		}
		return new Response(
			new ReadableStream<Uint8Array>({
				async pull(controller) {
					await gate(id)
					manual.setAttribute('body-done', true)
					tracing.enterSpan(`body:${id}`, () => {})
					if (url.pathname === '/body-error') throw new Error(`body failed:${id}`)
					controller.enqueue(new TextEncoder().encode(id))
					controller.close()
				},
			}),
		)
	},
	scheduled(_controller: unknown, _env: unknown, ctx: WorkerExecutionContext): void {
		ctx.tracing.startSpan('scheduled-manual')
		ctx.waitUntil(gate('scheduled'))
	},
	email(_message: unknown, _env: unknown, ctx: WorkerExecutionContext): void {
		ctx.tracing.startSpan('email-manual')
		ctx.waitUntil(gate('email'))
	},
}

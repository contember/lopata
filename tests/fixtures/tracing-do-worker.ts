import { RpcTarget, tracing } from 'cloudflare:workers'
import type { DurableObjectStateImpl } from '../../src/bindings/durable-object'
import { getActiveExecutionContext } from '../../src/execution-context'

const gates = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
function gate(id: string): Promise<void> {
	let value = gates.get(id)
	if (!value) {
		value = Promise.withResolvers<void>()
		gates.set(id, value)
	}
	return value.promise
}

export class BrokenObject {
	constructor(readonly ctx: DurableObjectStateImpl, readonly env: unknown) {
		tracing.startSpan('broken-constructor')
		throw new Error('constructor failed')
	}
}

class RetainedTarget extends RpcTarget {
	private context = getActiveExecutionContext()

	constructor(private state: DurableObjectStateImpl, private id: string) {
		super()
	}

	touch(label: string): string {
		if (getActiveExecutionContext() !== this.context) throw new Error('Lost original DO execution context')
		tracing.enterSpan(`capability:${this.id}:${label}`, () => {})
		return this.id
	}

	child(): RetainedTarget {
		this.touch('child')
		return new RetainedTarget(this.state, `${this.id}:child`)
	}

	callback(): () => string {
		return () => {
			this.touch('callback')
			this.state.waitUntil(gate(`${this.id}:background`).then(() => this.touch('background')))
			return this.id
		}
	}

	async delayedChild(): Promise<RetainedTarget> {
		await gate(`${this.id}:call`)
		this.touch('delayed')
		return new RetainedTarget(this.state, `${this.id}:delayed`)
	}
}

export class TracedObject {
	constructor(readonly ctx: DurableObjectStateImpl, readonly env: unknown) {
		tracing.enterSpan('do-constructor', () => {})
		ctx.blockConcurrencyWhile(async () => {
			await Promise.resolve()
			tracing.enterSpan('do-constructor-ready', () => {})
		})
	}

	release(id: string): void {
		gate(id)
		gates.get(id)?.resolve()
	}

	rpc(): string {
		tracing.startSpan('rpc-manual')
		return 'rpc-ok'
	}

	capability(id: string): RetainedTarget {
		tracing.startSpan(`manual:${id}`)
		return new RetainedTarget(this.ctx, id)
	}

	functionCapability(id: string): () => RetainedTarget {
		tracing.startSpan(`manual:${id}`)
		return () => {
			tracing.enterSpan(`function:${id}`, () => {})
			return new RetainedTarget(this.ctx, id)
		}
	}

	nestedCapabilities(id: string): { children: [RetainedTarget, () => RetainedTarget] } {
		tracing.startSpan(`manual:${id}`)
		return { children: [new RetainedTarget(this.ctx, `${id}:nested`), () => new RetainedTarget(this.ctx, `${id}:function`)] }
	}

	get targetProperty(): RetainedTarget {
		return this.capability('property-capability')
	}

	async delayedResult(kind: 'scalar' | 'plain'): Promise<number | { value: number }> {
		tracing.startSpan(`manual:initial-${kind}`)
		await gate(`initial-${kind}`)
		return kind === 'scalar' ? 42 : { value: 42 }
	}

	get delayedProperty(): Promise<{ value: number }> {
		tracing.startSpan('manual:initial-getter')
		return gate('initial-getter').then(() => ({ value: 42 }))
	}

	get property(): string {
		tracing.startSpan('property-manual')
		return 'property-ok'
	}

	get asyncProperty(): Promise<string> {
		tracing.startSpan('async-property-manual')
		return gate('property').then(() => {
			tracing.enterSpan('async-property-ready', () => {})
			return 'async-property-ok'
		})
	}

	get broken(): never {
		tracing.startSpan('broken-property')
		throw new Error('getter failed')
	}

	alarm(): void {
		tracing.startSpan('alarm-manual')
		this.ctx.waitUntil(gate('alarm'))
	}

	crash(): void {
		setTimeout(() => {
			throw new Error('DO crashed')
		}, 10)
	}

	uncloneable(): () => void {
		tracing.startSpan('uncloneable')
		return () => {}
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)
		const id = url.searchParams.get('id') ?? 'default'
		const manual = tracing.startSpan(`manual:${id}`)
		if (getActiveExecutionContext()?.props['caller-only']) throw new Error('Caller runtime context leaked')
		if (url.pathname === '/burst') {
			for (let i = 0; i < 100; i++) tracing.startSpan(`burst:${i}`).setAttribute('before-termination', true)
			await gate(id)
			return new Response(null, { status: 204 })
		}
		if (url.pathname === '/locked') {
			const response = new Response('locked')
			response.body?.getReader()
			return response
		}
		if (url.pathname === '/background') {
			this.ctx.waitUntil(
				gate(`${id}:first`).then(() => {
					this.ctx.waitUntil(
						gate(`${id}:second`).then(() => {
							manual.setAttribute('nested', true)
							tracing.enterSpan(`background:${id}`, () => {})
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
						if (getActiveExecutionContext()?.props['caller-only']) throw new Error('Caller runtime context leaked during cancellation')
						manual.setAttribute('cancel-started', true)
						await gate(`${id}:cancel`)
						tracing.enterSpan(`cleanup:${id}`, () => {})
						manual.setAttribute('cancel-finished', true)
						if (id === 'cancel-error') throw new Error('cleanup failed')
					},
				}),
			)
		}
		if (url.pathname === '/handler') {
			await gate(id)
			tracing.enterSpan(`handler:${id}`, () => {})
			return new Response(null, { status: 204 })
		}
		if (url.pathname === '/throw') throw new Error('handler failed')
		return new Response(
			new ReadableStream<Uint8Array>({
				async pull(controller) {
					await gate(id)
					tracing.enterSpan(`body:${id}`, () => {})
					manual.setAttribute('body-done', true)
					if (url.pathname === '/body-error') throw new Error('body failed')
					controller.enqueue(new TextEncoder().encode(id))
					controller.close()
				},
			}),
		)
	}
}

interface Env {
	OBJECTS: {
		idFromName(name: string): unknown
		get(id: unknown): { fetch(request: Request): Promise<Response> }
	}
}

export default {
	fetch(request: Request, env: Env): Promise<Response> {
		return tracing.enterSpan('caller-span', () => env.OBJECTS.get(env.OBJECTS.idFromName('one')).fetch(request))
	},
}

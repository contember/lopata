import { tracing, waitUntil, WorkflowEntrypoint } from 'cloudflare:workers'
import type { SqliteWorkflowBinding } from '../../src/bindings/workflow'
import type { ExecutionContext } from '../../src/execution-context'

const outside = tracing.startSpan('outside-module')
const gates = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
const workflowRelease = Promise.withResolvers<void>()
const workflowFinished = Promise.withResolvers<void>()

export class PendingWorkflow extends WorkflowEntrypoint {
	async run() {
		const manual = tracing.startSpan('vite-workflow-manual')
		waitUntil(workflowRelease.promise.then(() => {
			manual.setAttribute('late', true)
			tracing.enterSpan('vite-workflow-late', () => {})
			workflowFinished.resolve()
		}))
	}
}

export async function releaseWorkflow(): Promise<void> {
	workflowRelease.resolve()
	await workflowFinished.promise
}

function gate(name: string): Promise<void> {
	let value = gates.get(name)
	if (!value) {
		value = Promise.withResolvers<void>()
		gates.set(name, value)
	}
	return value.promise
}

export default {
	async fetch(request: Request, env: { PENDING: SqliteWorkflowBinding }, ctx: ExecutionContext): Promise<Response> {
		const path = new URL(request.url).pathname
		if (path === '/workflow-start') {
			const instance = await env.PENDING.create({ id: 'pending' })
			const deadline = Date.now() + 3000
			while ((await instance.status()).status !== 'complete') {
				if (Date.now() > deadline) throw new Error('Workflow engine did not finish')
				await new Promise(resolve => setTimeout(resolve, 1))
			}
			return new Response('complete')
		}
		if (path.startsWith('/release/')) {
			gates.get(path.slice('/release/'.length))?.resolve()
			return new Response(null, { status: 204 })
		}
		if (path === '/identity') {
			const same = tracing.getActiveSpan() === ctx.tracing.getActiveSpan()
			const forwarded = tracing.enterSpan('forwarded', (span, value) => {
				span.setAttribute('forwarded', value)
				return value
			}, 42)
			return Response.json({ same, traced: tracing.getActiveSpan()?.isTraced, outside: outside.isTraced, forwarded })
		}
		if (path === '/background') {
			tracing.startSpan('background-manual')
			waitUntil(
				gate('background').then(() => {
					tracing.enterSpan('background-first', () => {})
					ctx.waitUntil(
						gate('nested').then(() => {
							tracing.enterSpan('background-nested', () => {})
						}),
					)
				}),
			)
			return new Response(null, { status: 204 })
		}
		if (path === '/stream') {
			let first = true
			return new Response(
				new ReadableStream<Uint8Array>({
					async pull(controller) {
						if (first) {
							first = false
							controller.enqueue(new TextEncoder().encode('first'))
							return
						}
						await gate('body')
						tracing.enterSpan('body-finish', () => {})
						controller.enqueue(new TextEncoder().encode('last'))
						controller.close()
					},
				}, { highWaterMark: 0 }),
			)
		}
		if (path === '/cancel') {
			let first = true
			return new Response(
				new ReadableStream<Uint8Array>({
					pull(controller) {
						if (!first) return
						first = false
						controller.enqueue(new TextEncoder().encode('first'))
					},
					async cancel() {
						tracing.enterSpan('cancel-start', () => {})
						await gate('cancel')
						tracing.enterSpan('cancel-end', () => {})
						waitUntil(
							gate('cancel-background').then(() => {
								tracing.enterSpan('cancel-background', () => {})
							}),
						)
					},
				}, { highWaterMark: 0 }),
			)
		}
		if (path === '/failure') throw new Error('Vite handler failed')
		if (path === '/body-error') {
			return new Response(
				new ReadableStream({
					pull(controller) {
						controller.error(new Error('Vite body failed'))
					},
				}),
			)
		}
		return new Response(null, { status: 204 })
	},
	scheduled(_event: unknown, _env: unknown, ctx: ExecutionContext) {
		ctx.tracing.startSpan('scheduled-manual')
		waitUntil(
			gate('scheduled').then(() => {
				tracing.enterSpan('scheduled-background', () => {})
			}),
		)
	},
	email(_event: unknown, _env: unknown, ctx: ExecutionContext) {
		ctx.tracing.startSpan('email-manual')
		waitUntil(
			gate('email').then(() => {
				tracing.enterSpan('email-background', () => {})
			}),
		)
	},
}

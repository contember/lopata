import { tracing } from 'cloudflare:workers'
import type { ExecutionContext } from '../../src/execution-context'

export default {
	async fetch(request: Request, _env: unknown, ctx: ExecutionContext): Promise<Response> {
		if (new URL(request.url).pathname !== '/identity') return new Response(null, { status: 404 })
		const same = tracing.getActiveSpan() === ctx.tracing.getActiveSpan()
		const forwarded = tracing.enterSpan('forwarded', (span, value: number) => {
			span.setAttribute('forwarded', value)
			return value
		}, 42)
		return Response.json({ same, traced: tracing.getActiveSpan()?.isTraced, forwarded })
	},
}

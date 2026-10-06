import { waitUntil } from 'cloudflare:workers'
import { WorkflowEntrypointBase, type WorkflowStepImpl } from '../../src/bindings/workflow'

export class TracedWorkflow extends WorkflowEntrypointBase {
	private readonly observer: { record(): Promise<void>; background(): Promise<void> }
	constructor(ctx: unknown, env: { OBSERVER: { record(): Promise<void>; background(): Promise<void> } }) {
		super(ctx, env)
		this.observer = env.OBSERVER
	}
	override async run(_event: unknown, step: WorkflowStepImpl) {
		await step.do('effect', async () => {
			await this.observer.record()
			return 'persisted'
		})
		await step.waitForEvent('resume', { type: 'resume' })
		waitUntil(
			this.observer.background().then(() => {
				this.ctx.tracing.enterSpan('imported background', () => {})
			}),
		)
		return 'done'
	}
}

export default { fetch: () => new Response('ok') }

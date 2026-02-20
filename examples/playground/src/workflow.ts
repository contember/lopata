import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'

type Params = {
	input: string
}

export class MyWorkflow extends WorkflowEntrypoint<Env, Params> {
	override async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
		const result = await step.do('step 1: process input', async () => {
			return { processed: event.payload.input.toUpperCase() }
		})

		const approval = await step.waitForEvent<{ approved: boolean }>('wait for approval', {
			type: 'approval',
			timeout: '1 hour',
		})

		if (!approval.payload.approved) {
			return { status: 'rejected', input: result.processed }
		}

		await step.do('step 2: finalize', async () => {
			return { final: result.processed, done: true }
		})
	}
}

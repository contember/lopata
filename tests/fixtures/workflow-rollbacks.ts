import { DurableObject, WorkflowEntrypoint } from 'cloudflare:workers'
import type { SqliteWorkflowBinding, WorkflowStepImpl } from '../../src/bindings/workflow'

interface Env {
	OBSERVER: { record(name: string): Promise<number> }
	TERMINATION: SqliteWorkflowBinding
}

export class TerminationWorkflow extends WorkflowEntrypoint<Env> {
	override async run(_event: unknown, step: WorkflowStepImpl) {
		await step.do('reserve', async () => 'reservation', {
			rollback: async ({ output }) => {
				await this.env.OBSERVER.record(`termination-undo:${output}`)
			},
		})
		await step.waitForEvent('approval', { type: 'approval' })
	}
}

export class TerminationController extends DurableObject<Env> {
	async fetch(request: Request) {
		const url = new URL(request.url)
		const instance = await this.env.TERMINATION.get(url.searchParams.get('id') ?? '')
		await instance.terminate({ rollback: url.searchParams.get('rollback') === 'true' })
		return Response.json(await instance.status())
	}
}

export class RollbackWorkflow extends WorkflowEntrypoint<Env> {
	override async run(_event: unknown, step: WorkflowStepImpl) {
		await step.do('older', async () => {
			await this.env.OBSERVER.record('forward-older')
			return { reservation: 'durable-reservation' }
		}, {
			rollback: async ({ output }) => {
				const attempt = await this.env.OBSERVER.record(`undo-older:${output?.reservation}`)
				if (attempt === 1) throw new Error('retry compensation')
			},
			rollbackConfig: { retries: { limit: 1, delay: 60_000 }, timeout: 1_000 },
		})
		await step.do('latest', async () => {
			await this.env.OBSERVER.record('forward-latest')
			throw new TypeError('original forward failure')
		}, {
			rollback: async ({ output }) => {
				await this.env.OBSERVER.record(`undo-latest:${String(output)}`)
			},
		})
	}
}

export default {
	fetch() {
		return new Response('rollback fixture')
	},
}

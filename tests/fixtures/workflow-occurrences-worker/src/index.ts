import { DurableObject, WorkflowEntrypoint } from 'cloudflare:workers'
import type { SqliteWorkflowBinding, WorkflowStepImpl } from '../../../../src/bindings/workflow'

interface Env {
	OCCURRENCES: SqliteWorkflowBinding
	CONTROLLER: { getByName(name: string): { fetch(request: Request): Promise<Response> } }
}

export class OccurrenceWorkflow extends WorkflowEntrypoint<Env> {
	override async run(event: { instanceId: string }, step: WorkflowStepImpl) {
		const results: { count: number; value: string }[] = []
		for (let n = 0; n < 2; n++) {
			results.push(
				await step.do('same', async ({ step }) => {
					const response = await this.env.CONTROLLER.getByName('controller').fetch(
						new Request(`http://controller/effect?id=${encodeURIComponent(event.instanceId)}&count=${step.count}`, { method: 'POST' }),
					)
					if (!response.ok) throw new Error(await response.text())
					return { count: step.count, value: crypto.randomUUID() }
				}),
			)
			await step.waitForEvent('same', { type: 'go' })
		}
		return results
	}
}

export class OccurrenceController extends DurableObject<Env> {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)
		const id = url.searchParams.get('id')
		if (!id) return new Response('Missing instance ID', { status: 400 })
		if (url.pathname === '/effect' && request.method === 'POST') {
			const count = url.searchParams.get('count')
			if (count !== '1' && count !== '2') return new Response('Invalid occurrence count', { status: 400 })
			const key = `${id}:${count}`
			await this.ctx.storage.put(key, (await this.ctx.storage.get<number>(key) ?? 0) + 1)
			return new Response('recorded')
		}
		if (url.pathname === '/effects') {
			return Response.json([await this.ctx.storage.get<number>(`${id}:1`) ?? 0, await this.ctx.storage.get<number>(`${id}:2`) ?? 0])
		}
		if (url.pathname === '/do-restart' && request.method === 'POST') {
			const instance = await this.env.OCCURRENCES.get(id)
			await instance.restart({ from: { name: 'same', count: 2, type: 'do' } })
			return new Response('restarted')
		}
		return new Response('Not found', { status: 404 })
	}
}

export default {
	fetch(request: Request, env: Env) {
		if (new URL(request.url).pathname === '/') return new Response('occurrences-ready')
		return env.CONTROLLER.getByName('controller').fetch(request)
	},
}

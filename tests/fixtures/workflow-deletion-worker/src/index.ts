import { DurableObject, WorkflowEntrypoint } from 'cloudflare:workers'
import type { SqliteWorkflowBinding, SqliteWorkflowInstance, WorkflowStepImpl } from '../../../../src/bindings/workflow'

interface Env {
	WORKFLOW: SqliteWorkflowBinding
	CONTROLLER: { getByName(name: string): { fetch(request: Request): Promise<Response> } }
}
const effects: string[] = []
const workerIdentity = crypto.randomUUID()

export class DeletionWorkflow extends WorkflowEntrypoint<Env> {
	override async run(event: { instanceId: string; payload: { mode?: string } }, step: WorkflowStepImpl) {
		const id = event.instanceId
		effects.push(`started:${id}`)
		await step.do('reserve', async () => 42, {
			rollback: async () => {
				effects.push(`rollback:${id}`)
			},
		})
		await step.waitForEvent('delete', { type: 'delete' })
		const remove = async () => {
			try {
				await (await this.env.WORKFLOW.get(id)).delete()
				effects.push(`after:${id}`)
			} catch {
				effects.push(`catch:${id}`)
			} finally {
				effects.push(`finally:${id}`)
			}
		}
		try {
			if (event.payload.mode === 'step') await step.do('delete', remove)
			else await remove()
			effects.push(`outer-after:${id}`)
		} catch {
			effects.push(`outer-catch:${id}`)
		} finally {
			effects.push(`outer-finally:${id}`)
		}
	}
}

export class DeletionController extends DurableObject<Env> {
	private saved = new Map<string, SqliteWorkflowInstance>()
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)
		const id = url.searchParams.get('id') ?? 'do-instance'
		if (url.pathname === '/do/create') {
			const handle = await this.env.WORKFLOW.create({ id })
			this.saved.set(id, handle)
			return Response.json({ id: handle.id })
		}
		if (url.pathname === '/do/delete') {
			await (await this.env.WORKFLOW.get(id)).delete()
			return new Response('deleted')
		}
		if (url.pathname === '/do/delete-saved') {
			const handle = this.saved.get(id)
			if (!handle) throw new Error('No saved handle')
			try {
				await handle.delete()
				return new Response('deleted')
			} catch {
				return new Response('stale handle', { status: 409 })
			}
		}
		if (url.pathname === '/do/send-saved') {
			const handle = this.saved.get(id)
			if (!handle) throw new Error('No saved handle')
			try {
				await handle.sendEvent({ type: 'delete' })
				return new Response('sent')
			} catch {
				return new Response('stale handle', { status: 409 })
			}
		}
		if (url.pathname === '/do/batch') return Response.json(await this.env.WORKFLOW.deleteBatch(url.searchParams.getAll('id')))
		return new Response('Not found', { status: 404 })
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url)
		const id = url.searchParams.get('id') ?? 'self'
		if (url.pathname.startsWith('/do/')) return env.CONTROLLER.getByName('controller').fetch(request)
		if (url.pathname === '/create') {
			await env.WORKFLOW.create({ id, params: { mode: url.searchParams.get('mode') } })
			return new Response('created')
		}
		if (url.pathname === '/signal') {
			await (await env.WORKFLOW.get(id)).sendEvent({ type: 'delete' })
			return new Response('sent')
		}
		if (url.pathname === '/status') {
			try {
				return Response.json(await (await env.WORKFLOW.get(id)).status())
			} catch {
				return new Response('missing', { status: 404 })
			}
		}
		if (url.pathname === '/effects') return Response.json(effects)
		return Response.json({ workerIdentity })
	},
}

import type { SQLQueryBindings } from 'bun:sqlite'
import type { SqliteWorkflowBinding } from '../../bindings/workflow'
import { getDatabase } from '../../db'
import type { HandlerContext, OkResponse, WorkflowDetail, WorkflowInstance, WorkflowSummary } from '../types'
import { getAllConfigs } from '../types'

function getWorkflowBinding(ctx: HandlerContext, name: string): SqliteWorkflowBinding {
	if (ctx.registry) {
		for (const manager of ctx.registry.listManagers().values()) {
			const gen = manager.active
			if (!gen) continue
			const entry = gen.registry.workflows.find(w => w.bindingName === name)
			if (entry) return entry.binding
		}
	}
	if (ctx.manager?.active) {
		const entry = ctx.manager.active.registry.workflows.find(w => w.bindingName === name)
		if (entry) return entry.binding
	}
	throw new Error(`Workflow binding "${name}" not found`)
}

export const handlers = {
	'workflows.list'(_input: {}, ctx: HandlerContext): WorkflowSummary[] {
		const db = getDatabase()
		const rows = db.query<{ workflow_name: string; status: string; count: number }, []>(
			'SELECT workflow_name, status, COUNT(*) as count FROM workflow_instances GROUP BY workflow_name, status ORDER BY workflow_name',
		).all()

		const grouped = new Map<string, { total: number; byStatus: Record<string, number> }>()
		for (const row of rows) {
			let entry = grouped.get(row.workflow_name)
			if (!entry) {
				entry = { total: 0, byStatus: {} }
				grouped.set(row.workflow_name, entry)
			}
			entry.total += row.count
			entry.byStatus[row.status] = row.count
		}

		for (const config of getAllConfigs(ctx)) {
			for (const w of config.workflows ?? []) {
				if (!grouped.has(w.binding)) {
					grouped.set(w.binding, { total: 0, byStatus: {} })
				}
			}
		}

		return Array.from(grouped.entries())
			.sort((a, b) => a[0].localeCompare(b[0]))
			.map(([name, data]) => ({ name, ...data }))
	},

	'workflows.listInstances'({ name, status }: { name: string; status?: string }): WorkflowInstance[] {
		const db = getDatabase()
		let query = 'SELECT id, status, params, output, error, created_at, updated_at FROM workflow_instances WHERE workflow_name = ?'
		const params: SQLQueryBindings[] = [name]

		if (status) {
			query += ' AND status = ?'
			params.push(status)
		}
		query += ' ORDER BY created_at DESC LIMIT 100'

		return db.prepare(query).all(...params) as WorkflowInstance[]
	},

	async 'workflows.getInstance'({ name, id }: { name: string; id: string }, ctx: HandlerContext): Promise<WorkflowDetail> {
		const db = getDatabase()
		const instance = db.query<Record<string, unknown>, [string]>(
			'SELECT * FROM workflow_instances WHERE id = ?',
		).get(id)
		if (!instance) throw new Error('Workflow instance not found')

		const steps = db.query<{ step_name: string; output: string | null; completed_at: number }, [string]>(
			'SELECT step_name, output, completed_at FROM workflow_steps WHERE instance_id = ? ORDER BY completed_at',
		).all(id)

		const stepAttempts = db.query<
			{
				step_name: string
				failed_attempts: number
				last_error: string | null
				last_error_name: string | null
				last_error_id: string | null
				updated_at: number | null
			},
			[string]
		>(
			'SELECT step_name, failed_attempts, last_error, last_error_name, last_error_id, updated_at FROM workflow_step_attempts WHERE instance_id = ? ORDER BY updated_at DESC',
		).all(id)

		const events = db.query<{ id: number; event_type: string; payload: string | null; created_at: number }, [string]>(
			'SELECT id, event_type, payload, created_at FROM workflow_events WHERE instance_id = ? ORDER BY created_at',
		).all(id)

		// The "sleeping" / "waiting for events" introspection reads live-process
		// in-memory registries. In thread mode those registries are populated in
		// the worker, so route the reads through the binding (the thread router
		// forwards them); in-process the binding runs them locally. Resolve the
		// binding best-effort — a stopped/unknown worker just yields the defaults.
		let sleeping = false
		let waitingForEvents: string[] = []
		try {
			const binding = getWorkflowBinding(ctx, name)
			if (instance.status === 'running') {
				const r = await binding.executeControl({ kind: 'isSleeping', instanceId: id })
				if (r.kind === 'isSleeping') sleeping = r.value
			}
			if (instance.status === 'waiting') {
				const r = await binding.executeControl({ kind: 'waitingEventTypes', instanceId: id })
				if (r.kind === 'waitingEventTypes') waitingForEvents = r.value
			}
		} catch {}

		// Compute active sleep: find the latest sleep/sleepUntil step "until" time.
		let activeSleep: WorkflowDetail['activeSleep'] = null
		if (sleeping) {
			for (let i = steps.length - 1; i >= 0; i--) {
				const s = steps[i]!
				if ((s.step_name.startsWith('sleep:') || s.step_name.startsWith('sleepUntil:')) && s.output) {
					try {
						const parsed = JSON.parse(s.output) as { until: number | string }
						const until = typeof parsed.until === 'string' ? new Date(parsed.until).getTime() : parsed.until
						if (until > Date.now()) {
							activeSleep = { stepName: s.step_name, until }
							break
						}
					} catch {}
				}
			}
		}

		return { ...instance, steps, stepAttempts, events, activeSleep, waitingForEvents } as WorkflowDetail
	},

	async 'workflows.terminate'({ name, id }: { name: string; id: string }, ctx: HandlerContext): Promise<OkResponse> {
		await getWorkflowBinding(ctx, name).executeControl({ kind: 'terminate', instanceId: id })
		return { ok: true }
	},

	async 'workflows.create'({ name, params }: { name: string; params: string }, ctx: HandlerContext): Promise<{ ok: true; id: string }> {
		const result = await getWorkflowBinding(ctx, name).executeControl({ kind: 'create', params: JSON.parse(params) })
		if (result.kind !== 'create') throw new Error('Unexpected workflow control result for create')
		return { ok: true, id: result.id }
	},

	async 'workflows.pause'({ name, id }: { name: string; id: string }, ctx: HandlerContext): Promise<OkResponse> {
		await getWorkflowBinding(ctx, name).executeControl({ kind: 'pause', instanceId: id })
		return { ok: true }
	},

	async 'workflows.resume'({ name, id }: { name: string; id: string }, ctx: HandlerContext): Promise<OkResponse> {
		await getWorkflowBinding(ctx, name).executeControl({ kind: 'resume', instanceId: id })
		return { ok: true }
	},

	async 'workflows.restart'({ name, id, fromStep }: { name: string; id: string; fromStep?: string }, ctx: HandlerContext): Promise<OkResponse> {
		await getWorkflowBinding(ctx, name).executeControl({ kind: 'restart', instanceId: id, fromStep })
		return { ok: true }
	},

	async 'workflows.skipSleep'({ name, id }: { name: string; id: string }, ctx: HandlerContext): Promise<OkResponse> {
		await getWorkflowBinding(ctx, name).executeControl({ kind: 'skipSleep', instanceId: id })
		return { ok: true }
	},

	async 'workflows.sendEvent'(
		{ name, id, type, payload }: { name: string; id: string; type: string; payload?: string },
		ctx: HandlerContext,
	): Promise<OkResponse> {
		await getWorkflowBinding(ctx, name).executeControl({
			kind: 'sendEvent',
			instanceId: id,
			eventType: type,
			payload: payload ? JSON.parse(payload) : undefined,
		})
		return { ok: true }
	},

	async 'workflows.duplicate'({ name, id }: { name: string; id: string }, ctx: HandlerContext): Promise<{ ok: true; id: string }> {
		const db = getDatabase()
		const row = db.query<{ params: string | null }, [string]>(
			'SELECT params FROM workflow_instances WHERE id = ?',
		).get(id)
		if (!row) throw new Error('Workflow instance not found')
		const params = row.params !== null ? JSON.parse(row.params) : {}
		const result = await getWorkflowBinding(ctx, name).executeControl({ kind: 'create', params })
		if (result.kind !== 'create') throw new Error('Unexpected workflow control result for duplicate')
		return { ok: true, id: result.id }
	},
}

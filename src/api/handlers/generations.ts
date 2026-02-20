import type { GenerationInfo, GenerationsData, HandlerContext, OkResponse } from '../types'

export const handlers = {
	'generations.list'(_input: {}, ctx: HandlerContext): GenerationsData {
		if (!ctx.manager) throw new Error('Generation manager not available')

		const result: GenerationsData = {
			generations: ctx.manager.list(),
			gracePeriodMs: ctx.manager.gracePeriodMs,
		}

		// Include per-worker data when registry is available (multi-worker mode)
		if (ctx.registry) {
			result.workers = []
			for (const [name, mgr] of ctx.registry.listManagers()) {
				result.workers.push({
					workerName: name,
					generations: mgr.list(),
					gracePeriodMs: mgr.gracePeriodMs,
				})
			}
		}

		return result
	},

	async 'generations.reload'(input: { workerName?: string }, ctx: HandlerContext): Promise<{ ok: true; generation: GenerationInfo }> {
		let manager = ctx.manager
		if (input.workerName && ctx.registry) {
			manager = ctx.registry.getManager(input.workerName) ?? null
		}
		if (!manager) throw new Error('Generation manager not available')
		const gen = await manager.reload()
		return { ok: true, generation: gen.getInfo() }
	},

	'generations.drain'(input: { workerName?: string }, ctx: HandlerContext): { ok: true; stoppedGeneration: number } {
		let manager = ctx.manager
		if (input.workerName && ctx.registry) {
			manager = ctx.registry.getManager(input.workerName) ?? null
		}
		if (!manager) throw new Error('Generation manager not available')
		const gens = manager.list().filter(g => g.state === 'draining')
		if (gens.length === 0) throw new Error('No draining generations')
		const oldest = gens.reduce((a, b) => a.createdAt < b.createdAt ? a : b)
		manager.stop(oldest.id)
		return { ok: true, stoppedGeneration: oldest.id }
	},

	'generations.config'(
		{ gracePeriodMs, workerName }: { gracePeriodMs: number; workerName?: string },
		ctx: HandlerContext,
	): { ok: true; gracePeriodMs: number } {
		let manager = ctx.manager
		if (workerName && ctx.registry) {
			manager = ctx.registry.getManager(workerName) ?? null
		}
		if (!manager) throw new Error('Generation manager not available')
		if (typeof gracePeriodMs !== 'number' || gracePeriodMs < 0) throw new Error('Invalid gracePeriodMs')
		manager.setGracePeriod(gracePeriodMs)
		return { ok: true, gracePeriodMs: manager.gracePeriodMs }
	},
}

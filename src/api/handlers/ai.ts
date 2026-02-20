import type { SQLQueryBindings } from 'bun:sqlite'
import { getDatabase } from '../../db'
import type { AiRequest, HandlerContext, OkResponse } from '../types'

export const handlers = {
	'ai.list'({ model, status, limit = 50 }: { model?: string; status?: string; limit?: number }): AiRequest[] {
		const db = getDatabase()
		let query = 'SELECT id, model, input_summary, output_summary, duration_ms, status, error, is_streaming, created_at FROM ai_requests'
		const conditions: string[] = []
		const params: SQLQueryBindings[] = []

		if (model) {
			conditions.push('model = ?')
			params.push(model)
		}
		if (status) {
			conditions.push('status = ?')
			params.push(status)
		}
		if (conditions.length) {
			query += ' WHERE ' + conditions.join(' AND ')
		}
		query += ' ORDER BY created_at DESC LIMIT ?'
		params.push(limit)

		return db.prepare(query).all(...params) as AiRequest[]
	},

	'ai.get'({ id }: { id: string }): AiRequest | null {
		const db = getDatabase()
		return db.query<AiRequest, [string]>(
			'SELECT id, model, input_summary, output_summary, duration_ms, status, error, is_streaming, created_at FROM ai_requests WHERE id = ?',
		).get(id)
	},

	'ai.delete'({ id }: { id: string }): OkResponse {
		const db = getDatabase()
		db.prepare('DELETE FROM ai_requests WHERE id = ?').run(id)
		return { ok: true }
	},

	'ai.stats'(_input: {}): { total: number; byModel: Record<string, number>; byStatus: Record<string, number>; avgDuration: number } {
		const db = getDatabase()
		const total = db.query<{ count: number }, []>('SELECT COUNT(*) as count FROM ai_requests').get()?.count ?? 0

		const modelRows = db.query<{ model: string; count: number }, []>(
			'SELECT model, COUNT(*) as count FROM ai_requests GROUP BY model ORDER BY count DESC',
		).all()
		const byModel: Record<string, number> = {}
		for (const r of modelRows) byModel[r.model] = r.count

		const statusRows = db.query<{ status: string; count: number }, []>(
			'SELECT status, COUNT(*) as count FROM ai_requests GROUP BY status',
		).all()
		const byStatus: Record<string, number> = {}
		for (const r of statusRows) byStatus[r.status] = r.count

		const avgDuration = db.query<{ avg: number | null }, []>(
			'SELECT AVG(duration_ms) as avg FROM ai_requests',
		).get()?.avg ?? 0

		return { total, byModel, byStatus, avgDuration: Math.round(avgDuration) }
	},

	'ai.models'(_input: {}): string[] {
		const db = getDatabase()
		return db.query<{ model: string }, []>(
			'SELECT DISTINCT model FROM ai_requests ORDER BY model',
		).all().map(r => r.model)
	},
}

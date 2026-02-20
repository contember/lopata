import { randomUUIDv7 } from 'bun'
import type { SQLQueryBindings } from 'bun:sqlite'
import { getDatabase } from '../../../db'
import type { HandlerContext, OkResponse, QueueInfo, QueueMessage } from '../types'
import { getAllConfigs } from '../types'

export const handlers = {
	'queue.listQueues'(_input: {}, ctx: HandlerContext): QueueInfo[] {
		const db = getDatabase()
		const rows = db.query<{ queue: string; pending: number; acked: number; failed: number }, []>(
			`SELECT queue,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'acked' THEN 1 ELSE 0 END) as acked,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
      FROM queue_messages GROUP BY queue ORDER BY queue`,
		).all()
		const rowMap = new Map(rows.map(r => [r.queue, r]))
		for (const config of getAllConfigs(ctx)) {
			for (const p of config.queues?.producers ?? []) {
				if (!rowMap.has(p.queue)) {
					rows.push({ queue: p.queue, pending: 0, acked: 0, failed: 0 })
				}
			}
		}
		rows.sort((a, b) => a.queue.localeCompare(b.queue))
		return rows
	},

	'queue.listMessages'({ queue, limit = 50, status }: { queue: string; limit?: number; status?: string }): QueueMessage[] {
		const db = getDatabase()
		let query = 'SELECT id, body, content_type, status, attempts, visible_at, created_at, completed_at FROM queue_messages WHERE queue = ?'
		const params: SQLQueryBindings[] = [queue]

		if (status) {
			query += ' AND status = ?'
			params.push(status)
		}
		query += ' ORDER BY created_at DESC LIMIT ?'
		params.push(limit)

		const rows = db.prepare(query).all(...params) as Record<string, unknown>[]
		return rows.map(row => {
			let bodyStr: string
			try {
				bodyStr = new TextDecoder().decode(row.body as BufferSource)
			} catch {
				bodyStr = `<binary>`
			}
			return { ...row, body: bodyStr } as QueueMessage
		})
	},

	'queue.deleteMessage'({ queue, id }: { queue: string; id: string }): OkResponse {
		const db = getDatabase()
		db.prepare('DELETE FROM queue_messages WHERE queue = ? AND id = ?').run(queue, id)
		return { ok: true }
	},

	'queue.publishMessage'({ queue, body, contentType = 'json' }: { queue: string; body: string; contentType?: string }): OkResponse {
		const db = getDatabase()
		const now = Date.now()
		let encoded: Uint8Array
		if (contentType === 'json') {
			// Validate JSON
			JSON.parse(body)
			encoded = new TextEncoder().encode(body)
		} else {
			encoded = new TextEncoder().encode(body)
		}
		db.run(
			"INSERT INTO queue_messages (id, queue, body, content_type, attempts, status, visible_at, created_at) VALUES (?, ?, ?, ?, 0, 'pending', ?, ?)",
			[randomUUIDv7(), queue, encoded, contentType, now, now],
		)
		return { ok: true }
	},

	'queue.requeueMessage'({ queue, id }: { queue: string; id: string }): OkResponse {
		const db = getDatabase()
		const now = Date.now()
		db.prepare(
			"UPDATE queue_messages SET status = 'pending', attempts = 0, visible_at = ?, completed_at = NULL WHERE queue = ? AND id = ?",
		).run(now, queue, id)
		return { ok: true }
	},
}

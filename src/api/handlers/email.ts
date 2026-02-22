import type { SQLQueryBindings } from 'bun:sqlite'
import { getDatabase } from '../../db'
import type { EmailRecord, HandlerContext, OkResponse } from '../types'

export const handlers = {
	'email.list'({ status, limit = 50 }: { status?: string; limit?: number }): EmailRecord[] {
		const db = getDatabase()
		let query = 'SELECT id, binding, from_addr, to_addr, raw_size, status, reject_reason, created_at FROM email_messages'
		const params: SQLQueryBindings[] = []

		if (status) {
			query += ' WHERE status = ?'
			params.push(status)
		}
		query += ' ORDER BY created_at DESC LIMIT ?'
		params.push(limit)

		return db.prepare(query).all(...params) as EmailRecord[]
	},

	'email.get'({ id }: { id: string }): { record: EmailRecord; raw: string } | null {
		const db = getDatabase()
		const row = db.query<Record<string, unknown>, [string]>(
			'SELECT id, binding, from_addr, to_addr, raw, raw_size, status, reject_reason, created_at FROM email_messages WHERE id = ?',
		).get(id)
		if (!row) return null

		let rawStr: string
		try {
			rawStr = new TextDecoder().decode(row.raw as Uint8Array)
		} catch {
			rawStr = '<binary content>'
		}

		const { raw: _raw, ...record } = row
		return { record: record as unknown as EmailRecord, raw: rawStr }
	},

	'email.delete'({ id }: { id: string }): OkResponse {
		const db = getDatabase()
		db.prepare('DELETE FROM email_messages WHERE id = ?').run(id)
		return { ok: true }
	},

	async 'email.trigger'(
		{ from, to, subject, body }: { from: string; to: string; subject?: string; body?: string },
		ctx: HandlerContext,
	): Promise<OkResponse> {
		// Build raw MIME content
		const lines: string[] = []
		lines.push(`From: ${from}`)
		lines.push(`To: ${to}`)
		if (subject) lines.push(`Subject: ${subject}`)
		lines.push(`Date: ${new Date().toUTCString()}`)
		lines.push('MIME-Version: 1.0')
		lines.push('Content-Type: text/plain; charset=utf-8')
		lines.push('')
		lines.push(body ?? '')
		const rawContent = lines.join('\r\n')
		const rawBytes = new TextEncoder().encode(rawContent)

		const gen = ctx.manager?.active
		if (!gen) throw new Error('No active generation')
		const res = await gen.callEmail(rawBytes, from, to)
		if (!res.ok) {
			const text = await res.text()
			throw new Error(text || `Email handler failed with status ${res.status}`)
		}
		return { ok: true }
	},

	'email.stats'(_input: {}, _ctx: HandlerContext): { total: number; byStatus: Record<string, number> } {
		const db = getDatabase()
		const total = db.query<{ count: number }, []>('SELECT COUNT(*) as count FROM email_messages').get()?.count ?? 0
		const rows = db.query<{ status: string; count: number }, []>(
			'SELECT status, COUNT(*) as count FROM email_messages GROUP BY status',
		).all()
		const byStatus: Record<string, number> = {}
		for (const r of rows) byStatus[r.status] = r.count
		return { total, byStatus }
	},
}

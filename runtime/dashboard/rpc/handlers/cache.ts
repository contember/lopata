import { getDatabase } from '../../../db'
import type { CacheEntry, CacheName, OkResponse } from '../types'

export const handlers = {
	'cache.listCaches'(_input: {}): CacheName[] {
		const db = getDatabase()
		return db.query<{ cache_name: string; count: number }, []>(
			'SELECT cache_name, COUNT(*) as count FROM cache_entries GROUP BY cache_name ORDER BY cache_name',
		).all()
	},

	'cache.listEntries'({ name }: { name: string }): CacheEntry[] {
		const db = getDatabase()
		return db.query<{ url: string; status: number; headers: string; expires_at: number | null }, [string]>(
			'SELECT url, status, headers, expires_at FROM cache_entries WHERE cache_name = ? ORDER BY url',
		).all(name)
	},

	'cache.deleteEntry'({ name, url }: { name: string; url: string }): OkResponse {
		const db = getDatabase()
		db.prepare('DELETE FROM cache_entries WHERE cache_name = ? AND url = ?').run(name, url)
		return { ok: true }
	},
}

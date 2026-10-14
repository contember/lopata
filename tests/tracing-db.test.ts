import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTracingDatabase } from '../src/tracing/db'

test('the trace database commits without an fsync per span', () => {
	const dir = mkdtempSync(join(tmpdir(), 'lopata-traces-'))
	try {
		const db = openTracingDatabase(join(dir, 'traces.sqlite'))
		expect(db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()?.journal_mode).toBe('wal')
		// 1 = NORMAL: in WAL mode only checkpoints sync.
		expect(db.query<{ synchronous: number }, []>('PRAGMA synchronous').get()?.synchronous).toBe(1)
		db.close()
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
})

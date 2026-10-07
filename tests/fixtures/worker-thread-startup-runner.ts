import { Database } from 'bun:sqlite'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getDataDir } from '../../src/db'
import { WorkerThreadExecutor } from '../../src/worker-thread/executor'

const dbPath = join(getDataDir(), 'data.sqlite')
assert.equal(existsSync(dbPath), false, 'The subprocess must start without a database')
const executors: WorkerThreadExecutor[] = []
const journalModes: string[] = []
const names = ['first', 'second']

try {
	for (const name of names) {
		executors.push(
			new WorkerThreadExecutor({
				modulePath: join(import.meta.dir, 'worker-thread-startup-worker.ts'),
				config: { name, vars: { WORKER_NAME: name } },
				baseDir: process.cwd(),
				mainEnv: {},
			}),
		)
		// No yield: main cannot answer a worker's need-init message before this check.
		assert.equal(existsSync(dbPath), true, 'Executor construction must initialize the database synchronously')
		const db = new Database(dbPath, { readonly: true })
		try {
			const mode = db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()
			assert.ok(mode)
			assert.equal(mode.journal_mode, 'wal', 'WAL must be established before worker initialization')
			journalModes.push(mode.journal_mode)
		} finally {
			db.close()
		}
	}
	const responses = await Promise.all(executors.map(async (executor, index) => {
		const response = await executor.executeFetch(new Request(`https://startup.example/${names[index]}`))
		assert.equal(response.status, 200)
		return response.json()
	}))
	console.log(`REPORT ${JSON.stringify({ journalModes, responses })}`)
} finally {
	for (const executor of executors) executor.dispose()
}

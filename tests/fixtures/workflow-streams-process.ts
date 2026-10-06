import { Database } from 'bun:sqlite'
import { SqliteWorkflowBinding, WorkflowEntrypointBase } from '../../src/bindings/workflow'
import type { WorkflowStepImpl } from '../../src/bindings/workflow'
import { runMigrations } from '../../src/db'

const path = process.argv[2]
const mode = process.argv[3]
if (!path || !mode) throw new Error('Expected path and mode')
const db = new Database(path)
runMigrations(db)
db.run('CREATE TABLE IF NOT EXISTS effects (attempt INTEGER)')
db.run('CREATE TABLE IF NOT EXISTS undos (bytes INTEGER)')
db.run('CREATE TABLE IF NOT EXISTS scenario (mode TEXT)')
if (mode !== 'recover') db.query('INSERT INTO scenario VALUES (?)').run(mode)
const scenario = db.query<{ mode: string }, []>('SELECT mode FROM scenario').get()?.mode
async function inspect(output: ReadableStream<Uint8Array>) {
	let bytes = 0
	for await (const chunk of output) {
		if (chunk.some(byte => byte !== 47)) throw new Error('Corrupt recovered bytes')
		bytes += chunk.byteLength
	}
	if (bytes !== 180000) throw new Error('Missing recovered bytes')
	return bytes
}
class Workflow extends WorkflowEntrypointBase {
	override async run(_event: unknown, step: WorkflowStepImpl) {
		const output = await step.do('bytes', { retries: { limit: 1, delay: mode === 'retry' ? 60000 : 1 } }, async ctx => {
			db.query('INSERT INTO effects VALUES (?)').run(ctx.attempt)
			return new ReadableStream<Uint8Array>({
				start(controller) {
					if (mode === 'retry') {
						controller.error(new Error('retry source'))
						return
					}
					controller.enqueue(new Uint8Array(180000).fill(47))
					if (mode !== 'writing' && mode !== 'terminated') controller.close()
				},
			})
		}, {
			rollback: async ({ output }) => {
				if (!output) throw new Error('Missing compensation stream')
				db.query('INSERT INTO undos VALUES (?)').run(await inspect(output))
				if (mode === 'rollback') throw new Error('retry compensation')
			},
			rollbackConfig: { retries: { limit: 1, delay: mode === 'rollback' ? 60000 : 1 } },
		})
		const bytes = await inspect(output)
		if (scenario === 'rollback') throw new Error('compensate stream')
		if (mode === 'committed') await step.waitForEvent('hold', { type: 'hold' })
		return bytes
	}
}
const binding = new SqliteWorkflowBinding(db, 'STREAMS', 'Workflow', { defaultRetryLimit: 0 })
binding._setClass(Workflow, {})
if (mode === 'recover') {
	if (scenario === 'terminated') db.run('DROP TRIGGER fail_cleanup')
	binding.resumeInterrupted()
} else await binding.create({ id: 'stream-recovery' })
const deadline = Date.now() + 4000
while (Date.now() < deadline) {
	const state = db.query<{ status: string; output: string | null }, []>('SELECT status, output FROM workflow_instances').get()
	if (mode === 'writing' && db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM workflow_stream_chunks').get()?.n === 3) process.exit(0)
	if (mode === 'terminated' && db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM workflow_stream_chunks').get()?.n === 3) {
		db.run("CREATE TRIGGER fail_cleanup BEFORE DELETE ON workflow_stream_chunks BEGIN SELECT RAISE(FAIL, 'cleanup unavailable'); END")
		await (await binding.get('stream-recovery')).terminate()
		if (db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM workflow_stream_chunks').get()?.n !== 3) throw new Error('Expected deferred cleanup')
		process.exit(0)
	}
	if (mode === 'committed' && state?.status === 'waiting') process.exit(0)
	if (mode === 'retry' && db.query<{ failed_attempts: number }, []>('SELECT failed_attempts FROM workflow_occurrences').get()?.failed_attempts === 1) {
		process.exit(0)
	}
	if (
		mode === 'rollback'
		&& db.query<{ rollback_attempts: number }, []>('SELECT rollback_attempts FROM workflow_occurrences').get()?.rollback_attempts === 1
	) process.exit(0)
	if (mode === 'recover' && scenario === 'rollback' && state?.status === 'errored') {
		const status = await (await binding.get('stream-recovery')).status()
		if (status.rollback?.outcome !== 'complete') throw new Error('Compensation recovery failed')
		process.exit(0)
	}
	if (mode === 'recover' && state?.status === 'complete' && state.output === '180000') process.exit(0)
	if (mode === 'recover' && scenario === 'terminated' && state?.status === 'terminated') {
		if (db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM workflow_stream_chunks').get()?.n !== 0) throw new Error('Terminal cleanup failed')
		process.exit(0)
	}
	await Bun.sleep(5)
}
throw new Error('Recovery timed out')

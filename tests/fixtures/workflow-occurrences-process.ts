import { Database } from 'bun:sqlite'
import { SqliteWorkflowBinding, WorkflowEntrypointBase } from '../../src/bindings/workflow'
import type { WorkflowStepImpl } from '../../src/bindings/workflow'
import { WorkflowStore } from '../../src/bindings/workflow-store'
import { runMigrations } from '../../src/db'

const path = process.argv[2]
const phase = process.argv[3]
if (!path || !phase) throw new Error('Expected database path and phase')
const db = new Database(path)
runMigrations(db)
db.run('CREATE TABLE IF NOT EXISTS effects (kind TEXT NOT NULL, count INTEGER NOT NULL, attempt INTEGER NOT NULL)')
class RecoveryWorkflow extends WorkflowEntrypointBase {
	override async run(_event: unknown, step: WorkflowStepImpl) {
		for (let count = 1; count <= 2; count++) {
			await step.do('same', { retries: { limit: 1, delay: phase === 'forward' ? 60000 : 1 } }, async ctx => {
				db.query('INSERT INTO effects VALUES (?, ?, ?)').run('forward', ctx.step.count, ctx.attempt)
				if (ctx.step.count === 2 && ctx.attempt === 1) throw new Error('recover this attempt')
				return ctx.step.count
			}, {
				rollback: async ({ ctx, output }) => {
					if (output !== ctx.step.count) throw new Error('Lost committed output')
					db.query('INSERT INTO effects VALUES (?, ?, ?)').run('rollback', ctx.step.count, ctx.attempt)
					const row = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM effects WHERE kind = 'rollback' AND count = 1").get()
					if (ctx.step.count === 1 && row?.count === 1) throw new Error('recover compensation')
				},
				rollbackConfig: { retries: { limit: 1, delay: phase === 'rollback' ? 60000 : 1 } },
			})
		}
		throw new Error('original failure')
	}
}
const binding = new SqliteWorkflowBinding(db, 'RECOVERY', 'RecoveryWorkflow')
binding._setClass(RecoveryWorkflow, {})
if (phase === 'forward') await binding.create({ id: 'recover' })
else binding.resumeInterrupted()
const store = new WorkflowStore(db)
const deadline = Date.now() + 4000
while (Date.now() < deadline) {
	const rows = store.readDetail('recover', 'RECOVERY').occurrences
	const status = await (await binding.get('recover')).status()
	if (phase === 'forward' && rows.some(row => row.key.count === 2 && row.failedAttempts === 1)) process.exit(0)
	if (phase === 'rollback' && rows.some(row => row.key.count === 1 && row.rollbackAttempts === 1)) process.exit(0)
	if (phase === 'finish' && status.status === 'errored') {
		if (status.rollback?.outcome !== 'complete') throw new Error('Rollback did not finish')
		process.exit(0)
	}
	await Bun.sleep(5)
}
throw new Error(`Recovery phase ${phase} timed out`)

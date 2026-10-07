import { DurableObjectBase, type DurableObjectStateImpl } from '../../src/bindings/durable-object'

export class AbortProbe extends DurableObjectBase {
	private transactionOpen = false

	constructor(ctx: DurableObjectStateImpl, env: unknown) {
		super(ctx, env)
		const count = ctx.storage.kv.get('constructors')
		ctx.storage.kv.put('constructors', typeof count === 'number' ? count + 1 : 1)
		ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS probe (value TEXT)')
	}

	async configure(mode: string, retryAlarm?: boolean, replacementTime = 0) {
		await this.ctx.storage.put({ mode, retryAlarm: retryAlarm ?? 'default', attempts: 0, replacementTime })
	}

	abortNow(retryAlarm?: boolean) {
		this.ctx.abort('requested abort', retryAlarm === undefined ? undefined : { retryAlarm })
	}

	status() {
		return { constructors: this.ctx.storage.kv.get('constructors'), transactionOpen: this.transactionOpen }
	}

	async holdTransaction() {
		await this.ctx.storage.put('committed', 'kept')
		this.ctx.storage.sql.exec("INSERT INTO probe VALUES ('committed')")
		await this.ctx.storage.transaction(async txn => {
			await txn.put('uncommitted', 'discard')
			this.ctx.storage.sql.exec('BEGIN IMMEDIATE')
			this.ctx.storage.sql.exec("INSERT INTO probe VALUES ('uncommitted')")
			this.transactionOpen = true
			await new Promise<void>(() => {})
		})
	}

	async alarm() {
		const attempts = await this.ctx.storage.get<number>('attempts') ?? 0
		await this.ctx.storage.put('attempts', attempts + 1)
		if (attempts > 0) {
			await this.ctx.storage.put('finished', true)
			return
		}
		const retry = await this.ctx.storage.get('retryAlarm')
		const retryAlarm = typeof retry === 'boolean' ? retry : undefined
		const mode = await this.ctx.storage.get<string>('mode')
		if (mode === 'replace') await this.ctx.storage.setAlarm(await this.ctx.storage.get<number>('replacementTime') ?? 0)
		if (mode === 'delete') await this.ctx.storage.deleteAlarm()
		this.abortNow(retryAlarm)
	}
}

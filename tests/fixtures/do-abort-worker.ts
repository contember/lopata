import { DurableObjectBase, type DurableObjectStateImpl } from '../../src/bindings/durable-object'
import { tracing } from '../../src/tracing/span'

export class AbortProbe extends DurableObjectBase {
	private releaseAlarm?: () => void
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

	async arm(time: number) {
		await this.ctx.storage.setAlarm(time)
	}
	async cancel() {
		await this.ctx.storage.deleteAlarm()
	}
	abortNow(retryAlarm?: boolean) {
		this.ctx.abort('requested abort', retryAlarm === undefined ? undefined : { retryAlarm })
	}
	spinAfterAbort() {
		try {
			this.ctx.abort('spin abort', { retryAlarm: false })
		} catch {}
		while (true) {}
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

	release() {
		this.releaseAlarm?.()
	}

	async alarm() {
		tracing.startSpan('abort-alarm-owned')
		const attempts = await this.ctx.storage.get<number>('attempts') ?? 0
		await this.ctx.storage.put('attempts', attempts + 1)
		if (attempts > 0) {
			await this.ctx.storage.put('finished', true)
			return
		}
		const mode = await this.ctx.storage.get<string>('mode')
		const retry = await this.ctx.storage.get('retryAlarm')
		const retryAlarm = typeof retry === 'boolean' ? retry : undefined
		const waitForRelease = () =>
			new Promise<void>(resolve => {
				this.releaseAlarm = resolve
			})
		if (mode === 'delete-self' || mode === 'delete-hold' || mode === 'hold-delete') {
			if (mode === 'hold-delete') await waitForRelease()
			await this.ctx.storage.deleteAll()
			await this.ctx.storage.put('attempts', attempts + 1)
			await this.ctx.storage.put('deleted', true)
			if (mode === 'delete-hold') await waitForRelease()
			this.abortNow(retryAlarm)
			return
		}
		if (mode === 'own-replace' || mode === 'transaction-own-set-delete' || mode === 'transaction-hold-delete') {
			const time = await this.ctx.storage.get<number>('replacementTime') ?? 0
			if (mode === 'own-replace') {
				await this.ctx.storage.setAlarm(time)
			} else {
				await this.ctx.storage.transaction(async txn => {
					if (mode === 'transaction-own-set-delete') await txn.setAlarm(time)
					else await waitForRelease()
					await txn.deleteAlarm()
				})
			}
			this.abortNow(retryAlarm)
			return
		}
		if (mode === 'hold' || mode === 'fail') {
			await new Promise<void>(resolve => {
				this.releaseAlarm = resolve
			})
			if (mode === 'fail') throw Object.assign(new Error('ordinary failure'), { retryAlarm: false, type: 'aborted' })
			await this.ctx.storage.put('finished', true)
			return
		}
		this.abortNow(retryAlarm)
	}
}

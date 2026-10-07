import { DurableObjectBase, type DurableObjectStateImpl } from '../../src/bindings/durable-object'

export class AlarmCompatibility extends DurableObjectBase {
	private releaseAlarm?: () => void

	async arm(time: number) {
		await this.ctx.storage.put('value', 'kept')
		await this.ctx.storage.setAlarm(time)
	}

	async clear() {
		await this.ctx.storage.deleteAll()
		return this.ctx.storage.getAlarm()
	}

	async replace(time: number) {
		await this.ctx.storage.deleteAll()
		await this.ctx.storage.setAlarm(time)
	}

	async transactionalClear() {
		await this.ctx.storage.transaction(async txn => {
			await txn.put('value', 'rolled back')
			await txn.deleteAll()
		})
	}

	async hold() {
		await this.ctx.storage.put('hold', true)
	}

	release() {
		this.releaseAlarm?.()
	}

	async alarm() {
		const hold = await this.ctx.storage.get('hold')
		await this.ctx.storage.put('started', true)
		if (hold) {
			await new Promise<void>(resolve => {
				this.releaseAlarm = resolve
			})
		}
		await this.ctx.storage.put('finished', true)
	}
}

export class ConstructorAlarmCompatibility extends AlarmCompatibility {
	constructor(ctx: DurableObjectStateImpl, env: unknown) {
		super(ctx, env)
		ctx.blockConcurrencyWhile(() => ctx.storage.deleteAll())
	}
}

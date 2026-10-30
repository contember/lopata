import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { SqliteWorkflowBinding, WorkflowEntrypointBase } from '../src/bindings/workflow'
import type { WorkflowLimits, WorkflowStepImpl } from '../src/bindings/workflow'
import { WorkflowStore } from '../src/bindings/workflow-store'
import { runMigrations } from '../src/db'
import { createTestEnv } from '../src/testing'
import { TestClock } from '../src/testing/clock'
import { TestWorkflowBinding } from '../src/testing/workflow'

let db: Database
let bindings: SqliteWorkflowBinding[]
beforeEach(() => {
	db = new Database(':memory:')
	runMigrations(db)
	bindings = []
})
afterEach(async () => {
	for (const binding of bindings) binding.abortRunning()
	await Bun.sleep(10)
	db.close()
})
function bind(run: (step: WorkflowStepImpl) => Promise<unknown>, limits: WorkflowLimits = {}, name = 'OCCURRENCES') {
	class Workflow extends WorkflowEntrypointBase {
		override run(_event: unknown, step: WorkflowStepImpl) {
			return run(step)
		}
	}
	const binding = new SqliteWorkflowBinding(db, name, 'Workflow', { defaultRetryDelayMs: 1, defaultRetryLimit: 0, ...limits })
	binding._setClass(Workflow, {})
	bindings.push(binding)
	return binding
}
async function until(predicate: () => boolean | Promise<boolean>) {
	const deadline = Date.now() + 3000
	while (!await predicate()) {
		if (Date.now() > deadline) throw new Error('Occurrence test timed out')
		await Bun.sleep(5)
	}
}
async function terminal(instance: { status(): Promise<{ status: string }> }) {
	await until(async () => ['complete', 'errored', 'terminated'].includes((await instance.status()).status))
}

for (const route of ['create', 'get', 'helper', 'forwarded-control']) {
	test.each([10, 51])(`${route} sends use the receiving binding clock at %i ms`, async at => {
		const clock = new TestClock(0)
		class Workflow extends WorkflowEntrypointBase {
			override async run(_event: unknown, step: WorkflowStepImpl) {
				const event = await step.waitForEvent('gate', { type: 'go', timeout: '50 ms' })
				return { payload: event.payload, type: event.type, timestamp: event.timestamp.getTime(), isDate: event.timestamp instanceof Date }
			}
		}
		const binding = new SqliteWorkflowBinding(db, 'CLOCK', 'Workflow', { minWaitForEventTimeoutMs: 1 }, clock)
		binding._setClass(Workflow, {})
		bindings.push(binding)
		const instance = await binding.create({ id: 'historical-clock' })
		await until(async () => (await instance.status()).status === 'waiting')
		const store = new WorkflowStore(db)
		expect(store.readDetail(instance.id, 'CLOCK').occurrences[0]?.deadline).toBe(50)
		clock.advance(at)
		const event = { type: 'go', payload: 'clock-payload' }
		const helper = new TestWorkflowBinding(binding, db)
		if (route === 'create') await instance.sendEvent(event)
		else if (route === 'get') await (await binding.get(instance.id)).sendEvent(event)
		else if (route === 'helper') await (await helper.get(instance.id)).sendEvent(event)
		else {
			const proxy = new SqliteWorkflowBinding(db, 'CLOCK', 'Workflow')
			proxy._setThreadRouter(op => binding.executeControl(op))
			await proxy.executeControl({ kind: 'sendEvent', instanceId: instance.id, eventType: event.type, payload: event.payload })
		}
		await terminal(instance)
		const status = await instance.status()
		if (at === 10) {
			expect(status.status).toBe('complete')
			expect(status.output).toEqual({ payload: 'clock-payload', type: 'go', timestamp: 10, isDate: true })
		} else {
			expect(status.status).toBe('errored')
			expect(status.error?.message).toContain('timed out')
			expect(store.readDetail(instance.id, 'CLOCK').occurrences[0]?.checkpoint).toBeNull()
			expect(db.query<{ created_at: number }, [string]>('SELECT created_at FROM workflow_events WHERE instance_id = ?').get(instance.id)?.created_at)
				.toBe(51)
		}
		helper.dispose()
	})
}

test.each(['before', 'after'])('recovery enforces the saved deadline when an event arrives %s it', async arrival => {
	const binding = bind(async step => (await step.waitForEvent('gate', { type: 'go', timeout: '200 ms' })).payload, { minWaitForEventTimeoutMs: 1 })
	const instance = await binding.create()
	await until(async () => (await instance.status()).status === 'waiting')
	const store = new WorkflowStore(db)
	const deadline = store.readDetail(instance.id, 'OCCURRENCES').occurrences[0]?.deadline
	if (typeof deadline !== 'number') throw new Error('Wait deadline was not saved')
	binding.abortRunning()
	await Bun.sleep(10)
	if (arrival === 'before') await instance.sendEvent({ type: 'go', payload: 'on-time' })
	await Bun.sleep(Math.max(0, deadline - Date.now()) + 20)
	if (arrival === 'after') await instance.sendEvent({ type: 'go', payload: 'late' })
	binding.resumeInterrupted()
	await terminal(instance)
	const status = await instance.status()
	if (arrival === 'before') {
		expect(status.status).toBe('complete')
		expect(status.output).toBe('on-time')
	} else {
		expect(status.status).toBe('errored')
		expect(status.error?.message).toContain('timed out')
		expect(store.readDetail(instance.id, 'OCCURRENCES').occurrences[0]?.checkpoint).toBeNull()
		expect(db.query<{ payload: string }, [string]>('SELECT payload FROM workflow_events WHERE instance_id = ?').get(instance.id)?.payload).toBe(
			'"late"',
		)
	}
})

test('corrupt completed compensation history terminates recovery without repeating effects or compensating', async () => {
	let effects = 0
	let compensations = 0
	const binding = bind(async step => {
		for (const name of ['safe', 'corrupt']) {
			await step.do(name, async () => ++effects, {
				rollback: async () => {
					compensations++
				},
			})
		}
		await step.waitForEvent('gate', { type: 'go' })
	})
	const instance = await binding.create()
	await until(async () => (await instance.status()).status === 'waiting')
	binding.abortRunning()
	await Bun.sleep(20)
	const token = new WorkflowStore(db).currentToken(instance.id)
	db.query("UPDATE workflow_occurrences SET output_kind = NULL, output = NULL WHERE incarnation = ? AND name = 'corrupt'").run(token.incarnation)
	binding.resumeInterrupted()
	await terminal(instance)
	const status = await instance.status()
	expect(status.status).toBe('errored')
	expect(status.error?.name).toBe('WorkflowRecoveryError')
	expect(status.error?.message).toContain('Original failure:')
	expect(status.error?.message).toContain('Storage failure:')
	expect(status.error?.message).toContain('"corrupt" #1')
	expect(status.error?.message).toContain('has no checkpoint')
	expect(status.rollback).toBeNull()
	expect(effects).toBe(2)
	expect(compensations).toBe(0)
	binding.resumeInterrupted()
	await Bun.sleep(10)
	expect(effects).toBe(2)
	expect((await instance.status()).status).toBe('errored')
})

test('an expired earlier waiter releases an on-time inbox event to the next waiter during recovery', async () => {
	const binding = bind(async step =>
		Promise.all([
			step.waitForEvent('gate', { type: 'go', timeout: '100 ms' }).then(event => event.payload, () => 'timed out'),
			step.waitForEvent('gate', { type: 'go', timeout: '400 ms' }).then(event => event.payload),
		]), { minWaitForEventTimeoutMs: 1 })
	const instance = await binding.create()
	await until(async () => (await instance.status()).status === 'waiting')
	const rows = new WorkflowStore(db).readDetail(instance.id, 'OCCURRENCES').occurrences
	const firstDeadline = rows[0]?.deadline
	const secondDeadline = rows[1]?.deadline
	if (typeof firstDeadline !== 'number' || typeof secondDeadline !== 'number') throw new Error('Missing wait deadlines')
	binding.abortRunning()
	await Bun.sleep(Math.max(0, firstDeadline - Date.now()) + 20)
	await instance.sendEvent({ type: 'go', payload: 'second waiter' })
	await Bun.sleep(Math.max(0, secondDeadline - Date.now()) + 20)
	binding.resumeInterrupted()
	await terminal(instance)
	expect((await instance.status()).output).toEqual(['timed out', 'second waiter'])
})

test('helper disposal cleans every tracked instance after configured retention removes an earlier instance', async () => {
	const binding = bind(async step => step.do('value', async () => 'real'), { maxRetentionMs: 1 })
	const helper = new TestWorkflowBinding(binding, db)
	const expired = await helper.prepare({ id: 'expired-helper' })
	expired.mockStep('value', 'mocked').mockEvent({ type: 'unused' }).mockEventTimeout('unused').disableSleeps()
	let removed = 0
	expired._addUnsub(() => {
		removed++
	})
	await expired.start()
	await expired.waitForStatus('complete')
	let settledAfterDisposal = 0
	for (const pending of [expired.waitForStep('never'), expired.waitForEvent('never'), expired.skipSleep(), expired.waitForStatus('paused')]) {
		pending.then(() => {
			settledAfterDisposal++
		}, () => {
			settledAfterDisposal++
		})
	}
	await Bun.sleep(10)
	const replacement = await helper.create({ id: 'replacement-helper' })
	replacement._addUnsub(() => {
		removed++
	})
	await replacement.waitForStatus('complete')
	await expect(binding.get(expired.id)).rejects.toThrow('not found')
	expect(() => helper.dispose()).not.toThrow()
	expect(removed).toBe(2)
	expect(() => helper.dispose()).not.toThrow()
	expect(removed).toBe(2)
	await Bun.sleep(5100)
	expect(settledAfterDisposal).toBe(0)
}, 10000)

test('TestEnv closes its database after configured retention expires a tracked workflow helper', async () => {
	class Workflow extends WorkflowEntrypointBase {
		override async run(_event: unknown, step: WorkflowStepImpl) {
			return step.do('value', async () => 'real')
		}
	}
	const env = await createTestEnv<{ WF: SqliteWorkflowBinding }>({
		worker: { default: { fetch: () => new Response('ok') }, Workflow },
		bindings: { WF: { type: 'workflow', className: 'Workflow' } },
		clock: true,
	})
	env.env.WF._getLimits().maxRetentionMs = 1
	const helper = env.workflow('WF')
	const expired = await helper.prepare({ id: 'expired-env' })
	expired.mockStep('value', 'mocked')
	await expired.start()
	await expired.waitForStatus('complete')
	await env.advanceTime(2)
	const replacement = await helper.create({ id: 'replacement-env' })
	await replacement.waitForStatus('complete')
	await expect(env.env.WF.get(expired.id)).rejects.toThrow('not found')
	expect(() => env.dispose()).not.toThrow()
	expect(() => env.db.query('SELECT 1').get()).toThrow()
})

test('repeated names keep retry and compensation context and reverse invocation order', async () => {
	const attempts: [number, number][] = []
	const undos: [number, number, number | undefined][] = []
	const binding = bind(async step => {
		await Promise.all([1, 2, 3].map(n =>
			step.do('same', { retries: { limit: 1, delay: 1 } }, async ctx => {
				attempts.push([ctx.step.count, ctx.attempt])
				if (n === 2 && ctx.attempt === 1) throw new Error('retry only the second occurrence')
				await Bun.sleep((4 - n) * 5)
				return n
			}, {
				rollback: async ({ ctx, output }) => {
					undos.push([ctx.step.count, ctx.attempt, output])
				},
			})
		))
		throw new Error('compensate')
	})
	const instance = await binding.create()
	await terminal(instance)
	expect(attempts).toEqual([[1, 1], [2, 1], [3, 1], [2, 2]])
	expect(undos).toEqual([[3, 1, 3], [2, 2, 2], [1, 1, 1]])
	expect((await instance.status()).rollback?.outcome).toBe('complete')
})

test('mixed names, shared sleep namespace, concurrent waits and precise restart', async () => {
	const effects: number[] = []
	const binding = bind(async step => {
		const first = await step.do('same', async ({ step }) => {
			effects.push(step.count)
			return step.count
		})
		await Promise.all([step.sleep('same', 0), step.sleepUntil('same', 0)])
		const waits = await Promise.all([step.waitForEvent('same', { type: 'go' }), step.waitForEvent('same', { type: 'go' })])
		const last = await step.do('same', async ({ step }) => {
			effects.push(step.count)
			return step.count
		})
		return { first, last, events: waits.map(event => event.payload) }
	}, { maxStepsPerWorkflow: 4 })
	const instance = await binding.create()
	await until(async () => (await instance.status()).status === 'waiting')
	await instance.sendEvent({ type: 'go', payload: 'first' })
	await Bun.sleep(10)
	expect((await instance.status()).status).not.toBe('complete')
	await instance.sendEvent({ type: 'go', payload: 'second' })
	await terminal(instance)
	expect((await instance.status()).output).toEqual({ first: 1, last: 2, events: ['first', 'second'] })
	const store = new WorkflowStore(db)
	expect(store.readDetail(instance.id, 'OCCURRENCES').occurrences.map(row => row.key)).toEqual([
		{ type: 'do', name: 'same', count: 1 },
		{ type: 'sleep', name: 'same', count: 1 },
		{ type: 'sleep', name: 'same', count: 2 },
		{ type: 'waitForEvent', name: 'same', count: 1 },
		{ type: 'waitForEvent', name: 'same', count: 2 },
		{ type: 'do', name: 'same', count: 2 },
	])
	await instance.restart({ from: { name: 'same', count: 2, type: 'waitForEvent' } })
	await until(async () => (await instance.status()).status === 'waiting')
	await instance.sendEvent({ type: 'go', payload: 'replacement' })
	await terminal(instance)
	expect((await instance.status()).output).toEqual({ first: 1, last: 2, events: ['first', 'replacement'] })
	expect(effects).toEqual([1, 2, 2])
})

test('sleepUntil replay uses the committed deadline and timers are occurrence scoped', async () => {
	let deadline = Date.now() + 1000
	const binding = bind(async step => {
		await Promise.all([step.sleepUntil('nap', deadline), step.sleepUntil('nap', deadline + 10)])
		return 'awake'
	})
	const instance = await binding.create()
	await until(() => new WorkflowStore(db).readDetail(instance.id, 'OCCURRENCES').occurrences.every(row => row.deadline !== null))
	const saved = new WorkflowStore(db).readDetail(instance.id, 'OCCURRENCES').occurrences.map(row => row.deadline)
	binding.abortRunning()
	await Bun.sleep(20)
	deadline += 100_000
	binding.resumeInterrupted()
	await Bun.sleep(20)
	expect(new WorkflowStore(db).readDetail(instance.id, 'OCCURRENCES').occurrences.map(row => row.deadline)).toEqual(saved)
	await instance.skipSleep()
	await terminal(instance)
	expect((await instance.status()).output).toBe('awake')
})

test('partial restart orders tied checkpoints by invocation and preserves the exact prefix', async () => {
	let calls = 0
	class Workflow extends WorkflowEntrypointBase {
		override async run(_event: unknown, step: WorkflowStepImpl) {
			return [await step.do('same', async () => ++calls), await step.do('same', async () => ++calls), await step.do('same', async () => ++calls)]
		}
	}
	const binding = new SqliteWorkflowBinding(db, 'TIED', 'Workflow', {}, { now: () => 42 })
	bindings.push(binding)
	binding._setClass(Workflow, {})
	const instance = await binding.create()
	await terminal(instance)
	expect(new WorkflowStore(db).readDetail(instance.id, 'TIED').occurrences.map(row => row.completedAt)).toEqual([42, 42, 42])
	await instance.restart({ from: { name: 'same', count: 2 } })
	await terminal(instance)
	expect((await instance.status()).output).toEqual([1, 4, 5])
})

test('wait deadlines survive replay and oversized event checkpoints leave the inbox intact', async () => {
	const binding = bind(async step => step.waitForEvent('gate', { type: 'go', timeout: '150 ms' }), { minWaitForEventTimeoutMs: 1 })
	const instance = await binding.create()
	await until(async () => (await instance.status()).status === 'waiting')
	const store = new WorkflowStore(db)
	const deadline = store.readDetail(instance.id, 'OCCURRENCES').occurrences[0]?.deadline
	await Bun.sleep(50)
	binding.abortRunning()
	await Bun.sleep(10)
	binding.resumeInterrupted()
	await Bun.sleep(10)
	expect(store.readDetail(instance.id, 'OCCURRENCES').occurrences[0]?.deadline).toBe(deadline)
	await terminal(instance)
	expect((await instance.status()).error?.message).toContain('timed out')
	const small = bind(async step => step.waitForEvent('gate', { type: 'go' }), { maxStepOutputBytes: 10 }, 'SMALL')
	const waiting = await small.create()
	await until(async () => (await waiting.status()).status === 'waiting')
	await waiting.sendEvent({ type: 'go', payload: 'cannot fit' })
	await terminal(waiting)
	expect((await waiting.status()).error?.message).toContain('output exceeds')
	expect(store.readDetail(waiting.id, 'SMALL').occurrences[0]?.checkpoint).toBeNull()
	expect(db.query<{ payload: string }, [string]>('SELECT payload FROM workflow_events WHERE instance_id = ?').get(waiting.id)?.payload).toBe(
		'"cannot fit"',
	)
})

test('restart validates before abort, fences old attempts and waits for their actual settlement', async () => {
	const release = Promise.withResolvers<void>()
	let calls = 0
	let active = 0
	let overlap = false
	const binding = bind(async step =>
		step.do('work', async () => {
			calls++
			active++
			if (active > 1) overlap = true
			if (calls === 1) await release.promise
			active--
			return calls
		})
	)
	const instance = await binding.create()
	await until(() => calls === 1)
	await expect(instance.restart({ from: { name: 'missing' } })).rejects.toThrow('not found')
	expect((await instance.status()).status).toBe('running')
	const restarted = instance.restart()
	await Bun.sleep(20)
	expect(calls).toBe(1)
	release.resolve()
	await restarted
	await terminal(instance)
	expect(calls).toBe(2)
	expect(overlap).toBe(false)
	expect((await instance.status()).output).toBe(2)
})

test('ownership and separate memory databases isolate the same public ID', async () => {
	const first = bind(async step => (await step.waitForEvent('gate', { type: 'go' })).payload)
	const instance = await first.create({ id: 'same' })
	await expect(bind(async () => null, {}, 'OTHER').get('same')).rejects.toThrow('not found')
	const otherDb = new Database(':memory:')
	runMigrations(otherDb)
	const second = new SqliteWorkflowBinding(otherDb, 'OCCURRENCES', 'Workflow')
	const workflow = first._getClass()
	if (!workflow) throw new Error('Missing workflow class')
	second._setClass(workflow, {})
	try {
		const other = await second.create({ id: 'same' })
		await until(async () => (await other.status()).status === 'waiting' && (await instance.status()).status === 'waiting')
		await instance.sendEvent({ type: 'go', payload: 1 })
		await terminal(instance)
		expect((await other.status()).status).toBe('waiting')
		await other.sendEvent({ type: 'go', payload: 2 })
		await terminal(other)
		expect((await instance.status()).output).toBe(1)
		expect((await other.status()).output).toBe(2)
	} finally {
		second.abortRunning()
		await Bun.sleep(10)
		otherDb.close()
	}
})

test('typed helper selection preserves name-only first-match reads and mocks', async () => {
	const binding = bind(async step => [await step.do('same', async () => 1), await step.do('same', async () => 2)])
	const helper = new TestWorkflowBinding(binding, db)
	const instance = await helper.prepare()
	instance.mockStep('same', 99, { type: 'do', count: 2 })
	await instance.start()
	await instance.waitForStatus('complete')
	expect(await instance.stepResult('same')).toBe(1)
	expect(await instance.waitForStep('same', { type: 'do', count: 2 })).toBe(99)
	helper.dispose()
})

test('a timed-out forward callback holds compensation until actual settlement', async () => {
	const forward = Promise.withResolvers<void>()
	let compensated = false
	let started = false
	const binding = bind(async step =>
		step.do('blocked', { timeout: 5 }, async () => {
			started = true
			await forward.promise
		}, {
			rollback: async () => {
				compensated = true
			},
		})
	)
	const instance = await binding.create()
	await until(() => started)
	await Bun.sleep(50)
	expect((await instance.status()).status).toBe('running')
	expect(compensated).toBe(false)
	forward.resolve()
	await terminal(instance)
	expect(compensated).toBe(true)
	expect((await instance.status()).rollback?.outcome).toBe('complete')
})

test('ordinary create preserves old terminal records when retention is not configured', async () => {
	const binding = bind(async step => step.do('value', async () => 'kept'))
	const old = await binding.create({ id: 'kept' })
	await terminal(old)
	db.query("UPDATE workflow_instances SET updated_at = 1 WHERE id = 'kept'").run()
	const next = await binding.create({ id: 'new' })
	await terminal(next)
	expect((await old.status()).output).toBe('kept')
	expect(new WorkflowStore(db).readDetail(old.id, 'OCCURRENCES').occurrences[0]?.checkpoint).toEqual({ kind: 'json', serialized: '"kept"' })
})

test('custom output/step limits remain enforced and configured retention removes all owned records', async () => {
	const small = bind(async step => step.do('large', async () => 'too large'), { maxStepOutputBytes: 4 })
	const oversized = await small.create()
	await terminal(oversized)
	expect((await oversized.status()).error?.message).toContain('output exceeds')
	const limited = bind(
		async step => {
			await step.sleep('free', 0)
			await step.do('same', async () => 1)
			return step.do('same', async () => 2)
		},
		{ maxStepsPerWorkflow: 1 },
		'LIMITED',
	)
	const tooMany = await limited.create()
	await terminal(tooMany)
	expect((await tooMany.status()).error?.message).toContain('maximum of 1 steps')
	const retained = bind(async step => step.do('value', async () => 1), { maxRetentionMs: 1 }, 'RETAINED')
	const old = await retained.create({ id: 'reused' })
	await terminal(old)
	const store = new WorkflowStore(db)
	const token = store.currentToken(old.id)
	const occurrence = store.readDetail(old.id, 'RETAINED').occurrences[0]!
	await Bun.sleep(5)
	const next = await retained.create({ id: 'reused' })
	await terminal(next)
	expect(store.currentToken(next.id).incarnation).not.toBe(token.incarnation)
	expect(() => store.commitCheckpoint({ token, occurrenceId: occurrence.id }, { kind: 'json', serialized: '"stale"' }, Date.now())).toThrow('Stale')
	await expect(old.status()).rejects.toThrow('no longer exists')
	expect((await next.status()).output).toBe(1)
})

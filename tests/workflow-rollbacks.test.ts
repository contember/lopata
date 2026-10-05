import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkflowInstanceStatus, WorkflowLimits, WorkflowStepImpl } from '../src/bindings/workflow'
import { NonRetryableError, SqliteWorkflowBinding, WorkflowEntrypointBase } from '../src/bindings/workflow'
import { runMigrations } from '../src/db'
import { TestWorkflowBinding } from '../src/testing/workflow'

let db: Database
let bindings: SqliteWorkflowBinding[]
let directories: string[]

beforeEach(() => {
	db = new Database(':memory:')
	runMigrations(db)
	bindings = []
	directories = []
})

afterEach(async () => {
	for (const binding of bindings) binding.abortRunning()
	await Bun.sleep(10)
	db.close()
	for (const directory of directories) rmSync(directory, { recursive: true, force: true })
})

function bind(run: (step: WorkflowStepImpl) => Promise<unknown>, name = 'rollback-test', limits: WorkflowLimits = {}): SqliteWorkflowBinding {
	class Saga extends WorkflowEntrypointBase {
		override async run(_event: unknown, step: WorkflowStepImpl): Promise<unknown> {
			return run(step)
		}
	}
	const binding = new SqliteWorkflowBinding(db, name, 'Saga', { defaultRetryLimit: 0, defaultRetryDelayMs: 1, ...limits })
	binding._setClass(Saga, {})
	bindings.push(binding)
	return binding
}

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 2_000
	while (!await predicate()) {
		if (Date.now() >= deadline) throw new Error('Workflow condition timed out')
		await Bun.sleep(5)
	}
}

async function terminal(instance: { status(): Promise<WorkflowInstanceStatus> }): Promise<WorkflowInstanceStatus> {
	await until(async () => ['complete', 'errored', 'terminated'].includes((await instance.status()).status))
	return instance.status()
}

describe('Workflow saga rollback', () => {
	test('unwinds inverse start order, waits for parallel forward steps, and supports both overloads', async () => {
		const effects: string[] = []
		const gate = Promise.withResolvers<void>()
		const binding = bind(async step => {
			const first = step.do('first', async ctx => {
				expect(ctx.step).toEqual({ name: 'first', count: 1 })
				expect(ctx.attempt).toBe(1)
				await gate.promise
				effects.push('first-done')
				return { token: 'first-output' }
			}, {
				rollback: async ({ ctx, output, error }) => {
					expect(ctx.step.name).toBe('first')
					expect(output?.token).toBe('first-output')
					expect(error.message).toBe('terminal failure')
					effects.push('undo-first')
				},
			})
			const second = step.do('second', { retries: { limit: 0 }, timeout: 100 }, async () => {
				effects.push('second-done')
				return 2
			}, {
				rollback: async ({ output }) => {
					expect(output).toBe(2)
					effects.push('undo-second')
				},
			})
			const failure = step.do('failure', async () => {
				throw new Error('terminal failure')
			}, {
				rollback: async ({ output }) => {
					expect(output).toBeUndefined()
					effects.push('undo-failure')
				},
			})
			return Promise.all([first, second, failure])
		})
		const instance = await binding.create()
		await until(() => effects.includes('second-done'))
		expect(effects).toEqual(['second-done'])
		expect((await instance.status()).status).toBe('running')
		gate.resolve()
		const status = await terminal(instance)
		expect(effects).toEqual(['second-done', 'first-done', 'undo-failure', 'undo-second', 'undo-first'])
		expect(status.error).toEqual({ name: 'Error', message: 'terminal failure' })
		expect(status.rollback).toEqual({ outcome: 'complete', error: null })
	})

	test.each([false, true])('caught step failure compensates only if the workflow later fails: %s', async laterFailure => {
		const effects: string[] = []
		const binding = bind(async step => {
			try {
				await step.do('partially-applied', async () => {
					throw new NonRetryableError('caught step failure')
				}, {
					rollback: async ({ output, error }) => {
						expect(output).toBeUndefined()
						expect(error.message).toBe('later failure')
						effects.push('undo')
					},
				})
			} catch {
				effects.push('caught')
			}
			if (laterFailure) throw new TypeError('later failure')
			return 'success'
		})
		const status = await terminal(await binding.create())
		expect(effects).toEqual(laterFailure ? ['caught', 'undo'] : ['caught'])
		expect(status.status).toBe(laterFailure ? 'errored' : 'complete')
		expect(status.rollback).toEqual(laterFailure ? { outcome: 'complete', error: null } : null)
	})

	test('rollback retries use dynamic delay context and preserve forward context', async () => {
		const attempts: number[] = []
		let count = 0
		const binding = bind(async step => {
			await step.do('reserve', async () => 'reservation', {
				rollback: async ({ ctx, output }) => {
					expect(ctx.attempt).toBe(1)
					expect(output).toBe('reservation')
					if (++count < 3) throw new Error('temporary compensation error')
				},
				rollbackConfig: {
					retries: {
						limit: 2,
						delay: ({ ctx, error }) => {
							attempts.push(ctx.attempt)
							expect(error.message).toBe('temporary compensation error')
							return 1
						},
					},
				},
			})
			throw new Error('original failure')
		})
		const status = await terminal(await binding.create())
		expect(count).toBe(3)
		expect(attempts).toEqual([1, 2])
		expect(status.error?.message).toBe('original failure')
		expect(status.rollback).toEqual({ outcome: 'complete', error: null })
	})

	test('forward retry context is exposed and the final forward context reaches compensation', async () => {
		const contexts: number[] = []
		const binding = bind(async step => {
			await step.do('retry-forward', {
				retries: {
					limit: 1,
					delay: async ({ ctx, error }) => {
						expect(ctx.attempt).toBe(1)
						expect(error.message).toBe('retry forward')
						return 0
					},
				},
				timeout: 100,
			}, async ctx => {
				contexts.push(ctx.attempt)
				if (ctx.attempt === 1) throw new Error('retry forward')
				return 'retried output'
			}, {
				rollback: async ({ ctx, output }) => {
					expect(ctx.attempt).toBe(2)
					expect(ctx.config.timeout).toBe(100)
					expect(output).toBe('retried output')
				},
			})
			throw new Error('later failure')
		})
		const status = await terminal(await binding.create())
		expect(contexts).toEqual([1, 2])
		expect(status.rollback).toEqual({ outcome: 'complete', error: null })
	})

	test('timed-out callbacks settle their actual effects before compensation and remain eligible with undefined output', async () => {
		const gate = Promise.withResolvers<void>()
		const started = Promise.withResolvers<void>()
		const effects: string[] = []
		let undo = 0
		const binding = bind(async step => {
			await step.do('partial', { timeout: 5 }, async () => {
				started.resolve()
				await gate.promise
				effects.push('forward-effect')
			}, {
				rollback: async ({ output }) => {
					expect(output).toBeUndefined()
					effects.push('rollback-effect')
					undo++
				},
			})
		})
		const instance = await binding.create()
		await started.promise
		await Bun.sleep(60)
		expect(undo).toBe(0)
		expect((await instance.status()).status).toBe('running')
		gate.resolve()
		const status = await terminal(instance)
		expect(effects).toEqual(['forward-effect', 'rollback-effect'])
		expect(undo).toBe(1)
		expect(status.error?.message).toContain('timed out')
		expect(status.rollback).toEqual({ outcome: 'complete', error: null })
	})

	test.each(['running', 'before-start'])('default termination advances queued work when terminated %s', async mode => {
		const binding = bind(
			async step => {
				await step.waitForEvent('approval', { type: 'approval' })
				return 'done'
			},
			'queued-termination',
			{ maxConcurrentInstances: 1 },
		)
		const first = mode === 'before-start' ? await binding._createPrepared({ id: 'active' }) : await binding.create({ id: 'active' })
		const second = mode === 'before-start' ? await binding._createPrepared({ id: 'next' }) : await binding.create({ id: 'next' })
		if (mode === 'before-start') binding._executeInstance(first.id)
		else await until(async () => (await first.status()).status === 'waiting')
		expect((await second.status()).status).toBe('queued')
		await first.terminate()
		await until(async () => (await second.status()).status === 'waiting')
		await second.sendEvent({ type: 'approval' })
		expect((await terminal(second)).output).toBe('done')
	})

	test('reload abort does not advance the workflow queue', async () => {
		const binding = bind(
			async step => {
				await step.waitForEvent('approval', { type: 'approval' })
			},
			'queued-reload',
			{ maxConcurrentInstances: 1 },
		)
		const first = await binding.create()
		const second = await binding.create()
		await until(async () => (await first.status()).status === 'waiting')
		binding.abortRunning()
		await Bun.sleep(20)
		expect((await second.status()).status).toBe('queued')
	})

	test('terminate with rollback during failure compensation preserves its original error and errored target', async () => {
		const delay = Promise.withResolvers<number>()
		const seen: string[] = []
		const binding = bind(async step => {
			await step.do('reserve', async () => 1, {
				rollback: async ({ error }) => {
					seen.push(`${error.name}:${error.message}`)
					if (seen.length === 1) throw new Error('retry compensation')
				},
				rollbackConfig: { retries: { limit: 1, delay: () => delay.promise } },
			})
			throw new TypeError('original failure')
		})
		const instance = await binding.create()
		await until(() => seen.length === 1)
		const termination = instance.terminate({ rollback: true })
		expect((await instance.status()).error).toEqual({ name: 'TypeError', message: 'original failure' })
		delay.resolve(0)
		await termination
		const status = await terminal(instance)
		expect(status.status).toBe('errored')
		expect(status.error).toEqual({ name: 'TypeError', message: 'original failure' })
		expect(seen).toEqual(['TypeError:original failure', 'TypeError:original failure'])
	})

	test.each(['forward', 'rollback'])('blocked %s retry delay calculations are cancelled by reload and recover', async mode => {
		let calculations = 0
		let forward = 0
		let undo = 0
		const delay = () => {
			calculations++
			return new Promise<number>(() => {})
		}
		const run = async (step: WorkflowStepImpl) => {
			await step.do('reserve', { retries: { limit: 1, delay } }, async () => {
				if (++forward === 1 && mode === 'forward') throw new Error('retry forward')
				return 1
			}, {
				rollback: async () => {
					if (++undo === 1 && mode === 'rollback') throw new Error('retry compensation')
				},
				rollbackConfig: { retries: { limit: 1, delay } },
			})
			throw new Error('terminal failure')
		}
		const binding = bind(run)
		const instance = await binding.create()
		await until(() => calculations === 1)
		binding.abortRunning()
		await Bun.sleep(20)
		bind(run).resumeInterrupted()
		const status = await terminal(instance)
		expect(status.rollback).toEqual({ outcome: 'complete', error: null })
		expect(forward).toBe(mode === 'forward' ? 2 : 1)
		expect(undo).toBe(mode === 'rollback' ? 2 : 1)
	})

	test('restart cancels a blocked asynchronous retry delay calculation', async () => {
		let calculations = 0
		let attempts = 0
		const binding = bind(async step =>
			step.do('reserve', {
				retries: {
					limit: 1,
					delay: () => {
						calculations++
						return new Promise<number>(() => {})
					},
				},
			}, async () => {
				if (++attempts === 1) throw new Error('retry')
				return 'restarted'
			})
		)
		const instance = await binding.create()
		await until(() => calculations === 1)
		await instance.restart()
		expect((await terminal(instance)).output).toBe('restarted')
		expect(attempts).toBe(2)
	})

	test('testing helper forwards rollback termination and exposes its outcome', async () => {
		let undo = 0
		const binding = bind(async step => {
			await step.do('reserve', async () => 1, {
				rollback: async () => {
					undo++
				},
			})
			await step.waitForEvent('approval', { type: 'approval' })
		})
		const helper = new TestWorkflowBinding(binding, db)
		try {
			const instance = await helper.create()
			await instance.waitForEvent('approval')
			await instance.terminate({ rollback: true })
			expect((await instance.status()).rollback).toEqual({ outcome: 'complete', error: null })
			expect((await instance.waitForStatus('terminated')).status).toBe('terminated')
			expect(undo).toBe(1)
		} finally {
			helper.dispose()
		}
	})

	test.each(['retry', 'timeout', 'non-retryable'])('stops remaining compensation after %s failure and retains original error', async mode => {
		const effects: string[] = []
		let attempts = 0
		const binding = bind(async step => {
			await step.do('earlier', async () => 1, {
				rollback: async () => {
					effects.push('must-not-run')
				},
			})
			await step.do('latest', async () => 2, {
				rollback: async () => {
					attempts++
					if (mode === 'timeout') await new Promise<void>(() => {})
					if (mode === 'non-retryable') throw new NonRetryableError('cannot compensate')
					throw new RangeError('cannot compensate')
				},
				rollbackConfig: { retries: { limit: 1, delay: 1 }, timeout: 10 },
			})
			throw new TypeError('forward failure')
		})
		const status = await terminal(await binding.create())
		expect(effects).toEqual([])
		expect(attempts).toBe(mode === 'non-retryable' ? 1 : 2)
		expect(status.error).toEqual({ name: 'TypeError', message: 'forward failure' })
		expect(status.rollback?.outcome).toBe('failed')
		expect(status.rollback?.error?.message).toContain(mode === 'timeout' ? 'timed out' : 'cannot compensate')
	})

	test.each([false, true])('terminate rollback option controls compensation: %s', async rollback => {
		const effects: string[] = []
		const binding = bind(async step => {
			await step.do('reserve', async () => undefined, {
				rollback: async ({ output }) => {
					expect(output).toBeUndefined()
					effects.push('undo')
				},
			})
			await step.waitForEvent('approval', { type: 'approval' })
		})
		const instance = await binding.create()
		await until(async () => (await instance.status()).status === 'waiting')
		await (await binding.get(instance.id)).terminate({ rollback })
		const status = await terminal(instance)
		expect(status.status).toBe('terminated')
		expect(effects).toEqual(rollback ? ['undo'] : [])
		expect(status.rollback).toEqual(rollback ? { outcome: 'complete', error: null } : null)
	})

	test('rollback termination settles in-flight forward steps before compensation', async () => {
		const effects: string[] = []
		const gate = Promise.withResolvers<void>()
		const binding = bind(async step => {
			await step.do('reserve', async () => {
				effects.push('started')
				await gate.promise
				effects.push('completed')
				return 'reservation'
			}, {
				rollback: async ({ output }) => {
					expect(output).toBe('reservation')
					effects.push('undo')
				},
			})
			await new Promise<void>(() => {})
		})
		const instance = await binding.create()
		await until(() => effects.includes('started'))
		const terminated = instance.terminate({ rollback: true })
		await Bun.sleep(10)
		expect(effects).toEqual(['started'])
		expect((await instance.status()).status).toBe('running')
		gate.resolve()
		await terminated
		expect(effects).toEqual(['started', 'completed', 'undo'])
		expect((await instance.status()).status).toBe('terminated')
	})

	test('interrupted rollback termination recovers its terminated target status', async () => {
		let forward = 0
		let undo = 0
		const run = async (step: WorkflowStepImpl) => {
			await step.do('reserve', async () => ++forward, {
				rollback: async () => {
					if (++undo === 1) throw new Error('temporary failure')
				},
				rollbackConfig: { retries: { limit: 1, delay: 60_000 } },
			})
			await step.sleep('wait', 60_000)
		}
		const binding = bind(run)
		const instance = await binding.create()
		await until(() => forward === 1)
		const termination = instance.terminate({ rollback: true })
		await until(() => undo === 1)
		binding.abortRunning()
		await termination
		bind(run).resumeInterrupted()
		const status = await terminal(instance)
		expect(status.status).toBe('terminated')
		expect(status.rollback).toEqual({ outcome: 'complete', error: null })
		expect(forward).toBe(1)
		expect(undo).toBe(2)
	})

	test('reload can interrupt the forward drain of an explicit rollback termination', async () => {
		const gate = Promise.withResolvers<void>()
		let forward = 0
		let undo = 0
		const effects: string[] = []
		const run = async (step: WorkflowStepImpl) => {
			await step.do('partial', async () => {
				forward++
				await gate.promise
				effects.push('forward-effect')
				return 'unfinished'
			}, {
				rollback: async ({ output }) => {
					expect(output).toBeUndefined()
					effects.push('rollback-effect')
					undo++
				},
			})
		}
		const binding = bind(run)
		const instance = await binding.create()
		await until(() => forward === 1)
		const termination = instance.terminate({ rollback: true })
		await Bun.sleep(10)
		binding.abortRunning()
		await termination
		expect(undo).toBe(0)
		bind(run).resumeInterrupted()
		await Bun.sleep(20)
		expect(undo).toBe(0)
		expect((await instance.status()).status).toBe('running')
		gate.resolve()
		const status = await terminal(instance)
		expect(status.status).toBe('terminated')
		expect(status.rollback).toEqual({ outcome: 'complete', error: null })
		expect(forward).toBe(1)
		expect(undo).toBe(1)
		expect(effects).toEqual(['forward-effect', 'rollback-effect'])
	})

	test('regular reload reuses completed outputs and does not start rollback', async () => {
		let forward = 0
		let rollback = 0
		const run = async (step: WorkflowStepImpl) => {
			const result = await step.do('reserve', async () => {
				forward++
				return { id: 'reservation' }
			}, {
				rollback: async () => {
					rollback++
				},
			})
			await step.waitForEvent('approval', { type: 'approval' })
			return result
		}
		const binding = bind(run)
		const instance = await binding.create()
		await until(async () => (await instance.status()).status === 'waiting')
		binding.abortRunning()
		await Bun.sleep(10)
		const next = bind(run)
		next.resumeInterrupted()
		await Bun.sleep(10)
		await (await next.get(instance.id)).sendEvent({ type: 'approval' })
		const status = await terminal(instance)
		expect(status.output).toEqual({ id: 'reservation' })
		expect(status.rollback).toBeNull()
		expect(forward).toBe(1)
		expect(rollback).toBe(0)
	})

	test('replay distinguishes undefined outputs from null outputs', async () => {
		let forwards = 0
		const run = async (step: WorkflowStepImpl) => {
			const undefinedOutput = await step.do('undefined-output', async () => {
				forwards++
				return undefined
			})
			const nullOutput = await step.do('null-output', async () => {
				forwards++
				return null
			})
			await step.waitForEvent('approval', { type: 'approval' })
			return { undefinedPreserved: undefinedOutput === undefined, nullPreserved: nullOutput === null }
		}
		const binding = bind(run)
		const instance = await binding.create()
		await until(async () => (await instance.status()).status === 'waiting')
		binding.abortRunning()
		await Bun.sleep(10)
		const next = bind(run)
		next.resumeInterrupted()
		await Bun.sleep(10)
		await (await next.get(instance.id)).sendEvent({ type: 'approval' })
		const status = await terminal(instance)
		expect(status.output).toEqual({ undefinedPreserved: true, nullPreserved: true })
		expect(forwards).toBe(2)
	})

	test('reopens SQLite during rollback, skips completed compensation and failed forward bodies, and resumes attempts', async () => {
		db.close()
		const directory = mkdtempSync(join(tmpdir(), 'workflow-rollbacks-'))
		directories.push(directory)
		const path = join(directory, 'state.sqlite')
		db = new Database(path)
		runMigrations(db)
		let forwards = 0
		let failedForwards = 0
		let completedUndo = 0
		let pendingUndo = 0
		const outputs: (string | undefined)[] = []
		const run = async (step: WorkflowStepImpl) => {
			await step.do('older', async () => {
				forwards++
				return 'persisted-output'
			}, {
				rollback: async ({ output }) => {
					outputs.push(output)
					pendingUndo++
					if (pendingUndo === 1) throw new Error('interrupted retry')
				},
				rollbackConfig: { retries: { limit: 1, delay: 60_000 } },
			})
			await step.do('failed', async () => {
				failedForwards++
				throw new NonRetryableError('original failure')
			}, {
				rollback: async ({ output }) => {
					expect(output).toBeUndefined()
					completedUndo++
				},
			})
		}
		const binding = bind(run)
		const instance = await binding.create({ id: 'recover-rollback' })
		await until(() => pendingUndo === 1)
		expect((await instance.status()).status).toBe('running')
		binding.abortRunning()
		await Bun.sleep(10)
		db.close()
		db = new Database(path)
		runMigrations(db)
		runMigrations(db)
		bindings = []
		const next = bind(run)
		next.resumeInterrupted()
		const recovered = await next.get('recover-rollback')
		const status = await terminal(recovered)
		expect(status.error).toEqual({ name: 'NonRetryableError', message: 'original failure' })
		expect(status.rollback).toEqual({ outcome: 'complete', error: null })
		expect(forwards).toBe(1)
		expect(failedForwards).toBe(1)
		expect(completedUndo).toBe(1)
		expect(pendingUndo).toBe(2)
		expect(outputs).toEqual(['persisted-output', 'persisted-output'])
		next.resumeInterrupted()
		await Bun.sleep(10)
		expect(pendingUndo).toBe(2)
	})

	test.each(['NonRetryableError', 'DomainFailure'])(
		'SQLite recovery preserves original %s NonRetryableError identity in handlers',
		async errorName => {
			db.close()
			const directory = mkdtempSync(join(tmpdir(), 'workflow-failure-identity-'))
			directories.push(directory)
			const path = join(directory, 'state.sqlite')
			db = new Database(path)
			runMigrations(db)
			db.run('ALTER TABLE workflow_rollbacks DROP COLUMN original_non_retryable')
			runMigrations(db)
			let forwards = 0
			const seen: { nonRetryable: boolean; name: string; message: string }[] = []
			const run = async (step: WorkflowStepImpl) => {
				await step.do('reserve', async () => ++forwards, {
					rollback: async ({ error }) => {
						seen.push({ nonRetryable: error instanceof NonRetryableError, name: error.name, message: error.message })
						if (seen.length === 1) throw new Error('retry compensation')
					},
					rollbackConfig: { retries: { limit: 1, delay: 60_000 } },
				})
				throw new NonRetryableError('top-level failure', errorName)
			}
			const binding = bind(run)
			const instance = await binding.create({ id: 'identity-recovery' })
			await until(() => seen.length === 1)
			binding.abortRunning()
			await Bun.sleep(20)
			db.close()
			db = new Database(path)
			runMigrations(db)
			runMigrations(db)
			bindings = []
			const next = bind(run)
			next.resumeInterrupted()
			const status = await terminal(await next.get(instance.id))
			expect(status.error).toEqual({ name: errorName, message: 'top-level failure' })
			expect(status.rollback).toEqual({ outcome: 'complete', error: null })
			expect(seen).toEqual([
				{ nonRetryable: true, name: errorName, message: 'top-level failure' },
				{ nonRetryable: true, name: errorName, message: 'top-level failure' },
			])
			expect(forwards).toBe(1)
		},
	)

	test.each(['native', 'non-retryable'])('replay retains caught %s errors and reaches handlers registered after the catch', async mode => {
		let failedForward = 0
		let completedForward = 0
		const undos: string[] = []
		let attempts = 0
		const ErrorConstructor = mode === 'native' ? TypeError : NonRetryableError
		const run = async (step: WorkflowStepImpl) => {
			try {
				await step.do('caught', async () => {
					failedForward++
					throw new ErrorConstructor('caught')
				}, {
					rollback: async () => {
						undos.push('caught')
					},
				})
			} catch (error) {
				if (!(error instanceof ErrorConstructor)) throw error
			}
			await step.do('after-catch', async () => {
				completedForward++
				return undefined
			}, {
				rollback: async () => {
					if (++attempts === 1) throw new Error('retry')
					undos.push('after-catch')
				},
				rollbackConfig: { retries: { limit: 1, delay: 60_000 } },
			})
			throw new Error('later failure')
		}
		const binding = bind(run)
		const instance = await binding.create()
		await until(() => attempts === 1)
		binding.abortRunning()
		await Bun.sleep(10)
		bind(run).resumeInterrupted()
		const status = await terminal(instance)
		expect(status.rollback).toEqual({ outcome: 'complete', error: null })
		expect(status.error?.message).toBe('later failure')
		expect(undos).toEqual(['after-catch', 'caught'])
		expect(failedForward).toBe(1)
		expect(completedForward).toBe(1)
	})

	test('migration preserves legacy checkpoints and can run repeatedly before recovery', async () => {
		db.run('DROP TABLE workflow_step_history')
		db.run('DROP TABLE workflow_rollbacks')
		db.query('INSERT INTO workflow_instances (id, workflow_name, class_name, params, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
			.run('legacy', 'rollback-test', 'Saga', '{}', 'running', 1, 1)
		db.query('INSERT INTO workflow_steps (instance_id, step_name, output, completed_at) VALUES (?, ?, ?, ?)')
			.run('legacy', 'reserve', JSON.stringify({ id: 'legacy-reservation' }), 1)
		runMigrations(db)
		runMigrations(db)
		let forward = 0
		const outputs: ({ id: string } | undefined)[] = []
		const binding = bind(async step => {
			await step.do('reserve', async () => {
				forward++
				return { id: 'new-reservation' }
			}, {
				rollback: async ({ output }) => {
					outputs.push(output)
				},
			})
			throw new Error('failure after upgrade')
		})
		binding.resumeInterrupted()
		const status = await terminal(await binding.get('legacy'))
		expect(forward).toBe(0)
		expect(outputs).toEqual([{ id: 'legacy-reservation' }])
		expect(status.rollback).toEqual({ outcome: 'complete', error: null })
	})

	test('restart resets rollback checkpoints for a new execution', async () => {
		let forward = 0
		let undo = 0
		const binding = bind(async step => {
			await step.do('reserve', async () => ++forward, {
				rollback: async () => {
					undo++
				},
			})
			throw new Error('failure')
		})
		const instance = await binding.create()
		await terminal(instance)
		await instance.restart()
		await terminal(instance)
		expect(forward).toBe(2)
		expect(undo).toBe(2)
	})
})

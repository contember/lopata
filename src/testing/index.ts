import { randomUUIDv7 } from 'bun'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { SqliteCacheStorage } from '../bindings/cache'
import type { DurableObjectNamespaceImpl } from '../bindings/durable-object'
import { ForwardableEmailMessage } from '../bindings/email'
import { createScheduledController } from '../bindings/scheduled'
import type { SqliteWorkflowBinding } from '../bindings/workflow'
import { setGlobalEnv } from '../env'
import { ExecutionContext, runWithExecutionContext } from '../execution-context'
import { TestDurableObjectNamespace } from './durable-object'
import { buildTestEnv, configToBindings } from './env-builder'
import { setupTestEnv, testCachesRef } from './setup'
import type { TestEnv, TestEnvOptions, WorkerHandlers, WorkerModule } from './types'
import { TestWorkflowBinding } from './workflow'

export type { TestDurableObjectHandle, TestDurableObjectNamespace, TestDurableObjectStorage } from './durable-object'
export type { BindingSpec, TestEnv, TestEnvOptions, WorkerHandlers, WorkerModule } from './types'
export type { TestWorkflowBinding, TestWorkflowInstance, TestWorkflowRun } from './workflow'

export async function createTestEnv<Env = Record<string, unknown>>(options: TestEnvOptions = {}): Promise<TestEnv<Env>> {
	// Ensure virtual modules + globals are registered (no-op if preload already ran)
	setupTestEnv()

	let mergedBindings = options.bindings
	let mergedVars = options.vars

	// Load from wrangler config if specified — translate to BindingSpec
	if (options.wrangler) {
		const { loadConfig } = await import('../config')
		const config = await loadConfig(resolve(options.wrangler))
		const { bindings: configBindings, vars: configVars } = configToBindings(config)
		// Merge: explicit options.bindings override wrangler-derived bindings
		mergedBindings = { ...configBindings, ...options.bindings }
		// Merge: explicit options.vars override wrangler vars
		mergedVars = { ...configVars, ...options.vars }
	}

	const { db, env, registry, tmpDirs } = buildTestEnv(mergedBindings, mergedVars)

	// Wire in-memory caches for this test env
	testCachesRef.current = new SqliteCacheStorage(db)

	// Resolve worker module
	let workerModule: Record<string, unknown>
	let defaultExport: unknown
	let classBasedExport = false

	if (typeof options.worker === 'string') {
		workerModule = await import(resolve(options.worker))
		defaultExport = workerModule.default
		if (typeof defaultExport === 'function' && defaultExport.prototype) {
			classBasedExport = typeof defaultExport.prototype.fetch === 'function'
		}
	} else if (options.worker && 'default' in options.worker) {
		// WorkerModule — has a `default` export (class or object) + named exports
		const mod = options.worker as WorkerModule
		defaultExport = mod.default
		workerModule = { ...mod }
		if (typeof defaultExport === 'function' && defaultExport.prototype) {
			classBasedExport = typeof defaultExport.prototype.fetch === 'function'
		}
	} else if (options.worker) {
		// Inline handlers object — also expose extra properties (e.g. DO/Workflow classes)
		// as top-level module exports so wireClassRefs can find them
		defaultExport = options.worker
		workerModule = { default: defaultExport, ...options.worker }
	} else {
		defaultExport = {}
		workerModule = { default: defaultExport }
	}

	// Wire DO/Workflow classes
	for (const entry of registry.durableObjects) {
		const cls = workerModule[entry.className]
		if (!cls) throw new Error(`Durable Object class "${entry.className}" not exported from worker module`)
		entry.namespace._setClass(cls as any, env)
	}

	for (const entry of registry.workflows) {
		const cls = workerModule[entry.className]
		if (!cls) throw new Error(`Workflow class "${entry.className}" not exported from worker module`)
		entry.binding._setClass(cls as any, env)
		entry.binding.resumeInterrupted()
	}

	// Wire service bindings — self-referencing
	for (const entry of registry.serviceBindings) {
		const wire = entry.proxy._wire as ((resolver: () => { workerModule: Record<string, unknown>; env: Record<string, unknown> }) => void) | undefined
		if (wire) {
			wire(() => ({ workerModule, env }))
		}
	}

	// Set globalEnv so `import { env } from 'cloudflare:workers'` works
	setGlobalEnv(env)

	// --- Handler dispatch helpers ---

	function getHandler(name: string): ((...args: unknown[]) => Promise<unknown>) | undefined {
		if (classBasedExport) {
			if (typeof (defaultExport as any).prototype[name] === 'function') {
				return (...args: unknown[]) => {
					const ctx = new ExecutionContext()
					const instance = new (defaultExport as new(ctx: ExecutionContext, env: unknown) => Record<string, unknown>)(ctx, env)
					return (instance[name] as (...a: unknown[]) => Promise<unknown>)(...args)
				}
			}
			return undefined
		}
		const method = (defaultExport as Record<string, unknown>)?.[name]
		return typeof method === 'function' ? method.bind(defaultExport) : undefined
	}

	async function fetchHandler(input: string | Request, init?: RequestInit): Promise<Response> {
		let request: Request
		if (typeof input === 'string') {
			const url = input.startsWith('/') ? `http://localhost${input}` : input
			request = new Request(url, init)
		} else {
			request = init ? new Request(input, init) : input
		}

		const ctx = new ExecutionContext()
		return runWithExecutionContext(ctx, async () => {
			let response: Response
			if (classBasedExport) {
				const instance = new (defaultExport as new(ctx: ExecutionContext, env: unknown) => Record<string, unknown>)(ctx, env)
				response = await (instance.fetch as (r: Request) => Promise<Response>)(request)
			} else {
				const handler = (defaultExport as Record<string, unknown>)?.fetch
				if (typeof handler !== 'function') {
					throw new Error('No fetch handler found')
				}
				response = await (handler as (r: Request, e: unknown, c: ExecutionContext) => Promise<Response>)(request, env, ctx)
			}
			await ctx._awaitAll()
			return response
		})
	}

	async function queueHandler(queueName: string, messages: { body: unknown; contentType?: string }[]): Promise<void> {
		const handler = getHandler('queue')
		if (!handler) throw new Error('No queue handler found')

		const builtMessages = messages.map((msg, i) => ({
			id: randomUUIDv7(),
			timestamp: new Date(),
			body: msg.body,
			attempts: 1,
			ack() {},
			retry(_options?: { delaySeconds?: number }) {},
		}))

		const batch = {
			queue: queueName,
			messages: builtMessages,
			ackAll() {},
			retryAll(_options?: { delaySeconds?: number }) {},
		}

		const ctx = new ExecutionContext()
		await runWithExecutionContext(ctx, async () => {
			await handler(batch, env, ctx)
			await ctx._awaitAll()
		})
	}

	async function scheduledHandler(opts?: { cron?: string; scheduledTime?: number }): Promise<void> {
		const handler = getHandler('scheduled')
		if (!handler) throw new Error('No scheduled handler found')

		const controller = createScheduledController(opts?.cron ?? '* * * * *', opts?.scheduledTime ?? Date.now())
		const ctx = new ExecutionContext()
		await runWithExecutionContext(ctx, async () => {
			await handler(controller, env, ctx)
			await ctx._awaitAll()
		})
	}

	async function emailHandler(opts: { from: string; to: string; raw: Uint8Array | string }): Promise<void> {
		const handler = getHandler('email')
		if (!handler) throw new Error('No email handler found')

		const rawBytes = typeof opts.raw === 'string' ? new TextEncoder().encode(opts.raw) : opts.raw
		const messageId = randomUUIDv7()
		db.run(
			"INSERT INTO email_messages (id, binding, from_addr, to_addr, raw, raw_size, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'received', ?)",
			[messageId, '_incoming', opts.from, opts.to, rawBytes, rawBytes.byteLength, Date.now()],
		)

		const message = new ForwardableEmailMessage(db, messageId, opts.from, opts.to, rawBytes)
		const ctx = new ExecutionContext()
		await runWithExecutionContext(ctx, async () => {
			await handler(message, env, ctx)
			await ctx._awaitAll()
		})
	}

	// --- Test helper factories ---

	const testWorkflows: TestWorkflowBinding[] = []
	const testDOs: TestDurableObjectNamespace[] = []

	function workflowHelper(bindingName: string): TestWorkflowBinding {
		const entry = registry.workflows.find(e => e.bindingName === bindingName)
		if (!entry) throw new Error(`Workflow binding "${bindingName}" not found. Available: ${registry.workflows.map(e => e.bindingName).join(', ')}`)
		const tw = new TestWorkflowBinding(entry.binding as SqliteWorkflowBinding, db)
		testWorkflows.push(tw)
		return tw
	}

	function durableObjectHelper(bindingName: string): TestDurableObjectNamespace {
		const entry = registry.durableObjects.find(e => e.bindingName === bindingName)
		if (!entry) {
			throw new Error(`Durable Object binding "${bindingName}" not found. Available: ${registry.durableObjects.map(e => e.bindingName).join(', ')}`)
		}
		const td = new TestDurableObjectNamespace(entry.namespace as DurableObjectNamespaceImpl)
		testDOs.push(td)
		return td
	}

	function dispose(): void {
		for (const tw of testWorkflows) tw.dispose()
		for (const td of testDOs) td.dispose()
		for (const entry of registry.durableObjects) {
			entry.namespace.destroy()
		}
		for (const entry of registry.workflows) {
			entry.binding.abortRunning()
		}
		db.close()
		for (const dir of tmpDirs) {
			try {
				rmSync(dir, { recursive: true, force: true })
			} catch {}
		}
		// Clean up global state
		setGlobalEnv({})
		testCachesRef.current = null
	}

	return {
		env: env as Env,
		db,
		fetch: fetchHandler,
		queue: queueHandler,
		scheduled: scheduledHandler,
		email: emailHandler,
		workflow: workflowHelper as TestEnv<Env>['workflow'],
		durableObject: durableObjectHelper as TestEnv<Env>['durableObject'],
		dispose,
	}
}

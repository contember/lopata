import { randomUUIDv7 } from 'bun'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { SqliteCacheStorage } from '../bindings/cache'
import type { DurableObjectNamespaceImpl } from '../bindings/durable-object'
import { ForwardableEmailMessage } from '../bindings/email'
import { createScheduledController } from '../bindings/scheduled'
import { trackInvocationResponse, WorkerDispatcher, WorkersCache } from '../bindings/worker-cache'
import type { SqliteWorkflowBinding } from '../bindings/workflow'
import type { WranglerConfig } from '../config'
import { type EntrypointHandlerName, resolveEntrypointHandler } from '../entrypoint-handler'
import { setGlobalEnv } from '../env'
import { ExecutionContext, runWithExecutionContext } from '../execution-context'
import { createInvocationTrace, type InvocationTrace } from '../tracing/invocation'
import { TestClock } from './clock'
import { TestDurableObjectNamespace } from './durable-object'
import { buildTestEnv, configToBindings } from './env-builder'
import { FetchMock, runWithFetchMock } from './fetch-mock'
import { setupTestEnv, testCachesRef } from './setup'
import type { TestEnv, TestEnvOptions, WorkerHandlers, WorkerModule } from './types'
import { TestWorkflowBinding } from './workflow'

export { TestClock } from './clock'
export type { Clock } from './clock'
export type { TestDurableObjectHandle, TestDurableObjectNamespace, TestDurableObjectStorage, TestWebSocket } from './durable-object'
export { FetchMock } from './fetch-mock'
export type { FetchCall } from './fetch-mock'
export type { BindingSpec, TestEnv, TestEnvOptions, WorkerHandlers, WorkerModule } from './types'
export type { TestWorkflowBinding, TestWorkflowInstance, TestWorkflowRun } from './workflow'

export async function createTestEnv<Env = Record<string, unknown>>(options: TestEnvOptions = {}): Promise<TestEnv<Env>> {
	// Ensure virtual modules + globals are registered (no-op if preload already ran)
	setupTestEnv()

	// Resolve clock
	let clock: TestClock | null = null
	if (options.clock === true) {
		clock = new TestClock()
	} else if (options.clock instanceof TestClock) {
		clock = options.clock
	}

	// Create fetch mock (always available, defaults to passthrough)
	const fetchMock = new FetchMock()

	let mergedBindings = options.bindings
	let mergedVars = options.vars
	let workerConfig: WranglerConfig = { name: 'test-worker' }

	// Load from wrangler config if specified — translate to BindingSpec
	if (options.wrangler) {
		const { loadConfig } = await import('../config')
		const config = await loadConfig(resolve(options.wrangler))
		workerConfig = config
		const { bindings: configBindings, vars: configVars } = configToBindings(config)
		// Merge: explicit options.bindings override wrangler-derived bindings
		mergedBindings = { ...configBindings, ...options.bindings }
		// Merge: explicit options.vars override wrangler vars
		mergedVars = { ...configVars, ...options.vars }
	}

	const { db, env, registry, tmpDirs } = buildTestEnv(mergedBindings, mergedVars, clock ?? undefined)

	// Wire in-memory caches for this test env
	testCachesRef.current = new SqliteCacheStorage(db, undefined, clock ?? undefined)

	// Resolve worker module
	let workerModule: Record<string, unknown>
	let defaultExport: unknown

	if (typeof options.worker === 'string') {
		workerModule = await import(resolve(options.worker))
		defaultExport = workerModule.default
	} else if (options.worker && 'default' in options.worker) {
		// WorkerModule — has a `default` export (class or object) + named exports
		const mod = options.worker as WorkerModule
		defaultExport = mod.default
		workerModule = { ...mod }
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

	// Wire service bindings — self-referencing (always in-process for tests)
	const dispatcher = new WorkerDispatcher(
		workerModule,
		env,
		new WorkersCache(db, workerConfig.name, crypto.randomUUID(), workerConfig, () => clock?.now() ?? Date.now()),
		props => new ExecutionContext(props),
	)
	for (const entry of registry.serviceBindings) {
		const wire = entry.proxy._wire as
			| ((resolver: () => { kind: 'in-process'; workerModule: Record<string, unknown>; env: Record<string, unknown> }) => void)
			| undefined
		if (wire) {
			wire(() => ({ kind: 'in-process', workerModule, env }))
		}
	}

	// Set globalEnv so `import { env } from 'cloudflare:workers'` works
	setGlobalEnv(env)

	// --- Handler dispatch helpers ---
	const invocations = new Set<InvocationTrace>()

	async function dispatch<T>(name: string, callback: (ctx: ExecutionContext, invocation: InvocationTrace) => Promise<T>): Promise<T> {
		const invocation = createInvocationTrace({ name, kind: 'server' })
		invocations.add(invocation)
		void invocation.completed.then(() => invocations.delete(invocation))
		return invocation.run(async () => {
			const ctx = new ExecutionContext()
			try {
				const result = await runWithExecutionContext(ctx, () => runWithFetchMock(fetchMock, () => callback(ctx, invocation)))
				await ctx._awaitAll()
				invocation.finishHandler()
				return result
			} catch (error) {
				invocation.finishHandler({ kind: 'error', error })
				await ctx._awaitAll()
				throw error
			}
		})
	}

	function getHandler(name: EntrypointHandlerName, ctx: ExecutionContext): ((...args: unknown[]) => unknown) | null {
		dispatcher.attachContext(ctx)
		return runWithExecutionContext(ctx, () => resolveEntrypointHandler(defaultExport, name, ctx, env))
	}

	async function fetchHandler(input: string | Request, init?: RequestInit): Promise<Response> {
		let request: Request
		if (typeof input === 'string') {
			const url = input.startsWith('/') ? `http://localhost${input}` : input
			request = new Request(url, init)
		} else {
			request = init ? new Request(input, init) : input
		}

		return dispatch(`${request.method} ${new URL(request.url).pathname}`, async (ctx, invocation) => {
			const response = trackInvocationResponse(await dispatcher.fetch(request, 'default', undefined, false, ctx), invocation, ctx)
			invocation.root.setAttribute('http.status_code', response.status)
			if (response.status >= 500) invocation.finishHandler({ kind: 'error', error: new Error(`HTTP ${response.status}`) })
			return response
		})
	}

	async function queueHandler(queueName: string, messages: { body: unknown; contentType?: string }[]): Promise<void> {
		return dispatch(`queue ${queueName}`, async ctx => {
			const handler = getHandler('queue', ctx)
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

			await handler(batch, env, ctx)
		})
	}

	async function scheduledHandler(opts?: { cron?: string; scheduledTime?: number }): Promise<void> {
		return dispatch('scheduled', async ctx => {
			const handler = getHandler('scheduled', ctx)
			if (!handler) throw new Error('No scheduled handler found')

			const controller = createScheduledController(opts?.cron ?? '* * * * *', opts?.scheduledTime ?? Date.now())
			await handler(controller, env, ctx)
		})
	}

	async function emailHandler(opts: { from: string; to: string; raw: Uint8Array | string }): Promise<void> {
		return dispatch('email', async ctx => {
			const handler = getHandler('email', ctx)
			if (!handler) throw new Error('No email handler found')

			const rawBytes = typeof opts.raw === 'string' ? new TextEncoder().encode(opts.raw) : opts.raw
			const messageId = randomUUIDv7()
			db.run(
				"INSERT INTO email_messages (id, binding, from_addr, to_addr, raw, raw_size, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'received', ?)",
				[messageId, '_incoming', opts.from, opts.to, rawBytes, rawBytes.byteLength, Date.now()],
			)

			const message = new ForwardableEmailMessage(db, messageId, opts.from, opts.to, rawBytes)
			await handler(message, env, ctx)
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

	async function advanceTime(ms: number): Promise<void> {
		if (!clock) throw new Error('advanceTime requires clock: true in createTestEnv options')
		clock.advance(ms)
		// Fire ready DO alarms
		for (const entry of registry.durableObjects) {
			await Promise.all(entry.namespace._fireReadyAlarms())
		}
	}

	function dispose(): void {
		dispatcher.terminateInvocations('Test environment disposed')
		for (const invocation of invocations) invocation.terminate('Test environment disposed')
		invocations.clear()
		for (const tw of testWorkflows) tw.dispose()
		for (const td of testDOs) td.dispose()
		for (const entry of registry.durableObjects) {
			// force: final teardown — dispose every executor and leave no eviction
			// timer running past db.close() below.
			entry.namespace.destroy({ force: true })
		}
		for (const entry of registry.workflows) {
			entry.binding.terminateTracing('Test environment disposed')
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
		fetchMock.reset()
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
		clock,
		fetchMock,
		advanceTime,
		dispose,
	}
}

import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DurableObjectBase, DurableObjectStateImpl } from '../src/bindings/durable-object'
import { ServiceBinding } from '../src/bindings/service-binding'
import { WorkerDispatcher } from '../src/bindings/worker-dispatcher'
import { SqliteWorkflowBinding, WorkflowEntrypointBase, type WorkflowStepImpl } from '../src/bindings/workflow'
import { resolveCompatibility } from '../src/compatibility'
import { getActiveCompatibility, legacyCompatibility, runWithCompatibility } from '../src/compatibility-context'
import { ExecutionContext } from '../src/execution-context'
import { createTestEnv } from '../src/testing'

const modern = resolveCompatibility({ flags: ['websocket_close_reason_byte_limit'] })

function enabled() {
	return getActiveCompatibility().websocketCloseReasonByteLimit === 'enabled'
}

test('test dispatch and DO/Workflow helpers own selection outside caller scopes', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'lopata-scoped-compatibility-'))
	const config = join(directory, 'wrangler.json')
	await Bun.write(config, JSON.stringify({ name: 'modern', compatibility_flags: ['websocket_close_reason_byte_limit'] }))
	const pending = Promise.withResolvers<void>()
	const observations: boolean[] = []
	const events: { kind: string; modern: boolean }[] = []
	class ProbeDO extends DurableObjectBase {
		private constructed = enabled()
		constructor(private state: DurableObjectStateImpl, env: unknown) {
			super(state, env)
		}
		async fetch() {
			await pending.promise
			return Response.json({ constructed: this.constructed, method: enabled() })
		}
		async alarm() {
			await this.state.storage.put('alarm', enabled())
		}
		get value() {
			return enabled()
		}
		open() {
			return () => enabled()
		}
	}
	class ProbeWorkflow extends WorkflowEntrypointBase {
		private constructed = enabled()
		override async run(_event: unknown, step: WorkflowStepImpl) {
			await pending.promise
			return step.do('scope', async () => ({ constructed: this.constructed, method: enabled() }))
		}
	}
	const worker = {
		default: {
			async fetch(_request: Request, _env: Record<string, unknown>, ctx: unknown) {
				if (!(ctx instanceof ExecutionContext)) throw new Error('Expected execution context')
				const before = enabled()
				ctx.waitUntil(pending.promise.then(() => {
					observations.push(enabled())
				}))
				await pending.promise
				return Response.json({ before, after: enabled() })
			},
			async scheduled() {
				await pending.promise
				events.push({ kind: 'scheduled', modern: enabled() })
			},
			async email() {
				await pending.promise
				events.push({ kind: 'email', modern: enabled() })
			},
			async queue() {
				await pending.promise
				events.push({ kind: 'queue', modern: enabled() })
			},
		},
		ProbeDO,
		ProbeWorkflow,
	}
	const bindings = {
		DO: { type: 'durable-object', className: 'ProbeDO' },
		WF: { type: 'workflow', className: 'ProbeWorkflow' },
	} satisfies NonNullable<Parameters<typeof createTestEnv>[0]>['bindings']
	const on = await createTestEnv({ worker, wrangler: config, bindings })
	const off = await createTestEnv({ worker, bindings })
	try {
		const onResponse = on.fetch('/')
		const offResponse = off.fetch('/')
		const eventDispatches = [on, off].flatMap(env => [
			env.scheduled(),
			env.email({ from: 'sender@example.com', to: 'worker@example.com', raw: 'test' }),
			env.queue('queue', [{ body: 'test' }]),
		])
		const onDo = on.durableObject('DO').get('probe')
		const offDo = off.durableObject('DO').get('probe')
		// Helpers are called from the opposing worker's scope, independently of fetch dispatch.
		const onDoResponse: Promise<Response> = runWithCompatibility(legacyCompatibility, () => onDo.stub.fetch(new Request('https://test/')))
		const offDoResponse: Promise<Response> = runWithCompatibility(modern, () => offDo.stub.fetch(new Request('https://test/')))
		const onWorkflow = await runWithCompatibility(legacyCompatibility, () => on.workflow('WF').create())
		const offWorkflow = await runWithCompatibility(modern, () => off.workflow('WF').create())
		pending.resolve()
		expect(await (await onResponse).json()).toEqual({ before: true, after: true })
		expect(await (await offResponse).json()).toEqual({ before: false, after: false })
		expect(await (await onDoResponse).json()).toEqual({ constructed: true, method: true })
		expect(await (await offDoResponse).json()).toEqual({ constructed: false, method: false })
		await runWithCompatibility(legacyCompatibility, () => onDo.triggerAlarm())
		await runWithCompatibility(modern, () => offDo.triggerAlarm())
		expect(await onDo.storage.get<boolean>('alarm')).toBe(true)
		expect(await offDo.storage.get<boolean>('alarm')).toBe(false)
		expect(await runWithCompatibility(legacyCompatibility, () => onDo.stub.value)).toBe(true)
		expect(await runWithCompatibility(modern, () => offDo.stub.value)).toBe(false)
		const capability: unknown = await runWithCompatibility(legacyCompatibility, () => onDo.stub.open())
		if (typeof capability !== 'function') throw new Error('Expected DO capability')
		expect(await runWithCompatibility(legacyCompatibility, () => capability())).toBe(true)
		const dispose: unknown = Reflect.get(capability, Symbol.dispose)
		if (typeof dispose === 'function') dispose.call(capability)
		expect((await onWorkflow.waitForStatus('complete')).output).toEqual({ constructed: true, method: true })
		expect((await offWorkflow.waitForStatus('complete')).output).toEqual({ constructed: false, method: false })
		const workflowBinding = on.env.WF
		if (!(workflowBinding instanceof SqliteWorkflowBinding)) throw new Error('Expected Workflow binding')
		const instance = await workflowBinding.get(onWorkflow.id)
		await runWithCompatibility(legacyCompatibility, () => instance.restart())
		expect((await onWorkflow.waitForStatus('complete')).output).toEqual({ constructed: true, method: true })
		expect(observations.sort()).toEqual([false, true])
		await Promise.all(eventDispatches)
		for (const kind of ['scheduled', 'email', 'queue']) {
			expect(events.filter(event => event.kind === kind).map(event => event.modern).sort()).toEqual([false, true])
		}
	} finally {
		pending.resolve()
		on.dispose()
		off.dispose()
		rmSync(directory, { recursive: true, force: true })
	}
})

test('shared module dispatchers and fallback RPC capabilities retain the callee selection', async () => {
	const module = {
		default: {
			fetch() {
				return Response.json(enabled())
			},
			get value() {
				return enabled()
			},
			capability() {
				return () => enabled()
			},
		},
	}
	const envOn = {}
	const envOff = {}
	// Constructing a dispatcher registers it for the service bindings below.
	new WorkerDispatcher(module, envOn, props => new ExecutionContext(props), modern)
	new WorkerDispatcher(module, envOff, props => new ExecutionContext(props), legacyCompatibility)
	const serviceOn = new ServiceBinding('on')
	const serviceOff = new ServiceBinding('off')
	serviceOn._wire(() => ({ kind: 'in-process', workerModule: module, env: envOn, compatibility: modern }))
	serviceOff._wire(() => ({ kind: 'in-process', workerModule: module, env: envOff, compatibility: legacyCompatibility }))
	const fallback = new ServiceBinding('fallback')
	fallback._wire(module, {}, modern)
	expect(await (await runWithCompatibility(legacyCompatibility, () => serviceOn.fetch('https://test/'))).json()).toBe(true)
	expect(await (await runWithCompatibility(modern, () => serviceOff.fetch('https://test/'))).json()).toBe(false)
	expect(await serviceOn.toProxy().value).toBe(true)
	expect(await serviceOff.toProxy().value).toBe(false)
	for (const service of [serviceOn, fallback]) {
		const method = service.toProxy().capability
		if (typeof method !== 'function') throw new Error('Expected RPC method')
		const capability: unknown = await method()
		if (typeof capability !== 'function') throw new Error('Expected returned capability')
		expect(await runWithCompatibility(legacyCompatibility, () => capability())).toBe(true)
		const dispose: unknown = Reflect.get(capability, Symbol.dispose)
		if (typeof dispose === 'function') dispose.call(capability)
	}
})

test('native test-module evaluation stays at fallback while configured dispatch is scoped', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'lopata-native-import-'))
	const wrangler = join(directory, 'wrangler.json')
	await Bun.write(wrangler, JSON.stringify({ name: 'modern', compatibility_flags: ['websocket_close_reason_byte_limit'] }))
	const env = await createTestEnv({ worker: join(import.meta.dir, 'fixtures/compatibility-native-import-worker.ts'), wrangler })
	try {
		expect(await (await env.fetch('/')).json()).toEqual({ topLevel: false, dispatch: true })
	} finally {
		env.dispose()
		rmSync(directory, { recursive: true, force: true })
	}
})

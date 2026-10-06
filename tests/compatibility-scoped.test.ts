import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DigestStream } from '../src/bindings/crypto-extras'
import { DurableObjectBase, DurableObjectStateImpl } from '../src/bindings/durable-object'
import { ServiceBinding } from '../src/bindings/service-binding'
import { WorkerDispatcher, WorkersCache } from '../src/bindings/worker-cache'
import { SqliteWorkflowBinding, WorkflowEntrypointBase, type WorkflowStepImpl } from '../src/bindings/workflow'
import { resolveCompatibility } from '../src/compatibility'
import { getActiveCompatibility, legacyCompatibility, runWithCompatibility } from '../src/compatibility-context'
import { ExecutionContext } from '../src/execution-context'
import { installCompatibilityCrypto } from '../src/setup-globals'
import { createTestEnv } from '../src/testing'

const modern = resolveCompatibility({ flags: ['webcrypto_modern_algorithms'] })
installCompatibilityCrypto()

function enabled() {
	return typeof crypto.subtle.encapsulateBits === 'function'
}

test('overlapping scopes retain facades, detached methods and key contracts', async () => {
	const gate = Promise.withResolvers<void>()
	const entered = Promise.withResolvers<void>()
	const captured = runWithCompatibility(modern, () => {
		const supports: unknown = Reflect.get(SubtleCrypto, 'supports')
		return { subtle: crypto.subtle, supports, generate: crypto.subtle.generateKey }
	})
	const active = runWithCompatibility(modern, async () => {
		entered.resolve()
		await gate.promise
		expect(enabled()).toBe(true)
		expect(getActiveCompatibility()).toBe(modern)
		return crypto.subtle.generateKey('ML-DSA-44', false, ['sign', 'verify'])
	})
	await entered.promise
	await runWithCompatibility(legacyCompatibility, async () => {
		expect(enabled()).toBe(false)
		expect(Reflect.get(SubtleCrypto, 'supports')).toBeUndefined()
		expect('supports' in SubtleCrypto).toBe(true)
		expect(Object.hasOwn(SubtleCrypto, 'supports')).toBe(true)
		await expect(crypto.subtle.generateKey('ML-DSA-44', false, ['sign'])).rejects.toMatchObject({ name: 'NotSupportedError' })
		gate.resolve()
		const pair = await active
		if (!('privateKey' in pair)) throw new Error('Expected key pair')
		expect(pair.privateKey instanceof CryptoKey).toBe(true)
		expect(pair.privateKey.extractable).toBe(false)
		const sign = captured.subtle.sign
		const signature = await sign('ML-DSA-44', pair.privateKey, new Uint8Array([7]))
		expect(await captured.subtle.verify('ML-DSA-44', pair.publicKey, signature, new Uint8Array([7]))).toBe(true)
		await expect(captured.subtle.exportKey('pkcs8', pair.privateKey)).rejects.toMatchObject({ name: 'InvalidAccessError' })
		await expect(sign('ML-DSA-44', pair.publicKey, new Uint8Array([7]))).rejects.toMatchObject({ name: 'InvalidAccessError' })
		if (typeof captured.supports !== 'function') throw new Error('Expected supports function')
		expect(captured.supports('sign', 'ML-DSA-44')).toBe(true)
		const generated = await captured.generate('ML-DSA-44', false, ['sign'])
		expect('privateKey' in generated).toBe(true)
		expect(enabled()).toBe(false)
		const digest = crypto.subtle.digest
		expect((await digest('SHA-256', new Uint8Array([7]))).byteLength).toBe(32)
		const timingSafeEqual: unknown = Reflect.get(crypto.subtle, 'timingSafeEqual')
		if (typeof timingSafeEqual !== 'function') throw new Error('Expected timingSafeEqual')
		expect(timingSafeEqual(new Uint8Array([7]), new Uint8Array([7]))).toBe(true)
		expect(Reflect.get(crypto, 'DigestStream')).toBe(DigestStream)
		const stream = new DigestStream('SHA-256')
		const writer = stream.getWriter()
		await writer.write(new Uint8Array([7]))
		await writer.close()
		expect(new Uint8Array(await stream.digest)).toEqual(new Uint8Array(await digest('SHA-256', new Uint8Array([7]))))
	})
	expect(enabled()).toBe(false)
})

test('test dispatch and DO/Workflow helpers own selection outside caller scopes', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'lopata-scoped-crypto-'))
	const config = join(directory, 'wrangler.json')
	await Bun.write(config, JSON.stringify({ name: 'modern', compatibility_flags: ['webcrypto_modern_algorithms'] }))
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
	const db = new Database(':memory:')
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
	const on = new WorkerDispatcher(module, envOn, new WorkersCache(db, 'on', 'v1', { name: 'on' }), props => new ExecutionContext(props), modern)
	const off = new WorkerDispatcher(
		module,
		envOff,
		new WorkersCache(db, 'off', 'v1', { name: 'off' }),
		props => new ExecutionContext(props),
		legacyCompatibility,
	)
	const serviceOn = new ServiceBinding('on')
	const serviceOff = new ServiceBinding('off')
	serviceOn._wire(() => ({ kind: 'in-process', workerModule: module, env: envOn, compatibility: modern }))
	serviceOff._wire(() => ({ kind: 'in-process', workerModule: module, env: envOff, compatibility: legacyCompatibility }))
	const fallback = new ServiceBinding('fallback')
	fallback._wire(module, {}, modern)
	try {
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
	} finally {
		on.terminateInvocations('test complete')
		off.terminateInvocations('test complete')
		db.close()
	}
})

test('native test-module evaluation stays at fallback while configured dispatch is scoped', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'lopata-native-import-'))
	const wrangler = join(directory, 'wrangler.json')
	await Bun.write(wrangler, JSON.stringify({ name: 'modern', compatibility_flags: ['webcrypto_modern_algorithms'] }))
	const env = await createTestEnv({ worker: join(import.meta.dir, 'fixtures/compatibility-native-import-worker.ts'), wrangler })
	try {
		expect(await (await env.fetch('/')).json()).toEqual({ topLevel: false, dispatch: true })
	} finally {
		env.dispose()
		rmSync(directory, { recursive: true, force: true })
	}
})

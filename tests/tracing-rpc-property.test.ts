import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { WorkerEntrypoint } from 'cloudflare:workers'
import { DurableObjectBase, DurableObjectNamespaceImpl } from '../src/bindings/durable-object'
import { ServiceBinding } from '../src/bindings/service-binding'
import { runMigrations } from '../src/db'
import { runTracingMigrations } from '../src/tracing/db'
import { instrumentDONamespace, instrumentServiceBinding } from '../src/tracing/instrument'
import { setTraceStore, TraceStore } from '../src/tracing/store'

// An RPC member is callable (a traced method call) and thenable (awaiting it reads the property).
// The tracing wrappers must keep both.

let traceDb: Database

beforeEach(() => {
	traceDb = new Database(':memory:')
	runTracingMigrations(traceDb)
	setTraceStore(new TraceStore(traceDb))
})

afterEach(() => {
	setTraceStore(null)
})

const spanNames = () => traceDb.query<{ name: string }, []>('SELECT name FROM spans ORDER BY start_time').all().map(row => row.name)

async function callMember(target: unknown, name: string, ...args: unknown[]): Promise<unknown> {
	const member: unknown = Reflect.get(Object(target), name)
	if (typeof member !== 'function') throw new Error(`Missing member: ${name}`)
	return Reflect.apply(member, target, args)
}

describe('traced RPC members keep property reads', () => {
	test('service binding', async () => {
		const binding = new ServiceBinding('aux')
		binding._wire({
			default: class extends WorkerEntrypoint {
				version = '1.2.3'
				get label() {
					return 'aux worker'
				}
				double(n: number) {
					return n * 2
				}
			},
		}, {})
		const traced = instrumentServiceBinding(binding.toProxy(), 'aux')
		expect(await Reflect.get(traced, 'version')).toBe('1.2.3')
		expect(await Promise.resolve(Reflect.get(traced, 'label'))).toBe('aux worker')
		expect(await callMember(traced, 'double', 21)).toBe(42)
		expect(spanNames()).toEqual(['service.double'])
	})

	test('Durable Object stub', async () => {
		const db = new Database(':memory:')
		runMigrations(db)
		const namespace = new DurableObjectNamespaceImpl(db, 'Counter', undefined, { evictionTimeoutMs: 0 })
		namespace._setClass(
			class extends DurableObjectBase {
				version = '2.0.0'
				get label() {
					return 'counter'
				}
				double(n: number) {
					return n * 2
				}
			},
			{},
		)
		const traced = instrumentDONamespace(namespace, 'Counter')
		const stub = traced.get(traced.idFromName('a'))
		expect(await Reflect.get(stub, 'version')).toBe('2.0.0')
		expect(await Promise.resolve(Reflect.get(stub, 'label'))).toBe('counter')
		expect(await callMember(stub, 'double', 21)).toBe(42)
		expect(spanNames()).toEqual(['do.double'])
		namespace.destroy({ force: true })
		db.close()
	})
})

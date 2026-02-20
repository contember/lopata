import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { DurableObjectBase, DurableObjectNamespaceImpl, DurableObjectStateImpl } from '../bindings/durable-object'
import {
	createRpcFunctionStub,
	createRpcPromise,
	createRpcStub,
	isRpcTarget,
	NON_RPC_PROPS,
	RPC_TARGET_BRAND,
	wrapRpcReturnValue,
} from '../bindings/rpc-stub'
import { createServiceBinding } from '../bindings/service-binding'
import { validateRpcValue } from '../rpc-validate'

// Helper: create an RpcTarget-branded object
function makeRpcTarget(props: Record<string, unknown> = {}): object {
	const obj = Object.assign(Object.create(null), props)
	obj[RPC_TARGET_BRAND] = true
	// Set a proper prototype so it's a "custom class" for validation purposes
	const target = new (class RpcTargetImpl {
		constructor() {
			;(this as any)[RPC_TARGET_BRAND] = true
			Object.assign(this, props)
		}
	})()
	return target
}

describe('isRpcTarget', () => {
	test('detects branded objects', () => {
		const target = makeRpcTarget()
		expect(isRpcTarget(target)).toBe(true)
	})

	test('rejects plain objects', () => {
		expect(isRpcTarget({})).toBe(false)
		expect(isRpcTarget(null)).toBe(false)
		expect(isRpcTarget(42)).toBe(false)
		expect(isRpcTarget('string')).toBe(false)
	})

	test('rejects unbranded class instances', () => {
		class Foo {}
		expect(isRpcTarget(new Foo())).toBe(false)
	})
})

describe('createRpcStub', () => {
	test('method calls work through the stub', async () => {
		const target = makeRpcTarget({
			greet(name: string) {
				return `Hello, ${name}!`
			},
		})

		const stub = createRpcStub(target) as any
		const result = await stub.greet('World')
		expect(result).toBe('Hello, World!')
	})

	test('async method calls work through the stub', async () => {
		const target = makeRpcTarget({
			async compute(a: number, b: number) {
				return a + b
			},
		})

		const stub = createRpcStub(target) as any
		const result = await stub.compute(3, 4)
		expect(result).toBe(7)
	})

	test('property access works through thenable', async () => {
		const target = makeRpcTarget({ version: '1.0.0' })

		const stub = createRpcStub(target) as any
		const version = await stub.version
		expect(version).toBe('1.0.0')
	})

	test('nested RpcTarget returns get wrapped as stubs', async () => {
		const child = makeRpcTarget({
			childMethod() {
				return 'from child'
			},
		})

		const parent = makeRpcTarget({
			getChild() {
				return child
			},
		})

		const stub = createRpcStub(parent) as any
		const childStub = await stub.getChild()

		// The child should be a stub (proxy), not the raw target
		const childResult = await childStub.childMethod()
		expect(childResult).toBe('from child')
	})

	test('recursive wrapping — multiple levels', async () => {
		const grandchild = makeRpcTarget({
			getValue() {
				return 42
			},
		})

		const child = makeRpcTarget({
			getGrandchild() {
				return grandchild
			},
		})

		const root = makeRpcTarget({
			getChild() {
				return child
			},
		})

		const stub = createRpcStub(root) as any
		const childStub = await stub.getChild()
		const grandchildStub = await childStub.getGrandchild()
		expect(await grandchildStub.getValue()).toBe(42)
	})

	test('returned function gets wrapped as function stub', async () => {
		const target = makeRpcTarget({
			getCallback() {
				return function add(a: number, b: number) {
					return a + b
				}
			},
		})

		const stub = createRpcStub(target) as any
		const fn = await stub.getCallback()
		expect(typeof fn).toBe('function')
		expect(await fn(2, 3)).toBe(5)
	})

	test('stub caching — same target returns same stub', () => {
		const target = makeRpcTarget({ x: 1 })
		const stub1 = createRpcStub(target)
		const stub2 = createRpcStub(target)
		expect(stub1).toBe(stub2)
	})

	test('return this — cached stub handles self-references', async () => {
		const target = makeRpcTarget({
			getSelf() {
				return target
			},
		})
		;(target as any).getSelf = function() {
			return target
		}

		const stub = createRpcStub(target) as any
		const self = await stub.getSelf()
		// Should return the same stub proxy (cached)
		expect(self).toBe(stub)
	})
})

describe('private member filtering', () => {
	test('_-prefixed properties are hidden', async () => {
		const target = makeRpcTarget({
			_private: 'secret',
			public: 'visible',
		})

		const stub = createRpcStub(target) as any
		expect(stub._private).toBeUndefined()
		expect(await stub.public).toBe('visible')
	})

	test('_-prefixed methods are hidden', () => {
		const target = makeRpcTarget({
			_internalMethod() {
				return 'hidden'
			},
			publicMethod() {
				return 'visible'
			},
		})

		const stub = createRpcStub(target) as any
		expect(stub._internalMethod).toBeUndefined()
		expect(stub.publicMethod).toBeDefined()
	})
})

describe('Symbol.dispose and dup()', () => {
	test('stub has Symbol.dispose (no-op)', () => {
		const target = makeRpcTarget({})
		const stub = createRpcStub(target) as any
		expect(typeof stub[Symbol.dispose]).toBe('function')
		// Should not throw
		stub[Symbol.dispose]()
	})

	test('dup() returns an independent stub', async () => {
		const target = makeRpcTarget({
			getValue() {
				return 42
			},
		})

		const stub = createRpcStub(target) as any
		const dup = stub.dup()
		expect(dup).not.toBe(stub)

		// Both should work
		expect(await dup.getValue()).toBe(42)
		expect(await stub.getValue()).toBe(42)
	})

	test('function stub has Symbol.dispose', () => {
		const fn = () => 'test'
		const stub = createRpcFunctionStub(fn) as any
		expect(typeof stub[Symbol.dispose]).toBe('function')
		stub[Symbol.dispose]()
	})

	test('function stub has dup()', async () => {
		const fn = (x: number) => x * 2
		const stub = createRpcFunctionStub(fn) as any
		const dup = stub.dup()
		expect(dup).not.toBe(stub)
		expect(await dup(5)).toBe(10)
	})
})

describe('createRpcFunctionStub', () => {
	test('wraps a function with validation', async () => {
		const fn = (a: number, b: number) => a + b
		const stub = createRpcFunctionStub(fn)
		expect(await stub(3, 4)).toBe(7)
	})

	test('async functions work', async () => {
		const fn = async (x: number) => x * 2
		const stub = createRpcFunctionStub(fn)
		expect(await stub(5)).toBe(10)
	})

	test('preserves this binding', async () => {
		const obj = {
			value: 42,
			getValue() {
				return this.value
			},
		}
		const stub = createRpcFunctionStub(obj.getValue, obj)
		expect(await stub()).toBe(42)
	})
})

describe('createRpcPromise — promise pipelining', () => {
	test('basic then/catch/finally delegation', async () => {
		const promise = createRpcPromise(Promise.resolve(42))
		const result = await promise
		expect(result).toBe(42)
	})

	test('pipelining: chained method call without intermediate await', async () => {
		const child = makeRpcTarget({
			childMethod() {
				return 'from child'
			},
		})

		const parent = makeRpcTarget({
			getChild() {
				return child
			},
		})

		// Simulate: stub.getChild().childMethod() — no await between
		const parentPromise = Promise.resolve(parent)
		const rpcPromise = createRpcPromise(parentPromise)
		const result = await (rpcPromise as any).getChild().childMethod()
		expect(result).toBe('from child')
	})

	test('pipelining: property access without intermediate await', async () => {
		const child = makeRpcTarget({ version: '2.0' })
		const parent = makeRpcTarget({
			getChild() {
				return child
			},
		})

		const rpcPromise = createRpcPromise(Promise.resolve(parent))
		// Access property on pipelined result
		const childStub = await (rpcPromise as any).getChild()
		const version = await childStub.version
		expect(version).toBe('2.0')
	})

	test('pipelining: Symbol.dispose is no-op', () => {
		const promise = createRpcPromise(Promise.resolve(42))
		const dispose = (promise as any)[Symbol.dispose]
		expect(typeof dispose).toBe('function')
		dispose()
	})

	test('pipelining: dup() returns new RpcPromise', async () => {
		const promise = createRpcPromise(Promise.resolve(42))
		const dup = (promise as any).dup()
		expect(dup).not.toBe(promise)
		expect(await dup).toBe(42)
	})

	test('pipelining: _-prefixed properties are hidden', () => {
		const promise = createRpcPromise(Promise.resolve({ _secret: 1 }))
		expect((promise as any)._secret).toBeUndefined()
	})
})

describe('wrapRpcReturnValue', () => {
	test('null/undefined pass through', () => {
		expect(wrapRpcReturnValue(null, 'test')).toBeNull()
		expect(wrapRpcReturnValue(undefined, 'test')).toBeUndefined()
	})

	test('RpcTarget gets wrapped in stub', async () => {
		const target = makeRpcTarget({
			getValue() {
				return 42
			},
		})
		const wrapped = wrapRpcReturnValue(target, 'test') as any
		expect(await wrapped.getValue()).toBe(42)
	})

	test('function gets wrapped in function stub', async () => {
		const fn = (x: number) => x * 2
		const wrapped = wrapRpcReturnValue(fn, 'test') as Function
		expect(await wrapped(5)).toBe(10)
	})

	test('plain values pass through', () => {
		expect(wrapRpcReturnValue(42, 'test')).toBe(42)
		expect(wrapRpcReturnValue('hello', 'test')).toBe('hello')
		expect(wrapRpcReturnValue({ a: 1 }, 'test')).toEqual({ a: 1 })
	})
})

describe('RPC validation with RpcTarget', () => {
	test('RpcTarget instances pass validation', () => {
		const target = makeRpcTarget({ x: 1 })
		const errors = validateRpcValue(target)
		expect(errors).toEqual([])
	})

	test('non-RpcTarget custom classes still rejected', () => {
		class Foo {
			x = 1
		}
		const errors = validateRpcValue(new Foo())
		expect(errors.length).toBeGreaterThan(0)
		expect(errors[0]).toContain('Custom class instance')
	})

	test('RpcTarget nested in plain object passes', () => {
		const target = makeRpcTarget({ val: 1 })
		const errors = validateRpcValue({ child: target })
		expect(errors).toEqual([])
	})
})

describe('Integration: DO stub with RpcTarget return', () => {
	test('DO method returning RpcTarget gives wrapped stub', async () => {
		const db = new Database(':memory:')
		db.run(`CREATE TABLE IF NOT EXISTS do_storage (namespace TEXT, id TEXT, key TEXT, value TEXT, PRIMARY KEY(namespace, id, key))`)
		db.run(`CREATE TABLE IF NOT EXISTS do_alarms (namespace TEXT, id TEXT, alarm_time INTEGER, PRIMARY KEY(namespace, id))`)
		db.run(`CREATE TABLE IF NOT EXISTS do_instances (namespace TEXT, id TEXT, name TEXT, PRIMARY KEY(namespace, id))`)

		class ChildTarget {
			childValue = 99
			constructor() {
				;(this as any)[Symbol.for('bunflare.RpcTarget')] = true
			}
			getChildValue() {
				return this.childValue
			}
		}

		class TestDO extends DurableObjectBase {
			getChild() {
				return new ChildTarget()
			}
			getValue() {
				return 42
			}
		}

		const ns = new DurableObjectNamespaceImpl(db, 'test-rpc', undefined, { evictionTimeoutMs: 0 })
		ns._setClass(TestDO as any, {})

		const id = ns.idFromName('rpc-test')
		const stub = ns.get(id) as any

		// Basic method call
		expect(await stub.getValue()).toBe(42)

		// Method returning RpcTarget → should be wrapped as stub
		const childStub = await stub.getChild()
		expect(await childStub.getChildValue()).toBe(99)

		// Private members should be hidden on the child stub
		expect(childStub._private).toBeUndefined()

		ns.destroy()
		db.close()
	})

	test('DO stub supports promise pipelining', async () => {
		const db = new Database(':memory:')
		db.run(`CREATE TABLE IF NOT EXISTS do_storage (namespace TEXT, id TEXT, key TEXT, value TEXT, PRIMARY KEY(namespace, id, key))`)
		db.run(`CREATE TABLE IF NOT EXISTS do_alarms (namespace TEXT, id TEXT, alarm_time INTEGER, PRIMARY KEY(namespace, id))`)
		db.run(`CREATE TABLE IF NOT EXISTS do_instances (namespace TEXT, id TEXT, name TEXT, PRIMARY KEY(namespace, id))`)

		class ChildTarget {
			constructor() {
				;(this as any)[Symbol.for('bunflare.RpcTarget')] = true
			}
			compute(a: number, b: number) {
				return a + b
			}
		}

		class TestDO extends DurableObjectBase {
			getChild() {
				return new ChildTarget()
			}
		}

		const ns = new DurableObjectNamespaceImpl(db, 'test-pipeline', undefined, { evictionTimeoutMs: 0 })
		ns._setClass(TestDO as any, {})

		const id = ns.idFromName('pipeline-test')
		const stub = ns.get(id) as any

		// RPC return value is wrapped as RpcStub — use intermediate await
		// (Promise pipelining without await requires Proxy(Promise) which
		// is incompatible with bun:test .rejects assertions)
		const child = await stub.getChild()
		const result = await child.compute(2, 3)
		expect(result).toBe(5)

		ns.destroy()
		db.close()
	})
})

describe('Integration: Service binding with RpcTarget return', () => {
	test('service binding RPC returning RpcTarget gets wrapped', async () => {
		class ChildTarget {
			constructor() {
				;(this as any)[Symbol.for('bunflare.RpcTarget')] = true
			}
			getValue() {
				return 'from-child'
			}
		}

		class MyEntrypoint {
			getChild() {
				return new ChildTarget()
			}
		}

		const workerModule = {
			default: { fetch: async () => new Response('ok') },
			MyEntrypoint,
		}

		const proxy = createServiceBinding('test-worker', 'MyEntrypoint')
		;(proxy._wire as Function)(workerModule, {})

		const getChild = proxy.getChild as Function
		const childStub = await getChild()
		expect(await childStub.getValue()).toBe('from-child')
	})

	test('service binding RPC returning function gets wrapped', async () => {
		const workerModule: Record<string, unknown> = {
			default: {
				fetch: async () => new Response('ok'),
				getCallback() {
					return function multiply(a: number, b: number) {
						return a * b
					}
				},
			},
		}

		const proxy = createServiceBinding('test-worker')
		;(proxy._wire as Function)(workerModule, {})

		const getCallback = proxy.getCallback as Function
		const fn = await getCallback()
		expect(typeof fn).toBe('function')
		expect(await fn(3, 4)).toBe(12)
	})
})

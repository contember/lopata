import { expect, test } from 'bun:test'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createRpcSession } from '../src/bindings/rpc-session'
import { createRpcFunctionStub, createRpcStub, RPC_TARGET_BRAND, wrapRpcReturnValue } from '../src/bindings/rpc-stub'

function setup() {
	let holds = 0
	const session = createRpcSession({
		run: callback => callback(),
		retain() {
			holds++
			return () => {
				holds--
			}
		},
	})
	return { session, holds: () => holds }
}

function member(target: unknown, key: string | symbol): Function {
	if (!target || (typeof target !== 'object' && typeof target !== 'function')) throw new Error('Missing target')
	const value: unknown = Reflect.get(target, key)
	if (typeof value !== 'function') throw new Error('Missing member')
	return value
}

test('initial share, synchronous run and independent idempotent leases', () => {
	const { session, holds } = setup()
	expect(holds()).toBe(1)
	expect(session.run(() => 42)).toBe(42)
	const first = session.retain()
	const second = session.retain()
	session.finish()
	session.finish()
	first.dispose()
	first.dispose()
	expect(holds()).toBe(1)
	expect(() => first.run(() => 1)).toThrow('disposed')
	expect(second.run(() => 2)).toBe(2)
	second.dispose()
	expect(holds()).toBe(0)
	expect(() => session.retain()).toThrow('closed')
})

test('last disposal waits for fulfillment and permits a descendant before settlement', async () => {
	const { session, holds } = setup()
	const gate = Promise.withResolvers<void>()
	const fn = createRpcFunctionStub(
		async () => {
			await gate.promise
			return () => 'child'
		},
		undefined,
		session,
	)
	session.finish()
	const pending = fn()
	member(fn, Symbol.dispose)()
	expect(holds()).toBe(1)
	await expect(fn()).rejects.toThrow('disposed')
	gate.resolve()
	const child = await pending
	expect(holds()).toBe(1)
	expect(await child()).toBe('child')
	member(child, Symbol.dispose)()
	expect(holds()).toBe(0)
})

test('rejected in-flight call releases its hold after last disposal', async () => {
	const { session, holds } = setup()
	const gate = Promise.withResolvers<void>()
	const fn = createRpcFunctionStub(() => gate.promise, undefined, session)
	session.finish()
	const pending = fn()
	member(fn, Symbol.dispose)()
	expect(holds()).toBe(1)
	gate.reject(new Error('call failed'))
	await expect(pending).rejects.toThrow('call failed')
	expect(holds()).toBe(0)
})

test('target and function duplicates survive original disposal and reject after their own disposal', async () => {
	const { session, holds } = setup()
	const target = createRpcStub({ value: () => 12 }, session)
	const duplicate = member(target, 'dup')()
	const saved = member(target, 'value')
	const fn = await saved
	const fnDuplicate = member(fn, 'dup')()
	session.finish()
	member(target, Symbol.dispose)()
	await expect(saved()).rejects.toThrow('disposed')
	member(fn, Symbol.dispose)()
	expect(await member(duplicate, 'value')()).toBe(12)
	expect(await fnDuplicate()).toBe(12)
	member(duplicate, Symbol.dispose)()
	expect(holds()).toBe(1)
	member(fnDuplicate, Symbol.asyncDispose)()
	member(fnDuplicate, Symbol.dispose)()
	expect(holds()).toBe(0)
	expect(() => member(fnDuplicate, 'dup')()).toThrow('disposed')
})

test('getter classification is synchronous and each returned target is independently leased', async () => {
	const { session, holds } = setup()
	let reads = 0
	const child = { [RPC_TARGET_BRAND]: true, value: () => 7 }
	const target = createRpcStub({
		get child() {
			reads++
			return child
		},
	}, session)
	const property: unknown = Reflect.get(target, 'child')
	expect(reads).toBe(1)
	const first = await property
	const second = await Reflect.get(target, 'child')
	expect(first).not.toBe(second)
	session.finish()
	member(target, Symbol.dispose)()
	member(first, Symbol.dispose)()
	expect(await member(second, 'value')()).toBe(7)
	member(second, Symbol.dispose)()
	expect(holds()).toBe(0)
})

test('termination fences saved methods, duplication and late descendant creation', async () => {
	const { session, holds } = setup()
	const gate = Promise.withResolvers<void>()
	const fn = createRpcFunctionStub(
		async () => {
			await gate.promise
			return () => 'late'
		},
		undefined,
		session,
	)
	const pending = fn()
	session.close()
	session.close()
	session.finish()
	expect(holds()).toBe(0)
	await expect(fn()).rejects.toThrow('closed')
	expect(() => member(fn, 'dup')()).toThrow('closed')
	gate.resolve()
	await expect(pending).rejects.toThrow('closed')
	member(fn, Symbol.dispose)()
	expect(holds()).toBe(0)
})

test('closed owner predicate fences work immediately before completion callbacks run', async () => {
	let closed = false
	let releases = 0
	const session = createRpcSession({
		run: callback => callback(),
		retain: () => () => {
			releases++
		},
		isClosed: () => closed,
	})
	const fn = createRpcFunctionStub(() => 'not reached', undefined, session)
	session.finish()
	closed = true
	await expect(fn()).rejects.toThrow('closed')
	expect(releases).toBe(1)
})

test('legacy unscoped stubs retain no-op disposal behavior', async () => {
	const target = createRpcStub({ value: () => 5 })
	member(target, Symbol.dispose)()
	expect(await member(target, 'value')()).toBe(5)
	const fn = createRpcFunctionStub(() => 6)
	member(fn, Symbol.dispose)()
	expect(await fn()).toBe(6)
})

test('disposing a nested result releases its capabilities while a duplicate stays alive', async () => {
	const { session, holds } = setup()
	const result = wrapRpcReturnValue({ nested: [() => 'value', { [RPC_TARGET_BRAND]: true, value: () => 8 }] }, 'result', session)
	if (!result || typeof result !== 'object' || !('nested' in result) || !Array.isArray(result.nested)) throw new Error('Missing result')
	const fn = result.nested[0]
	const target = result.nested[1]
	const duplicate = member(fn, 'dup')()
	session.finish()
	member(result, Symbol.dispose)()
	member(result, Symbol.dispose)()
	expect(holds()).toBe(1)
	await expect(fn()).rejects.toThrow('disposed')
	expect(() => member(target, 'value')).toThrow('disposed')
	expect(await duplicate()).toBe('value')
	member(duplicate, Symbol.dispose)()
	expect(holds()).toBe(0)
})

test('a rejected synchronous getter does not strand the session', () => {
	const { session, holds } = setup()
	const target = createRpcStub({
		get broken() {
			throw new Error('getter failed')
		},
	}, session)
	session.finish()
	expect(() => Reflect.get(target, 'broken')).toThrow('getter failed')
	member(target, Symbol.dispose)()
	expect(holds()).toBe(0)
})

test('an asynchronous getter holds the owner until its already-started read settles', async () => {
	const { session, holds } = setup()
	const gate = Promise.withResolvers<string>()
	const started = Promise.withResolvers<void>()
	const target = createRpcStub({
		get value() {
			started.resolve()
			return gate.promise
		},
	}, session)
	session.finish()
	const value: unknown = Reflect.get(target, 'value')
	const pending = Promise.resolve(value)
	await started.promise
	await Promise.resolve()
	member(target, Symbol.dispose)()
	expect(holds()).toBe(1)
	gate.resolve('ready')
	expect(await pending).toBe('ready')
	expect(holds()).toBe(0)
})

test('property assimilation retains a pending getter before immediate parent disposal', async () => {
	const { session, holds } = setup()
	const gate = Promise.withResolvers<() => number>()
	const target = createRpcStub({
		get value() {
			return gate.promise
		},
	}, session)
	session.finish()
	const pending = Promise.resolve(Reflect.get(target, 'value'))
	member(target, Symbol.dispose)()
	gate.resolve(() => 42)
	const child: unknown = await pending
	if (typeof child !== 'function') throw new Error('Missing returned function')
	expect(await child()).toBe(42)
	expect(holds()).toBe(1)
	member(child, Symbol.dispose)()
	expect(holds()).toBe(0)
})

test('function property assimilation acquires its lease before immediate parent disposal', async () => {
	const { session, holds } = setup()
	const target = createRpcStub({
		get value() {
			return () => 42
		},
	}, session)
	session.finish()
	const pending = Promise.resolve(Reflect.get(target, 'value'))
	member(target, Symbol.dispose)()
	const child: unknown = await pending
	if (typeof child !== 'function') throw new Error('Missing returned function')
	expect(await child()).toBe(42)
	member(child, Symbol.dispose)()
	expect(holds()).toBe(0)
})

test('throwing nested accessors roll back partially wrapped capabilities', async () => {
	const { session, holds } = setup()
	let reads = 0
	const fn = createRpcFunctionStub(
		() => ({
			first: () => 42,
			nested: {
				get x() {
					reads++
					throw new Error('bad getter')
				},
			},
		}),
		undefined,
		session,
	)
	session.finish()
	await expect(fn()).rejects.toThrow('bad getter')
	expect(reads).toBe(1)
	member(fn, Symbol.dispose)()
	expect(holds()).toBe(0)
})

test('failed late result wrapping releases partial descendants after parent disposal', async () => {
	const { session, holds } = setup()
	const gate = Promise.withResolvers<void>()
	const fn = createRpcFunctionStub(
		async () => {
			await gate.promise
			return {
				first: () => 42,
				nested: {
					get x() {
						throw new Error('bad getter')
					},
				},
			}
		},
		undefined,
		session,
	)
	session.finish()
	const pending = fn()
	member(fn, Symbol.dispose)()
	expect(holds()).toBe(1)
	gate.resolve()
	await expect(pending).rejects.toThrow('bad getter')
	expect(holds()).toBe(0)
})

test('aggregate disposal ignores hostile data disposers and releases all owned capabilities', async () => {
	const { session, holds } = setup()
	let disposerReads = 0
	const date = new Date()
	Object.defineProperty(date, Symbol.dispose, {
		get() {
			disposerReads++
			throw new Error('data disposer must not run')
		},
	})
	const result = wrapRpcReturnValue({ date, nested: [() => 42], last: () => 43 }, 'result', session)
	if (!result || typeof result !== 'object' || !('nested' in result) || !Array.isArray(result.nested)) throw new Error('Missing result')
	const fn: unknown = result.nested[0]
	if (typeof fn !== 'function') throw new Error('Missing returned function')
	session.finish()
	member(result, Symbol.dispose)()
	member(result, Symbol.dispose)()
	expect(disposerReads).toBe(0)
	expect(holds()).toBe(0)
	await expect(fn()).rejects.toThrow('disposed')
})

test('null-prototype records preserve shape and recursively own capabilities and duplicates', async () => {
	const { session, holds } = setup()
	const dictionary: Record<string, unknown> = Object.create(null)
	dictionary.nested = { fn: () => 42 }
	const result = wrapRpcReturnValue(dictionary, 'result', session)
	if (!result || typeof result !== 'object' || !('nested' in result)) throw new Error('Missing result')
	expect(Object.getPrototypeOf(result)).toBeNull()
	const fn = member(result.nested, 'fn')
	const duplicate = member(fn, 'dup')()
	session.finish()
	member(result, Symbol.dispose)()
	await expect(fn()).rejects.toThrow('disposed')
	expect(await duplicate()).toBe(42)
	expect(holds()).toBe(1)
	session.close()
	await expect(duplicate()).rejects.toThrow('closed')
	expect(() => member(duplicate, 'dup')()).toThrow('closed')
	member(duplicate, Symbol.dispose)()
	expect(holds()).toBe(0)
})

test('aggregate cleanup attempts every owned disposer and stays idempotent after a cleanup failure', () => {
	let disposed = 0
	const scope = {
		run<T>(callback: () => T): T {
			return callback()
		},
		retain() {
			return {
				run<T>(callback: () => T): T {
					return callback()
				},
				dispose() {
					disposed++
					if (disposed === 1) throw new Error('first cleanup failed')
				},
			}
		},
	}
	const result = wrapRpcReturnValue({ first: () => 1, second: () => 2 }, 'result', scope)
	expect(() => member(result, Symbol.dispose)()).toThrow('RPC result disposal failed')
	expect(disposed).toBe(2)
	member(result, Symbol.dispose)()
	expect(disposed).toBe(2)
})

test('aggregate accessors serialize scalars, functions and nested records exactly once', async () => {
	const { session, holds } = setup()
	const reads: string[] = []
	const result = wrapRpcReturnValue(
		{
			get count() {
				reads.push('count')
				return 42
			},
			get fn() {
				reads.push('fn')
				return () => 43
			},
			get nested() {
				reads.push('nested')
				return {
					get value() {
						reads.push('value')
						return 44
					},
				}
			},
		},
		'result',
		session,
	)
	if (!result || typeof result !== 'object' || !('count' in result) || !('nested' in result)) throw new Error('Missing result')
	expect(result.count).toBe(42)
	expect(result.nested).toEqual({ value: 44 })
	expect(await member(result, 'fn')()).toBe(43)
	expect(reads).toEqual(['count', 'fn', 'nested', 'value'])
	session.finish()
	member(result, Symbol.dispose)()
	expect(holds()).toBe(0)
})

function nestedSessions() {
	const context = new AsyncLocalStorage<string>()
	let outerHolds = 0
	let innerHolds = 0
	const outer = createRpcSession({
		run: callback => context.run('outer', callback),
		retain() {
			outerHolds++
			return () => {
				outerHolds--
			}
		},
	})
	const inner = createRpcSession({
		run: callback => context.run('inner', callback),
		retain() {
			innerHolds++
			return () => {
				innerHolds--
			}
		},
		isClosed: () => outer.closed,
	})
	return { outer, inner, context, holds: () => [outerHolds, innerHolds] }
}

test('forwarded targets retain both sessions and preserve original context for methods, getters and descendants', async () => {
	const { outer, inner, context, holds } = nestedSessions()
	const original = createRpcStub({
		ping() {
			return context.getStore()
		},
		get value() {
			return context.getStore()
		},
		child() {
			return () => context.getStore()
		},
	}, inner)
	inner.finish()
	const forwarded = wrapRpcReturnValue(original, 'open', outer)
	outer.finish()
	expect(holds()).toEqual([1, 1])
	expect(await member(forwarded, 'ping')()).toBe('inner')
	if (!forwarded || typeof forwarded !== 'object') throw new Error('Missing target')
	expect(await Reflect.get(forwarded, 'value')).toBe('inner')
	const child: unknown = await member(forwarded, 'child')()
	const duplicate = member(forwarded, 'dup')()
	member(forwarded, Symbol.dispose)()
	expect(await member(duplicate, 'ping')()).toBe('inner')
	member(duplicate, Symbol.dispose)()
	if (typeof child !== 'function') throw new Error('Missing child')
	expect(await child()).toBe('inner')
	expect(holds()).toEqual([1, 1])
	member(child, Symbol.dispose)()
	member(child, Symbol.dispose)()
	expect(holds()).toEqual([0, 0])
})

test('forwarded function calls survive disposal through settlement and descendant wrapping', async () => {
	const { outer, inner, context, holds } = nestedSessions()
	const gate = Promise.withResolvers<void>()
	const original = createRpcFunctionStub(
		async () => {
			await gate.promise
			return () => context.getStore()
		},
		undefined,
		inner,
	)
	inner.finish()
	const forwarded = wrapRpcReturnValue(original, 'open', outer)
	if (typeof forwarded !== 'function') throw new Error('Missing function')
	outer.finish()
	const duplicate = member(forwarded, 'dup')()
	member(forwarded, Symbol.dispose)()
	const pending = duplicate()
	member(duplicate, Symbol.dispose)()
	expect(holds()).toEqual([1, 1])
	gate.resolve()
	const child: unknown = await pending
	if (typeof child !== 'function') throw new Error('Missing child')
	expect(await child()).toBe('inner')
	member(child, Symbol.dispose)()
	expect(holds()).toEqual([0, 0])
})

test('forwarded aggregates transfer child ownership and termination revokes surviving duplicates', async () => {
	const { outer, inner, context, holds } = nestedSessions()
	const original = wrapRpcReturnValue({ nested: [() => context.getStore()] }, 'inner', inner)
	inner.finish()
	const forwarded = wrapRpcReturnValue(original, 'outer', outer)
	if (!forwarded || typeof forwarded !== 'object' || !('nested' in forwarded) || !Array.isArray(forwarded.nested)) throw new Error('Missing result')
	const fn: unknown = forwarded.nested[0]
	if (typeof fn !== 'function') throw new Error('Missing function')
	const duplicate = member(fn, 'dup')()
	outer.finish()
	member(forwarded, Symbol.dispose)()
	expect(await duplicate()).toBe('inner')
	outer.close()
	await expect(duplicate()).rejects.toThrow('closed')
	member(duplicate, Symbol.dispose)()
	expect(holds()).toEqual([0, 0])
})

test('failed aggregate forwarding rolls back new leases without consuming the original capability', async () => {
	const { outer, inner, context, holds } = nestedSessions()
	const original = createRpcFunctionStub(() => context.getStore(), undefined, inner)
	inner.finish()
	expect(() =>
		wrapRpcReturnValue(
			{
				first: original,
				get broken() {
					throw new Error('serialization failed')
				},
			},
			'outer',
			outer,
		)
	).toThrow('serialization failed')
	expect(await original()).toBe('inner')
	member(original, Symbol.dispose)()
	outer.finish()
	expect(holds()).toEqual([0, 0])
})

test('unscoped wrapping preserves existing stub identity', () => {
	const { session } = setup()
	const target = createRpcStub({}, session)
	const fn = createRpcFunctionStub(() => 42, undefined, session)
	expect(wrapRpcReturnValue(target, 'unscoped')).toBe(target)
	expect(wrapRpcReturnValue(fn, 'unscoped')).toBe(fn)
	member(target, Symbol.dispose)()
	member(fn, Symbol.dispose)()
	session.finish()
})

test('a rejected forwarded call releases both sessions after disposal', async () => {
	const { outer, inner, holds } = nestedSessions()
	const gate = Promise.withResolvers<void>()
	const original = createRpcFunctionStub(() => gate.promise, undefined, inner)
	inner.finish()
	const forwarded = wrapRpcReturnValue(original, 'outer', outer)
	if (typeof forwarded !== 'function') throw new Error('Missing function')
	outer.finish()
	const pending = forwarded()
	member(forwarded, Symbol.dispose)()
	expect(holds()).toEqual([1, 1])
	gate.reject(new Error('forwarded failure'))
	await expect(pending).rejects.toThrow('forwarded failure')
	expect(holds()).toEqual([0, 0])
})

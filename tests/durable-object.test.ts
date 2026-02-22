import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	DurableObjectBase,
	DurableObjectIdImpl,
	type DurableObjectLimits,
	DurableObjectNamespaceImpl,
	DurableObjectStateImpl,
	SqliteDurableObjectStorage,
	SqlStorage,
	SqlStorageCursor,
	SyncKV,
	WebSocketRequestResponsePair,
} from '../src/bindings/durable-object'
import { runMigrations } from '../src/db'

/** Minimal mock WebSocket for testing state.acceptWebSocket() and friends */
class MockWebSocket extends EventTarget {
	sent: (string | ArrayBuffer)[] = []
	readyState = 1 // OPEN

	send(data: string | ArrayBuffer) {
		this.sent.push(data)
	}

	close(_code?: number, _reason?: string) {
		this.readyState = 3 // CLOSED
		this.dispatchEvent(new CloseEvent('close', { code: _code ?? 1000, reason: _reason ?? '', wasClean: true }))
	}

	/** Simulate receiving a message */
	_receiveMessage(data: string | ArrayBuffer) {
		this.dispatchEvent(new MessageEvent('message', { data }))
	}

	/** Simulate an error */
	_triggerError() {
		this.dispatchEvent(new Event('error'))
	}
}

let db: Database

beforeEach(() => {
	db = new Database(':memory:')
	runMigrations(db)
})

describe('DurableObjectStorage', () => {
	let storage: SqliteDurableObjectStorage

	beforeEach(() => {
		storage = new SqliteDurableObjectStorage(db, 'TestDO', 'instance1')
	})

	test('get non-existent key returns undefined', async () => {
		expect(await storage.get('missing')).toBeUndefined()
	})

	test('put and get single key', async () => {
		await storage.put('count', 42)
		expect(await storage.get<number>('count')).toBe(42)
	})

	test('put overwrites existing value', async () => {
		await storage.put('key', 'first')
		await storage.put('key', 'second')
		expect(await storage.get<string>('key')).toBe('second')
	})

	test('put and get complex value', async () => {
		await storage.put('data', { nested: { array: [1, 2, 3] } })
		expect(await storage.get<{ nested: { array: number[] } }>('data')).toEqual({ nested: { array: [1, 2, 3] } })
	})

	test('put entries object', async () => {
		await storage.put({ a: 1, b: 2, c: 3 })
		expect(await storage.get<number>('a')).toBe(1)
		expect(await storage.get<number>('b')).toBe(2)
		expect(await storage.get<number>('c')).toBe(3)
	})

	test('get multiple keys returns Map', async () => {
		await storage.put('a', 1)
		await storage.put('b', 2)
		const result = await storage.get(['a', 'b', 'missing'])
		expect(result).toBeInstanceOf(Map)
		expect(result.size).toBe(2)
		expect(result.get('a')).toBe(1)
		expect(result.get('b')).toBe(2)
		expect(result.has('missing')).toBe(false)
	})

	test('get empty keys array returns empty Map', async () => {
		const result = await storage.get([])
		expect(result).toBeInstanceOf(Map)
		expect(result.size).toBe(0)
	})

	test('delete single key returns boolean', async () => {
		await storage.put('key', 'val')
		expect(await storage.delete('key')).toBe(true)
		expect(await storage.get('key')).toBeUndefined()
	})

	test('delete non-existent key returns false', async () => {
		expect(await storage.delete('missing')).toBe(false)
	})

	test('delete multiple keys returns count', async () => {
		await storage.put('a', 1)
		await storage.put('b', 2)
		const count = await storage.delete(['a', 'b', 'missing'])
		expect(count).toBe(2)
	})

	test('delete empty keys array returns 0', async () => {
		expect(await storage.delete([])).toBe(0)
	})

	test('deleteAll removes all keys for this instance', async () => {
		await storage.put('a', 1)
		await storage.put('b', 2)
		await storage.deleteAll()
		expect(await storage.get('a')).toBeUndefined()
		expect(await storage.get('b')).toBeUndefined()
		const result = await storage.list()
		expect(result.size).toBe(0)
	})

	test('list all keys', async () => {
		await storage.put('x', 1)
		await storage.put('y', 2)
		const result = await storage.list()
		expect(result.size).toBe(2)
		expect(result.get('x')).toBe(1)
		expect(result.get('y')).toBe(2)
	})

	test('list with prefix', async () => {
		await storage.put('user:1', 'a')
		await storage.put('user:2', 'b')
		await storage.put('post:1', 'c')
		const result = await storage.list({ prefix: 'user:' })
		expect(result.size).toBe(2)
		expect(result.has('post:1')).toBe(false)
	})

	test('list with limit', async () => {
		await storage.put('a', 1)
		await storage.put('b', 2)
		await storage.put('c', 3)
		const result = await storage.list({ limit: 2 })
		expect(result.size).toBe(2)
	})

	test('list with start and end', async () => {
		await storage.put('a', 1)
		await storage.put('b', 2)
		await storage.put('c', 3)
		await storage.put('d', 4)
		const result = await storage.list({ start: 'b', end: 'd' })
		expect(result.size).toBe(2)
		expect(result.has('b')).toBe(true)
		expect(result.has('c')).toBe(true)
		expect(result.has('a')).toBe(false)
		expect(result.has('d')).toBe(false)
	})

	test('list with reverse', async () => {
		await storage.put('a', 1)
		await storage.put('b', 2)
		await storage.put('c', 3)
		const result = await storage.list({ reverse: true, limit: 2 })
		expect(result.size).toBe(2)
		const keys = [...result.keys()]
		expect(keys[0]).toBe('c')
		expect(keys[1]).toBe('b')
	})

	test('list empty storage', async () => {
		const result = await storage.list()
		expect(result.size).toBe(0)
	})

	test('transaction executes closure', async () => {
		await storage.transaction(async (txn) => {
			await txn.put('key', 'value')
		})
		expect(await storage.get<string>('key')).toBe('value')
	})

	test("namespace isolation — different namespaces don't share data", async () => {
		const storage2 = new SqliteDurableObjectStorage(db, 'OtherDO', 'instance1')
		await storage.put('shared-key', 'from-TestDO')
		await storage2.put('shared-key', 'from-OtherDO')
		expect(await storage.get<string>('shared-key')).toBe('from-TestDO')
		expect(await storage2.get<string>('shared-key')).toBe('from-OtherDO')
	})

	test("instance isolation — different instances don't share data", async () => {
		const storage2 = new SqliteDurableObjectStorage(db, 'TestDO', 'instance2')
		await storage.put('key', 'instance1-value')
		await storage2.put('key', 'instance2-value')
		expect(await storage.get<string>('key')).toBe('instance1-value')
		expect(await storage2.get<string>('key')).toBe('instance2-value')
	})

	test('persistence across storage instances with same db/namespace/id', async () => {
		await storage.put('persistent', 'data')
		const storage2 = new SqliteDurableObjectStorage(db, 'TestDO', 'instance1')
		expect(await storage2.get<string>('persistent')).toBe('data')
	})
})

describe('DurableObjectState', () => {
	test('blockConcurrencyWhile executes callback and returns result', async () => {
		const id = new DurableObjectIdImpl('test-id')
		const state = new DurableObjectStateImpl(id, db, 'TestDO')
		const result = await state.blockConcurrencyWhile(async () => {
			await state.storage.put('initialized', true)
			return 42
		})
		expect(result).toBe(42)
		expect(await state.storage.get<boolean>('initialized')).toBe(true)
	})
})

describe('DurableObjectNamespace', () => {
	class TestCounter extends DurableObjectBase {
		async getCount(): Promise<number> {
			return ((await this.ctx.storage.get<number>('count')) ?? 0)
		}
		async increment(): Promise<number> {
			const count = (await this.getCount()) + 1
			await this.ctx.storage.put('count', count)
			return count
		}
	}

	let ns: DurableObjectNamespaceImpl

	beforeEach(() => {
		ns = new DurableObjectNamespaceImpl(db, 'TestCounter', undefined, { evictionTimeoutMs: 0 })
		ns._setClass(TestCounter, {})
	})

	test('idFromName returns deterministic id', () => {
		const id1 = ns.idFromName('test')
		const id2 = ns.idFromName('test')
		expect(id1.toString()).toBe(id2.toString())
		expect(id1.name).toBe('test')
	})

	test('idFromName different names produce different ids', () => {
		const id1 = ns.idFromName('a')
		const id2 = ns.idFromName('b')
		expect(id1.toString()).not.toBe(id2.toString())
	})

	test('idFromString wraps raw id', () => {
		const id = ns.idFromString('raw-id-hex')
		expect(id.toString()).toBe('raw-id-hex')
		expect(id.name).toBeUndefined()
	})

	test('get returns proxy stub with callable methods', async () => {
		const id = ns.idFromName('counter1')
		const stub = ns.get(id) as any
		expect(await stub.getCount()).toBe(0)
		expect(await stub.increment()).toBe(1)
		expect(await stub.increment()).toBe(2)
		expect(await stub.getCount()).toBe(2)
	})

	test('same id returns same instance (shared state)', async () => {
		const id = ns.idFromName('counter1')
		const stub1 = ns.get(id) as any
		await stub1.increment()

		const stub2 = ns.get(id) as any
		expect(await stub2.getCount()).toBe(1)
	})

	test('different ids have independent state', async () => {
		const id1 = ns.idFromName('a')
		const id2 = ns.idFromName('b')
		const stub1 = ns.get(id1) as any
		const stub2 = ns.get(id2) as any

		await stub1.increment()
		await stub1.increment()

		expect(await stub1.getCount()).toBe(2)
		expect(await stub2.getCount()).toBe(0)
	})

	test('get throws if class not wired', () => {
		const ns2 = new DurableObjectNamespaceImpl(db, 'Unwired')
		const id = new DurableObjectIdImpl('test')
		expect(() => ns2.get(id)).toThrow('not wired')
	})

	test('newUniqueId returns unique ids', () => {
		const id1 = ns.newUniqueId()
		const id2 = ns.newUniqueId()
		expect(id1.toString()).not.toBe(id2.toString())
		expect(id1.name).toBeUndefined()
	})

	test('newUniqueId accepts jurisdiction option (ignored)', () => {
		const id = ns.newUniqueId({ jurisdiction: 'eu' })
		expect(id.toString().length).toBeGreaterThan(0)
	})

	test('getByName is shorthand for idFromName + get', async () => {
		const stub1 = ns.getByName('counter1') as { increment(): Promise<number>; getCount(): Promise<number> }
		await stub1.increment()

		const id = ns.idFromName('counter1')
		const stub2 = ns.get(id) as { getCount(): Promise<number> }
		expect(await stub2.getCount()).toBe(1)
	})

	test('blockConcurrencyWhile defers proxy calls until ready', async () => {
		const order: string[] = []

		class SlowInitDO extends DurableObjectBase {
			constructor(ctx: DurableObjectStateImpl, env: unknown) {
				super(ctx, env)
				ctx.blockConcurrencyWhile(async () => {
					await new Promise((r) => setTimeout(r, 50))
					order.push('init-done')
				})
			}
			async hello(): Promise<string> {
				order.push('hello')
				return 'world'
			}
		}

		const ns2 = new DurableObjectNamespaceImpl(db, 'SlowInit', undefined, { evictionTimeoutMs: 0 })
		ns2._setClass(SlowInitDO, {})
		const stub = ns2.get(ns2.idFromName('test')) as { hello(): Promise<string> }
		const result = await stub.hello()
		expect(result).toBe('world')
		expect(order).toEqual(['init-done', 'hello'])
	})

	test('data persists across namespace instances (same db)', async () => {
		const id = ns.idFromName('counter1')
		const stub = ns.get(id) as any
		await stub.increment()
		await stub.increment()

		// Create a new namespace instance pointing to same db
		const ns2 = new DurableObjectNamespaceImpl(db, 'TestCounter', undefined, { evictionTimeoutMs: 0 })
		ns2._setClass(TestCounter, {})
		const stub2 = ns2.get(id) as any
		expect(await stub2.getCount()).toBe(2)
	})
})

describe('DurableObject Alarms', () => {
	describe('Storage alarm methods', () => {
		let storage: SqliteDurableObjectStorage

		beforeEach(() => {
			storage = new SqliteDurableObjectStorage(db, 'TestDO', 'instance1')
		})

		test('getAlarm returns null when no alarm set', async () => {
			expect(await storage.getAlarm()).toBeNull()
		})

		test('setAlarm and getAlarm', async () => {
			const time = Date.now() + 60000
			await storage.setAlarm(time)
			expect(await storage.getAlarm()).toBe(time)
		})

		test('setAlarm accepts Date object', async () => {
			const date = new Date(Date.now() + 60000)
			await storage.setAlarm(date)
			expect(await storage.getAlarm()).toBe(date.getTime())
		})

		test('setAlarm replaces existing alarm', async () => {
			await storage.setAlarm(Date.now() + 60000)
			const newTime = Date.now() + 120000
			await storage.setAlarm(newTime)
			expect(await storage.getAlarm()).toBe(newTime)
		})

		test('deleteAlarm removes alarm', async () => {
			await storage.setAlarm(Date.now() + 60000)
			await storage.deleteAlarm()
			expect(await storage.getAlarm()).toBeNull()
		})

		test('deleteAlarm on non-existent alarm is no-op', async () => {
			await storage.deleteAlarm() // should not throw
			expect(await storage.getAlarm()).toBeNull()
		})

		test('alarm isolation between instances', async () => {
			const storage2 = new SqliteDurableObjectStorage(db, 'TestDO', 'instance2')
			const time1 = Date.now() + 60000
			const time2 = Date.now() + 120000
			await storage.setAlarm(time1)
			await storage2.setAlarm(time2)
			expect(await storage.getAlarm()).toBe(time1)
			expect(await storage2.getAlarm()).toBe(time2)
		})
	})

	describe('Alarm firing via namespace', () => {
		test('alarm fires at scheduled time', async () => {
			const alarmCalls: { retryCount: number; isRetry: boolean }[] = []

			class AlarmDO extends DurableObjectBase {
				async alarm(info: { retryCount: number; isRetry: boolean }) {
					alarmCalls.push(info)
				}
			}

			const ns = new DurableObjectNamespaceImpl(db, 'AlarmDO', undefined, { evictionTimeoutMs: 0 })
			ns._setClass(AlarmDO, {})

			const id = ns.idFromName('test')
			ns.get(id) // ensure instance created
			const instance = ns._getInstance(id.toString())!
			await instance.ctx.storage.setAlarm(Date.now() + 10)

			// Wait for alarm to fire
			await new Promise((r) => setTimeout(r, 50))

			expect(alarmCalls.length).toBe(1)
			expect(alarmCalls[0]!.retryCount).toBe(0)
			expect(alarmCalls[0]!.isRetry).toBe(false)
		})

		test('alarm is cleared from DB after firing', async () => {
			class AlarmDO extends DurableObjectBase {
				async alarm() {}
			}

			const ns = new DurableObjectNamespaceImpl(db, 'AlarmDO2', undefined, { evictionTimeoutMs: 0 })
			ns._setClass(AlarmDO, {})

			const id = ns.idFromName('test')
			ns.get(id)
			const instance = ns._getInstance(id.toString())!
			await instance.ctx.storage.setAlarm(Date.now() + 10)

			await new Promise((r) => setTimeout(r, 50))

			expect(await instance.ctx.storage.getAlarm()).toBeNull()
		})

		test('setAlarm replaces previous timer', async () => {
			let callCount = 0

			class AlarmDO extends DurableObjectBase {
				async alarm() {
					callCount++
				}
			}

			const ns = new DurableObjectNamespaceImpl(db, 'AlarmDO3', undefined, { evictionTimeoutMs: 0 })
			ns._setClass(AlarmDO, {})

			const id = ns.idFromName('test')
			ns.get(id)
			const instance = ns._getInstance(id.toString())!

			// Set alarm far in the future
			await instance.ctx.storage.setAlarm(Date.now() + 100000)
			// Replace with a near alarm
			await instance.ctx.storage.setAlarm(Date.now() + 10)

			await new Promise((r) => setTimeout(r, 50))

			expect(callCount).toBe(1)
		})

		test('deleteAlarm cancels pending timer', async () => {
			let called = false

			class AlarmDO extends DurableObjectBase {
				async alarm() {
					called = true
				}
			}

			const ns = new DurableObjectNamespaceImpl(db, 'AlarmDO4', undefined, { evictionTimeoutMs: 0 })
			ns._setClass(AlarmDO, {})

			const id = ns.idFromName('test')
			ns.get(id)
			const instance = ns._getInstance(id.toString())!
			await instance.ctx.storage.setAlarm(Date.now() + 30)
			await instance.ctx.storage.deleteAlarm()

			await new Promise((r) => setTimeout(r, 80))

			expect(called).toBe(false)
		})

		test('alarm retries on error with backoff info', async () => {
			const attempts: { retryCount: number; isRetry: boolean }[] = []
			let shouldFail = true

			class AlarmDO extends DurableObjectBase {
				async alarm(info: { retryCount: number; isRetry: boolean }) {
					attempts.push(info)
					if (shouldFail) {
						shouldFail = false
						throw new Error('Simulated failure')
					}
				}
			}

			const ns = new DurableObjectNamespaceImpl(db, 'AlarmDO5', undefined, { evictionTimeoutMs: 0 })
			ns._setClass(AlarmDO, {})

			const id = ns.idFromName('test')
			ns.get(id)
			const instance = ns._getInstance(id.toString())!
			await instance.ctx.storage.setAlarm(Date.now() + 10)

			// Wait for first fire + retry (backoff is 1s for retry 0, but we set timeout to be enough)
			await new Promise((r) => setTimeout(r, 1200))

			expect(attempts.length).toBe(2)
			expect(attempts[0]).toEqual({ retryCount: 0, isRetry: false })
			expect(attempts[1]).toEqual({ retryCount: 1, isRetry: true })
		})

		test('past-due alarm fires immediately on restore', async () => {
			let fired = false

			class AlarmDO extends DurableObjectBase {
				async alarm() {
					fired = true
				}
			}

			// Insert a past-due alarm directly into DB
			db.query('INSERT OR REPLACE INTO do_alarms (namespace, id, alarm_time) VALUES (?, ?, ?)')
				.run('AlarmDO6', 'past-due-id', Date.now() - 1000)

			const ns = new DurableObjectNamespaceImpl(db, 'AlarmDO6', undefined, { evictionTimeoutMs: 0 })
			ns._setClass(AlarmDO, {}) // _restoreAlarms should schedule it immediately

			await new Promise((r) => setTimeout(r, 50))

			expect(fired).toBe(true)
		})

		test('alarm persists across namespace instances', async () => {
			class AlarmDO extends DurableObjectBase {
				async alarm() {}
			}

			const ns = new DurableObjectNamespaceImpl(db, 'AlarmDO7', undefined, { evictionTimeoutMs: 0 })
			ns._setClass(AlarmDO, {})

			const id = ns.idFromName('test')
			ns.get(id)
			const instance = ns._getInstance(id.toString())!
			const futureTime = Date.now() + 600000
			await instance.ctx.storage.setAlarm(futureTime)

			// Create a new storage instance pointing to same db/namespace/id
			const storage2 = new SqliteDurableObjectStorage(db, 'AlarmDO7', id.toString())
			expect(await storage2.getAlarm()).toBe(futureTime)
		})
	})
})

describe('DurableObject WebSocket Support', () => {
	describe('State WebSocket methods', () => {
		let state: DurableObjectStateImpl

		beforeEach(() => {
			const id = new DurableObjectIdImpl('ws-test')
			state = new DurableObjectStateImpl(id, db, 'WsDO')
		})

		test('acceptWebSocket registers a WebSocket', () => {
			const ws = new MockWebSocket()
			state.acceptWebSocket(ws as unknown as WebSocket)
			expect(state.getWebSockets()).toHaveLength(1)
			expect(state.getWebSockets()[0]).toBe(ws as unknown as WebSocket)
		})

		test('acceptWebSocket with tags', () => {
			const ws = new MockWebSocket()
			state.acceptWebSocket(ws as unknown as WebSocket, ['user:1', 'room:lobby'])
			expect(state.getTags(ws as unknown as WebSocket)).toEqual(['user:1', 'room:lobby'])
		})

		test('getWebSockets filters by tag', () => {
			const ws1 = new MockWebSocket()
			const ws2 = new MockWebSocket()
			const ws3 = new MockWebSocket()
			state.acceptWebSocket(ws1 as unknown as WebSocket, ['room:a'])
			state.acceptWebSocket(ws2 as unknown as WebSocket, ['room:b'])
			state.acceptWebSocket(ws3 as unknown as WebSocket, ['room:a', 'room:b'])

			const roomA = state.getWebSockets('room:a')
			expect(roomA).toHaveLength(2)
			expect(roomA).toContain(ws1 as unknown as WebSocket)
			expect(roomA).toContain(ws3 as unknown as WebSocket)

			const roomB = state.getWebSockets('room:b')
			expect(roomB).toHaveLength(2)
			expect(roomB).toContain(ws2 as unknown as WebSocket)
			expect(roomB).toContain(ws3 as unknown as WebSocket)
		})

		test('getWebSockets without tag returns all', () => {
			const ws1 = new MockWebSocket()
			const ws2 = new MockWebSocket()
			state.acceptWebSocket(ws1 as unknown as WebSocket)
			state.acceptWebSocket(ws2 as unknown as WebSocket, ['tagged'])
			expect(state.getWebSockets()).toHaveLength(2)
		})

		test('getTags returns empty array for unknown ws', () => {
			const ws = new MockWebSocket()
			expect(state.getTags(ws as unknown as WebSocket)).toEqual([])
		})

		test('closed WebSocket is removed from accepted set', () => {
			const ws = new MockWebSocket()
			state.acceptWebSocket(ws as unknown as WebSocket)
			expect(state.getWebSockets()).toHaveLength(1)
			ws.close()
			expect(state.getWebSockets()).toHaveLength(0)
		})

		test('setWebSocketAutoResponse and getWebSocketAutoResponse', () => {
			expect(state.getWebSocketAutoResponse()).toBeNull()
			const pair = new WebSocketRequestResponsePair('ping', 'pong')
			state.setWebSocketAutoResponse(pair)
			expect(state.getWebSocketAutoResponse()).toBe(pair)
		})

		test('setWebSocketAutoResponse with no arg clears it', () => {
			state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
			state.setWebSocketAutoResponse()
			expect(state.getWebSocketAutoResponse()).toBeNull()
		})

		test('auto-response sends response and skips handler', async () => {
			const messages: (string | ArrayBuffer)[] = []
			class WsDO extends DurableObjectBase {
				async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer) {
					messages.push(message)
				}
			}
			const instance = new WsDO(state, {})
			state._setInstanceResolver(() => instance)

			state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))

			const ws = new MockWebSocket()
			state.acceptWebSocket(ws as unknown as WebSocket)

			ws._receiveMessage('ping')
			await new Promise((r) => setTimeout(r, 10))

			// Auto-response was sent
			expect(ws.sent).toEqual(['pong'])
			// Handler was NOT called
			expect(messages).toEqual([])
		})

		test('non-matching message goes to handler', async () => {
			const messages: (string | ArrayBuffer)[] = []
			class WsDO extends DurableObjectBase {
				async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer) {
					messages.push(message)
				}
			}
			const instance = new WsDO(state, {})
			state._setInstanceResolver(() => instance)

			state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))

			const ws = new MockWebSocket()
			state.acceptWebSocket(ws as unknown as WebSocket)

			ws._receiveMessage('hello')
			await new Promise((r) => setTimeout(r, 10))

			expect(ws.sent).toEqual([])
			expect(messages).toEqual(['hello'])
		})

		test('getWebSocketAutoResponseTimestamp', () => {
			const ws = new MockWebSocket()
			state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
			state.acceptWebSocket(ws as unknown as WebSocket)

			// Before auto-response, timestamp is null
			expect(state.getWebSocketAutoResponseTimestamp(ws as unknown as WebSocket)).toBeNull()

			ws._receiveMessage('ping')

			// After auto-response, timestamp is set
			const ts = state.getWebSocketAutoResponseTimestamp(ws as unknown as WebSocket)
			expect(ts).toBeInstanceOf(Date)
			expect(ts!.getTime()).toBeCloseTo(Date.now(), -2)
		})

		test('getWebSocketAutoResponseTimestamp returns null for unknown ws', () => {
			const ws = new MockWebSocket()
			expect(state.getWebSocketAutoResponseTimestamp(ws as unknown as WebSocket)).toBeNull()
		})
	})

	describe('WebSocket handler delegation via namespace', () => {
		test('webSocketMessage handler is called', async () => {
			const received: { ws: unknown; msg: string | ArrayBuffer }[] = []

			class WsDO extends DurableObjectBase {
				async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
					received.push({ ws, msg: message })
				}
			}

			const ns = new DurableObjectNamespaceImpl(db, 'WsDO1', undefined, { evictionTimeoutMs: 0 })
			ns._setClass(WsDO, {})

			const id = ns.idFromName('test')
			ns.get(id)
			const instance = ns._getInstance(id.toString())!
			const ws = new MockWebSocket()
			instance.ctx.acceptWebSocket(ws as unknown as WebSocket)

			ws._receiveMessage('hello world')
			await new Promise((r) => setTimeout(r, 10))

			expect(received).toHaveLength(1)
			expect(received[0]!.msg).toBe('hello world')
			expect(received[0]!.ws).toBe(ws)
		})

		test('webSocketClose handler is called', async () => {
			const closed: { code: number; reason: string }[] = []

			class WsDO extends DurableObjectBase {
				async webSocketClose(_ws: WebSocket, code: number, reason: string, _wasClean: boolean) {
					closed.push({ code, reason })
				}
			}

			const ns = new DurableObjectNamespaceImpl(db, 'WsDO2', undefined, { evictionTimeoutMs: 0 })
			ns._setClass(WsDO, {})

			const id = ns.idFromName('test')
			ns.get(id)
			const instance = ns._getInstance(id.toString())!
			const ws = new MockWebSocket()
			instance.ctx.acceptWebSocket(ws as unknown as WebSocket)

			ws.close(1001, 'going away')
			await new Promise((r) => setTimeout(r, 10))

			expect(closed).toHaveLength(1)
			expect(closed[0]).toEqual({ code: 1001, reason: 'going away' })
		})

		test('webSocketError handler is called', async () => {
			let errorCalled = false

			class WsDO extends DurableObjectBase {
				async webSocketError(_ws: WebSocket, _error: unknown) {
					errorCalled = true
				}
			}

			const ns = new DurableObjectNamespaceImpl(db, 'WsDO3', undefined, { evictionTimeoutMs: 0 })
			ns._setClass(WsDO, {})

			const id = ns.idFromName('test')
			ns.get(id)
			const instance = ns._getInstance(id.toString())!
			const ws = new MockWebSocket()
			instance.ctx.acceptWebSocket(ws as unknown as WebSocket)

			ws._triggerError()
			await new Promise((r) => setTimeout(r, 10))

			expect(errorCalled).toBe(true)
		})
	})
})

describe('DurableObject SQL Storage', () => {
	let dataDir: string

	beforeEach(() => {
		dataDir = mkdtempSync(join(tmpdir(), 'lopata-do-sql-'))
	})

	describe('SqlStorage', () => {
		let sql: SqlStorage

		beforeEach(() => {
			sql = new SqlStorage(join(dataDir, 'do-sql', 'TestDO', 'inst1.sqlite'))
		})

		test('exec creates table and inserts data', () => {
			sql.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)')
			sql.exec('INSERT INTO users (id, name) VALUES (?, ?)', 1, 'Alice')
			const cursor = sql.exec('SELECT * FROM users')
			const rows = cursor.toArray()
			expect(rows).toEqual([{ id: 1, name: 'Alice' }])
		})

		test('exec returns cursor with columnNames', () => {
			sql.exec('CREATE TABLE t (a TEXT, b INTEGER, c REAL)')
			const cursor = sql.exec('SELECT * FROM t')
			expect(cursor.columnNames).toEqual(['a', 'b', 'c'])
		})

		test('cursor iteration via for..of', () => {
			sql.exec('CREATE TABLE nums (val INTEGER)')
			sql.exec('INSERT INTO nums VALUES (?)', 10)
			sql.exec('INSERT INTO nums VALUES (?)', 20)
			sql.exec('INSERT INTO nums VALUES (?)', 30)
			const cursor = sql.exec('SELECT val FROM nums ORDER BY val')
			const values: number[] = []
			for (const row of cursor) {
				values.push(row.val as number)
			}
			expect(values).toEqual([10, 20, 30])
		})

		test('cursor next() implements iterator protocol', () => {
			sql.exec('CREATE TABLE items (x TEXT)')
			sql.exec('INSERT INTO items VALUES (?)', 'a')
			sql.exec('INSERT INTO items VALUES (?)', 'b')
			const cursor = sql.exec('SELECT x FROM items ORDER BY x')
			expect(cursor.next()).toEqual({ done: false, value: { x: 'a' } })
			expect(cursor.next()).toEqual({ done: false, value: { x: 'b' } })
			expect(cursor.next().done).toBe(true)
		})

		test('cursor one() returns single row', () => {
			sql.exec('CREATE TABLE single (v INTEGER)')
			sql.exec('INSERT INTO single VALUES (?)', 42)
			const row = sql.exec('SELECT v FROM single').one()
			expect(row).toEqual({ v: 42 })
		})

		test('cursor one() throws on zero rows', () => {
			sql.exec('CREATE TABLE empty_t (v INTEGER)')
			expect(() => sql.exec('SELECT v FROM empty_t').one()).toThrow('Expected exactly one row, got 0')
		})

		test('cursor one() throws on multiple rows', () => {
			sql.exec('CREATE TABLE multi (v INTEGER)')
			sql.exec('INSERT INTO multi VALUES (1)')
			sql.exec('INSERT INTO multi VALUES (2)')
			expect(() => sql.exec('SELECT v FROM multi').one()).toThrow('Expected exactly one row, got 2')
		})

		test('cursor raw() returns arrays without column names', () => {
			sql.exec('CREATE TABLE raw_t (a TEXT, b INTEGER)')
			sql.exec('INSERT INTO raw_t VALUES (?, ?)', 'hello', 99)
			const raw = sql.exec('SELECT a, b FROM raw_t').raw()
			expect(raw).toEqual([['hello', 99]])
		})

		test('cursor rowsRead for SELECT', () => {
			sql.exec('CREATE TABLE rr (v INTEGER)')
			sql.exec('INSERT INTO rr VALUES (1)')
			sql.exec('INSERT INTO rr VALUES (2)')
			sql.exec('INSERT INTO rr VALUES (3)')
			const cursor = sql.exec('SELECT * FROM rr')
			expect(cursor.rowsRead).toBe(3)
			expect(cursor.rowsWritten).toBe(0)
		})

		test('cursor rowsWritten for INSERT/UPDATE/DELETE', () => {
			sql.exec('CREATE TABLE rw (v INTEGER)')
			const insert = sql.exec('INSERT INTO rw VALUES (1)')
			expect(insert.rowsWritten).toBe(1)
			expect(insert.rowsRead).toBe(0)

			sql.exec('INSERT INTO rw VALUES (2)')
			sql.exec('INSERT INTO rw VALUES (3)')
			const del = sql.exec('DELETE FROM rw WHERE v > 1')
			expect(del.rowsWritten).toBe(2)
		})

		test('databaseSize returns file size', () => {
			sql.exec('CREATE TABLE sz (data TEXT)')
			sql.exec('INSERT INTO sz VALUES (?)', 'some data here')
			const size = sql.databaseSize
			expect(size).toBeGreaterThan(0)
		})

		test('databaseSize returns 0 before any exec', () => {
			const sql2 = new SqlStorage(join(dataDir, 'do-sql', 'TestDO', 'nonexistent.sqlite'))
			expect(sql2.databaseSize).toBe(0)
		})

		test('parameter bindings work correctly', () => {
			sql.exec('CREATE TABLE params (a TEXT, b INTEGER, c REAL, d BLOB)')
			sql.exec('INSERT INTO params VALUES (?, ?, ?, ?)', 'text', 42, 3.14, null)
			const row = sql.exec('SELECT * FROM params').one()
			expect(row.a).toBe('text')
			expect(row.b).toBe(42)
			expect(row.c).toBeCloseTo(3.14)
			expect(row.d).toBeNull()
		})
	})

	describe('SqlStorage via DurableObjectStorage', () => {
		test('storage.sql is accessible with dataDir', () => {
			const storage = new SqliteDurableObjectStorage(db, 'TestDO', 'inst1', dataDir)
			expect(storage.sql).toBeInstanceOf(SqlStorage)
		})

		test('storage.sql throws without dataDir', () => {
			const storage = new SqliteDurableObjectStorage(db, 'TestDO', 'inst1')
			expect(() => storage.sql).toThrow('dataDir not configured')
		})

		test('sql storage is isolated per DO instance', () => {
			const storage1 = new SqliteDurableObjectStorage(db, 'TestDO', 'inst1', dataDir)
			const storage2 = new SqliteDurableObjectStorage(db, 'TestDO', 'inst2', dataDir)

			storage1.sql.exec('CREATE TABLE data (v TEXT)')
			storage1.sql.exec('INSERT INTO data VALUES (?)', 'from-inst1')

			storage2.sql.exec('CREATE TABLE data (v TEXT)')
			storage2.sql.exec('INSERT INTO data VALUES (?)', 'from-inst2')

			expect(storage1.sql.exec('SELECT v FROM data').one().v).toBe('from-inst1')
			expect(storage2.sql.exec('SELECT v FROM data').one().v).toBe('from-inst2')
		})

		test('sql storage persists across storage instances', () => {
			const storage1 = new SqliteDurableObjectStorage(db, 'TestDO', 'inst1', dataDir)
			storage1.sql.exec('CREATE TABLE persist (v INTEGER)')
			storage1.sql.exec('INSERT INTO persist VALUES (?)', 123)

			const storage2 = new SqliteDurableObjectStorage(db, 'TestDO', 'inst1', dataDir)
			const row = storage2.sql.exec('SELECT v FROM persist').one()
			expect(row.v).toBe(123)
		})
	})

	describe('SqlStorage via DurableObjectNamespace', () => {
		class SqlDO extends DurableObjectBase {
			async createTable() {
				this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, val INTEGER)')
			}
			async setCounter(name: string, val: number) {
				this.ctx.storage.sql.exec('INSERT OR REPLACE INTO counters VALUES (?, ?)', name, val)
			}
			async getCounter(name: string): Promise<number | null> {
				const cursor = this.ctx.storage.sql.exec('SELECT val FROM counters WHERE name = ?', name)
				const rows = cursor.toArray()
				return rows.length > 0 ? (rows[0]!.val as number) : null
			}
		}

		test('DO can use sql storage through namespace', async () => {
			const ns = new DurableObjectNamespaceImpl(db, 'SqlDO', dataDir, { evictionTimeoutMs: 0 })
			ns._setClass(SqlDO, {})

			const stub = ns.get(ns.idFromName('test')) as unknown as SqlDO
			await stub.createTable()
			await stub.setCounter('visits', 42)
			expect(await stub.getCounter('visits')).toBe(42)
		})
	})
})

describe('DO Gaps - Issue #27', () => {
	describe('stub.fetch()', () => {
		class FetchDO extends DurableObjectBase {
			async fetch(request: Request): Promise<Response> {
				const url = new URL(request.url)
				if (url.pathname === '/echo') {
					const body = await request.text()
					return new Response(`Echo: ${body}`, { status: 200 })
				}
				return new Response('Not Found', { status: 404 })
			}
		}

		test('stub.fetch calls DO fetch handler with Request', async () => {
			const ns = new DurableObjectNamespaceImpl(db, 'FetchDO', undefined, { evictionTimeoutMs: 0 })
			ns._setClass(FetchDO, {})
			const stub = ns.get(ns.idFromName('test')) as unknown as { fetch(input: Request | string | URL, init?: RequestInit): Promise<Response> }

			const resp = await stub.fetch(new Request('http://fake-host/echo', { method: 'POST', body: 'hello' }))
			expect(resp.status).toBe(200)
			expect(await resp.text()).toBe('Echo: hello')
		})

		test('stub.fetch with string URL and init', async () => {
			const ns = new DurableObjectNamespaceImpl(db, 'FetchDO2', undefined, { evictionTimeoutMs: 0 })
			ns._setClass(FetchDO, {})
			const stub = ns.get(ns.idFromName('test')) as unknown as { fetch(input: Request | string | URL, init?: RequestInit): Promise<Response> }

			const resp = await stub.fetch('http://fake-host/echo', { method: 'POST', body: 'world' })
			expect(await resp.text()).toBe('Echo: world')
		})

		test('stub.fetch throws if DO has no fetch handler', async () => {
			class NoFetchDO extends DurableObjectBase {
				async hello() {
					return 'hi'
				}
			}
			const ns = new DurableObjectNamespaceImpl(db, 'NoFetchDO', undefined, { evictionTimeoutMs: 0 })
			ns._setClass(NoFetchDO, {})
			const stub = ns.get(ns.idFromName('test')) as unknown as { fetch(input: Request | string | URL): Promise<Response> }

			expect(stub.fetch('http://fake-host/')).rejects.toThrow('does not implement fetch')
		})

		test('stub.fetch returns 404 for unknown path', async () => {
			const ns = new DurableObjectNamespaceImpl(db, 'FetchDO3', undefined, { evictionTimeoutMs: 0 })
			ns._setClass(FetchDO, {})
			const stub = ns.get(ns.idFromName('test')) as unknown as { fetch(input: Request | string | URL): Promise<Response> }

			const resp = await stub.fetch('http://fake-host/unknown')
			expect(resp.status).toBe(404)
		})
	})

	describe('stub.id and stub.name', () => {
		class SimpleDO extends DurableObjectBase {
			async ping() {
				return 'pong'
			}
		}

		test('stub.id returns DurableObjectId', async () => {
			const ns = new DurableObjectNamespaceImpl(db, 'SimpleDO', undefined, { evictionTimeoutMs: 0 })
			ns._setClass(SimpleDO, {})
			const id = ns.idFromName('test')
			const stub = ns.get(id) as unknown as { id: DurableObjectIdImpl }
			expect(stub.id).toBe(id)
		})

		test('stub.name returns name from id', async () => {
			const ns = new DurableObjectNamespaceImpl(db, 'SimpleDO2', undefined, { evictionTimeoutMs: 0 })
			ns._setClass(SimpleDO, {})
			const id = ns.idFromName('myname')
			const stub = ns.get(id) as unknown as { name: string | undefined }
			expect(stub.name).toBe('myname')
		})

		test('stub.name is undefined for unique ids', async () => {
			const ns = new DurableObjectNamespaceImpl(db, 'SimpleDO3', undefined, { evictionTimeoutMs: 0 })
			ns._setClass(SimpleDO, {})
			const id = ns.newUniqueId()
			const stub = ns.get(id) as unknown as { name: string | undefined }
			expect(stub.name).toBeUndefined()
		})
	})

	describe('list({ startAfter })', () => {
		let storage: SqliteDurableObjectStorage

		beforeEach(() => {
			storage = new SqliteDurableObjectStorage(db, 'TestDO', 'inst-list')
		})

		test('startAfter excludes the given key', async () => {
			await storage.put({ a: 1, b: 2, c: 3, d: 4 })
			const result = await storage.list({ startAfter: 'b' })
			expect(result.size).toBe(2)
			expect(result.has('b')).toBe(false)
			expect(result.has('c')).toBe(true)
			expect(result.has('d')).toBe(true)
		})

		test('startAfter with limit', async () => {
			await storage.put({ a: 1, b: 2, c: 3, d: 4, e: 5 })
			const result = await storage.list({ startAfter: 'b', limit: 2 })
			expect(result.size).toBe(2)
			const keys = [...result.keys()]
			expect(keys).toEqual(['c', 'd'])
		})

		test('startAfter takes precedence over start', async () => {
			await storage.put({ a: 1, b: 2, c: 3 })
			// startAfter should be used, start should be ignored
			const result = await storage.list({ startAfter: 'a', start: 'a' })
			expect(result.has('a')).toBe(false)
			expect(result.has('b')).toBe(true)
		})
	})

	describe('sync()', () => {
		test('sync returns a resolved promise', async () => {
			const storage = new SqliteDurableObjectStorage(db, 'TestDO', 'inst-sync')
			await storage.sync() // should not throw
		})
	})

	describe('WebSocket validation', () => {
		test('rejects more than max tags per WebSocket', () => {
			const state = new DurableObjectStateImpl(
				new DurableObjectIdImpl('ws-val'),
				db,
				'WsVal',
				undefined,
				{ maxTagsPerWebSocket: 2 },
			)
			const ws = new MockWebSocket()
			expect(() => {
				state.acceptWebSocket(ws as unknown as WebSocket, ['a', 'b', 'c'])
			}).toThrow('Exceeded max tags')
		})

		test('rejects tag exceeding max length', () => {
			const state = new DurableObjectStateImpl(
				new DurableObjectIdImpl('ws-val2'),
				db,
				'WsVal2',
				undefined,
				{ maxTagLength: 5 },
			)
			const ws = new MockWebSocket()
			expect(() => {
				state.acceptWebSocket(ws as unknown as WebSocket, ['toolong'])
			}).toThrow('exceeds max length')
		})

		test('rejects when max concurrent WebSockets exceeded', () => {
			const state = new DurableObjectStateImpl(
				new DurableObjectIdImpl('ws-val3'),
				db,
				'WsVal3',
				undefined,
				{ maxConcurrentWebSockets: 1 },
			)
			const ws1 = new MockWebSocket()
			const ws2 = new MockWebSocket()
			state.acceptWebSocket(ws1 as unknown as WebSocket)
			expect(() => {
				state.acceptWebSocket(ws2 as unknown as WebSocket)
			}).toThrow('Exceeded max concurrent')
		})

		test('rejects auto-response request exceeding max length', () => {
			const state = new DurableObjectStateImpl(
				new DurableObjectIdImpl('ws-val4'),
				db,
				'WsVal4',
				undefined,
				{ maxAutoResponseLength: 5 },
			)
			expect(() => {
				state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('toolong', 'ok'))
			}).toThrow('request exceeds max length')
		})

		test('rejects auto-response response exceeding max length', () => {
			const state = new DurableObjectStateImpl(
				new DurableObjectIdImpl('ws-val5'),
				db,
				'WsVal5',
				undefined,
				{ maxAutoResponseLength: 5 },
			)
			expect(() => {
				state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ok', 'toolong'))
			}).toThrow('response exceeds max length')
		})
	})

	describe('Hibernation timeout', () => {
		test('setHibernatableWebSocketEventTimeout stores value', () => {
			const state = new DurableObjectStateImpl(
				new DurableObjectIdImpl('hib-test'),
				db,
				'HibDO',
			)
			state.setHibernatableWebSocketEventTimeout(5000)
			expect(state.getHibernatableWebSocketEventTimeout()).toBe(5000)
		})

		test('setHibernatableWebSocketEventTimeout clears with no arg', () => {
			const state = new DurableObjectStateImpl(
				new DurableObjectIdImpl('hib-test2'),
				db,
				'HibDO2',
			)
			state.setHibernatableWebSocketEventTimeout(5000)
			state.setHibernatableWebSocketEventTimeout()
			expect(state.getHibernatableWebSocketEventTimeout()).toBeNull()
		})
	})
})

describe('DO Instance Eviction', () => {
	class CounterDO extends DurableObjectBase {
		constructorCount = 0
		constructor(ctx: DurableObjectStateImpl, env: unknown) {
			super(ctx, env)
			this.constructorCount++
		}
		async getCount(): Promise<number> {
			return ((await this.ctx.storage.get<number>('count')) ?? 0)
		}
		async increment(): Promise<number> {
			const count = (await this.getCount()) + 1
			await this.ctx.storage.put('count', count)
			return count
		}
	}

	test('instance is evicted after inactivity', async () => {
		const ns = new DurableObjectNamespaceImpl(db, 'EvictDO1', undefined, { evictionTimeoutMs: 50 })
		ns._setClass(CounterDO, {})

		const id = ns.idFromName('test')
		const stub = ns.get(id) as any
		await stub.increment()
		const idStr = id.toString()

		expect(ns._getInstance(idStr)).not.toBeNull()

		// Manually trigger eviction after timeout
		await new Promise((r) => setTimeout(r, 80)) // Force eviction check (interval is 30s, so we call it manually for tests)
		;(ns as any)._evictIdle()

		expect(ns._getInstance(idStr)).toBeNull()
	})

	test('re-creation after eviction preserves storage', async () => {
		const ns = new DurableObjectNamespaceImpl(db, 'EvictDO2', undefined, { evictionTimeoutMs: 50 })
		ns._setClass(CounterDO, {})

		const id = ns.idFromName('test')
		const stub = ns.get(id) as any
		await stub.increment()
		await stub.increment()
		expect(await stub.getCount()).toBe(2)

		// Evict
		await new Promise((r) => setTimeout(r, 80))
		;(ns as any)._evictIdle()
		expect(ns._getInstance(id.toString())).toBeNull()

		// Access again — re-creates instance, storage persists
		expect(await stub.getCount()).toBe(2)
		expect(ns._getInstance(id.toString())).not.toBeNull()
	})

	test('stub remains valid after eviction', async () => {
		const ns = new DurableObjectNamespaceImpl(db, 'EvictDO3', undefined, { evictionTimeoutMs: 50 })
		ns._setClass(CounterDO, {})

		const id = ns.idFromName('test')
		const stub = ns.get(id) as any
		await stub.increment()

		// Evict
		await new Promise((r) => setTimeout(r, 80))
		;(ns as any)._evictIdle()

		// Stub still works — transparently re-creates
		expect(await stub.increment()).toBe(2)
	})

	test('alarm wakes evicted instance', async () => {
		let alarmFired = false

		class AlarmEvictDO extends DurableObjectBase {
			async alarm() {
				alarmFired = true
			}
		}

		const ns = new DurableObjectNamespaceImpl(db, 'AlarmEvictDO', undefined, { evictionTimeoutMs: 50 })
		ns._setClass(AlarmEvictDO, {})

		const id = ns.idFromName('test')
		ns.get(id)
		const instance = ns._getInstance(id.toString())!
		await instance.ctx.storage.setAlarm(Date.now() + 200)

		// Evict
		await new Promise((r) => setTimeout(r, 80))
		;(ns as any)._evictIdle()
		expect(ns._getInstance(id.toString())).toBeNull()

		// Wait for alarm
		await new Promise((r) => setTimeout(r, 200))

		expect(alarmFired).toBe(true)
		expect(ns._getInstance(id.toString())).not.toBeNull()
	})

	test('instance with active WebSockets is not evicted', async () => {
		class WsEvictDO extends DurableObjectBase {}

		const ns = new DurableObjectNamespaceImpl(db, 'WsEvictDO', undefined, { evictionTimeoutMs: 50 })
		ns._setClass(WsEvictDO, {})

		const id = ns.idFromName('test')
		ns.get(id)
		const instance = ns._getInstance(id.toString())!
		const ws = new MockWebSocket()
		instance.ctx.acceptWebSocket(ws as unknown as WebSocket)

		await new Promise((r) => setTimeout(r, 80))
		;(ns as any)._evictIdle()

		// Not evicted because of active WebSocket
		expect(ns._getInstance(id.toString())).not.toBeNull()
	})
})

describe('DO Request Serialization (E-order)', () => {
	test('concurrent calls are serialized', async () => {
		const order: number[] = []

		class SerialDO extends DurableObjectBase {
			async slow(id: number): Promise<void> {
				order.push(id)
				await new Promise((r) => setTimeout(r, 30))
				order.push(id * 10)
			}
		}

		const ns = new DurableObjectNamespaceImpl(db, 'SerialDO', undefined, { evictionTimeoutMs: 0 })
		ns._setClass(SerialDO, {})
		const stub = ns.get(ns.idFromName('test')) as any

		// Launch two concurrent calls
		const p1 = stub.slow(1)
		const p2 = stub.slow(2)
		await Promise.all([p1, p2])

		// Should be serialized: 1, 10, 2, 20 (not interleaved)
		expect(order).toEqual([1, 10, 2, 20])
	})

	test('blockConcurrencyWhile actually blocks concurrent calls', async () => {
		const order: string[] = []

		class BlockingDO extends DurableObjectBase {
			constructor(ctx: DurableObjectStateImpl, env: unknown) {
				super(ctx, env)
				ctx.blockConcurrencyWhile(async () => {
					await new Promise((r) => setTimeout(r, 50))
					order.push('init-done')
				})
			}
			async work(): Promise<void> {
				order.push('work')
			}
		}

		const ns = new DurableObjectNamespaceImpl(db, 'BlockingDO', undefined, { evictionTimeoutMs: 0 })
		ns._setClass(BlockingDO, {})

		const stub = ns.get(ns.idFromName('test')) as any
		const p1 = stub.work()
		const p2 = stub.work()
		await Promise.all([p1, p2])

		expect(order).toEqual(['init-done', 'work', 'work'])
	})
})

describe('DO RPC Semantics', () => {
	class RpcDO extends DurableObjectBase {
		myProp = 42
		async greet(name: string): Promise<string> {
			return `Hello, ${name}`
		}
	}

	test('NON_RPC_PROPS — stub.then is undefined (not thenable itself)', () => {
		const ns = new DurableObjectNamespaceImpl(db, 'RpcDO1', undefined, { evictionTimeoutMs: 0 })
		ns._setClass(RpcDO, {})
		const stub = ns.get(ns.idFromName('test')) as any
		expect(stub.then).toBeUndefined()
		expect(stub.catch).toBeUndefined()
		expect(stub.finally).toBeUndefined()
	})

	test('property access via thenable — await stub.myProp', async () => {
		const ns = new DurableObjectNamespaceImpl(db, 'RpcDO2', undefined, { evictionTimeoutMs: 0 })
		ns._setClass(RpcDO, {})
		const stub = ns.get(ns.idFromName('test')) as any
		const val = await stub.myProp
		expect(val).toBe(42)
	})

	test('method calls return Promise', async () => {
		const ns = new DurableObjectNamespaceImpl(db, 'RpcDO3', undefined, { evictionTimeoutMs: 0 })
		ns._setClass(RpcDO, {})
		const stub = ns.get(ns.idFromName('test')) as any
		const result = await stub.greet('World')
		expect(result).toBe('Hello, World')
	})

	test('same id returns same cached stub', () => {
		const ns = new DurableObjectNamespaceImpl(db, 'RpcDO4', undefined, { evictionTimeoutMs: 0 })
		ns._setClass(RpcDO, {})
		const id = ns.idFromName('test')
		const stub1 = ns.get(id)
		const stub2 = ns.get(id)
		expect(stub1).toBe(stub2)
	})
})

// --- Synchronous KV API ---

describe('SyncKV', () => {
	test('get returns undefined for missing key', () => {
		const storage = new SqliteDurableObjectStorage(db, 'NS', 'id1')
		expect(storage.kv.get('missing')).toBeUndefined()
	})

	test('put and get basic values', () => {
		const storage = new SqliteDurableObjectStorage(db, 'NS', 'id1')
		storage.kv.put('key1', 'hello')
		storage.kv.put('key2', 42)
		storage.kv.put('key3', { nested: true })

		expect(storage.kv.get('key1')).toBe('hello')
		expect(storage.kv.get('key2')).toBe(42)
		expect(storage.kv.get('key3')).toEqual({ nested: true })
	})

	test('put overwrites existing value', () => {
		const storage = new SqliteDurableObjectStorage(db, 'NS', 'id1')
		storage.kv.put('key', 'old')
		storage.kv.put('key', 'new')
		expect(storage.kv.get('key')).toBe('new')
	})

	test('delete returns true if key existed', () => {
		const storage = new SqliteDurableObjectStorage(db, 'NS', 'id1')
		storage.kv.put('key', 'val')
		expect(storage.kv.delete('key')).toBe(true)
		expect(storage.kv.get('key')).toBeUndefined()
	})

	test('delete returns false if key did not exist', () => {
		const storage = new SqliteDurableObjectStorage(db, 'NS', 'id1')
		expect(storage.kv.delete('nope')).toBe(false)
	})

	test('list returns all entries', () => {
		const storage = new SqliteDurableObjectStorage(db, 'NS', 'id1')
		storage.kv.put('a', 1)
		storage.kv.put('b', 2)
		storage.kv.put('c', 3)

		const entries = [...storage.kv.list()]
		expect(entries).toEqual([['a', 1], ['b', 2], ['c', 3]])
	})

	test('list with prefix', () => {
		const storage = new SqliteDurableObjectStorage(db, 'NS', 'id1')
		storage.kv.put('user:1', 'alice')
		storage.kv.put('user:2', 'bob')
		storage.kv.put('post:1', 'hello')

		const entries = [...storage.kv.list({ prefix: 'user:' })]
		expect(entries).toEqual([['user:1', 'alice'], ['user:2', 'bob']])
	})

	test('list with start and end', () => {
		const storage = new SqliteDurableObjectStorage(db, 'NS', 'id1')
		storage.kv.put('a', 1)
		storage.kv.put('b', 2)
		storage.kv.put('c', 3)
		storage.kv.put('d', 4)

		const entries = [...storage.kv.list({ start: 'b', end: 'd' })]
		expect(entries).toEqual([['b', 2], ['c', 3]])
	})

	test('list with startAfter', () => {
		const storage = new SqliteDurableObjectStorage(db, 'NS', 'id1')
		storage.kv.put('a', 1)
		storage.kv.put('b', 2)
		storage.kv.put('c', 3)

		const entries = [...storage.kv.list({ startAfter: 'a' })]
		expect(entries).toEqual([['b', 2], ['c', 3]])
	})

	test('list with reverse', () => {
		const storage = new SqliteDurableObjectStorage(db, 'NS', 'id1')
		storage.kv.put('a', 1)
		storage.kv.put('b', 2)
		storage.kv.put('c', 3)

		const entries = [...storage.kv.list({ reverse: true })]
		expect(entries).toEqual([['c', 3], ['b', 2], ['a', 1]])
	})

	test('list with limit', () => {
		const storage = new SqliteDurableObjectStorage(db, 'NS', 'id1')
		storage.kv.put('a', 1)
		storage.kv.put('b', 2)
		storage.kv.put('c', 3)

		const entries = [...storage.kv.list({ limit: 2 })]
		expect(entries).toEqual([['a', 1], ['b', 2]])
	})

	test('interop: sync kv.put readable by async get', async () => {
		const storage = new SqliteDurableObjectStorage(db, 'NS', 'id1')
		storage.kv.put('sync-key', 'sync-value')

		const value = await storage.get('sync-key')
		expect(value).toBe('sync-value')
	})

	test('interop: async put readable by sync kv.get', async () => {
		const storage = new SqliteDurableObjectStorage(db, 'NS', 'id1')
		await storage.put('async-key', 'async-value')

		const value = storage.kv.get('async-key')
		expect(value).toBe('async-value')
	})

	test('kv is accessible from DurableObjectStateImpl', () => {
		const id = new DurableObjectIdImpl('test-id', 'test')
		const state = new DurableObjectStateImpl(id, db, 'NS')
		state.storage.kv.put('from-state', 123)
		expect(state.storage.kv.get('from-state')).toBe(123)
	})
})

describe('transactionSync', () => {
	test('basic commit', () => {
		const storage = new SqliteDurableObjectStorage(db, 'NS', 'id1')
		storage.transactionSync(() => {
			storage.kv.put('key1', 'val1')
			storage.kv.put('key2', 'val2')
		})
		expect(storage.kv.get('key1')).toBe('val1')
		expect(storage.kv.get('key2')).toBe('val2')
	})

	test('rollback on exception', () => {
		const storage = new SqliteDurableObjectStorage(db, 'NS', 'id1')
		storage.kv.put('key', 'before')
		expect(() => {
			storage.transactionSync(() => {
				storage.kv.put('key', 'during')
				throw new Error('boom')
			})
		}).toThrow('boom')
		expect(storage.kv.get('key')).toBe('before')
	})

	test('return value propagation', () => {
		const storage = new SqliteDurableObjectStorage(db, 'NS', 'id1')
		const result = storage.transactionSync(() => {
			storage.kv.put('key', 42)
			return storage.kv.get('key')
		})
		expect(result).toBe(42)
	})

	test('nested reads and writes are atomic', () => {
		const storage = new SqliteDurableObjectStorage(db, 'NS', 'id1')
		storage.kv.put('counter', 0)
		storage.transactionSync(() => {
			const val = storage.kv.get('counter') as number
			storage.kv.put('counter', val + 1)
			const val2 = storage.kv.get('counter') as number
			storage.kv.put('counter', val2 + 1)
		})
		expect(storage.kv.get('counter')).toBe(2)
	})

	test('interop with storage.sql operations', () => {
		const tmpDir = mkdtempSync(join(tmpdir(), 'do-txnsync-'))
		const storage = new SqliteDurableObjectStorage(db, 'NS', 'id1', tmpDir)
		storage.sql.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, val TEXT)')
		storage.transactionSync(() => {
			storage.kv.put('key', 'kv-value')
		})
		// kv write committed
		expect(storage.kv.get('key')).toBe('kv-value')
	})
})

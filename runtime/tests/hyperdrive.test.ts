import { describe, expect, test } from 'bun:test'
import { HyperdriveBinding } from '../bindings/hyperdrive'

describe('HyperdriveBinding', () => {
	describe('connection string parsing', () => {
		test('standard postgres URL parses all properties', () => {
			const hd = new HyperdriveBinding('postgresql://user:pass@db.example.com:5432/mydb')
			expect(hd.connectionString).toBe('postgresql://user:pass@db.example.com:5432/mydb')
			expect(hd.host).toBe('db.example.com')
			expect(hd.port).toBe(5432)
			expect(hd.user).toBe('user')
			expect(hd.password).toBe('pass')
			expect(hd.database).toBe('mydb')
		})

		test('default port 5432 when omitted', () => {
			const hd = new HyperdriveBinding('postgresql://user:pass@db.example.com/mydb')
			expect(hd.port).toBe(5432)
		})

		test('non-standard port', () => {
			const hd = new HyperdriveBinding('postgresql://user:pass@localhost:6543/testdb')
			expect(hd.port).toBe(6543)
			expect(hd.host).toBe('localhost')
			expect(hd.database).toBe('testdb')
		})

		test('URL-encoded characters in user and password', () => {
			const hd = new HyperdriveBinding('postgresql://user%40name:p%40ss%3Aword@host.com/db')
			expect(hd.user).toBe('user@name')
			expect(hd.password).toBe('p@ss:word')
		})

		test('empty connection string returns empty properties', () => {
			const hd = new HyperdriveBinding('')
			expect(hd.connectionString).toBe('')
			expect(hd.host).toBe('')
			expect(hd.port).toBe(5432)
			expect(hd.user).toBe('')
			expect(hd.password).toBe('')
			expect(hd.database).toBe('')
		})

		test('database name with path segments', () => {
			const hd = new HyperdriveBinding('postgresql://u:p@host/my_database')
			expect(hd.database).toBe('my_database')
		})
	})

	describe('connect()', () => {
		test('returns object with correct shape', () => {
			const hd = new HyperdriveBinding('postgresql://user:pass@localhost:5432/db')
			const socket = hd.connect()
			expect(socket.readable).toBeInstanceOf(ReadableStream)
			expect(socket.writable).toBeInstanceOf(WritableStream)
			expect(socket.closed).toBeInstanceOf(Promise)
			expect(socket.opened).toBeInstanceOf(Promise)
			expect(typeof socket.close).toBe('function')
			// Clean up — close immediately so the test doesn't hang
			socket.close()
		})

		test('throws on empty connection string', () => {
			const hd = new HyperdriveBinding('')
			expect(() => hd.connect()).toThrow('no connection string configured')
		})
	})

	describe('startTls()', () => {
		test('throws not supported', () => {
			const hd = new HyperdriveBinding('postgresql://u:p@h/d')
			expect(() => hd.startTls()).toThrow('not supported in local dev')
		})
	})
})

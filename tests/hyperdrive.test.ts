import { describe, expect, test } from 'bun:test'
import { HyperdriveBinding } from '../src/bindings/hyperdrive'

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

		test.each([
			['postgres', 5432],
			['postgresql', 5432],
			['mysql', 3306],
		])('%s uses its database default and preserves explicit ports and URL text', (scheme, defaultPort) => {
			const connectionString = `${scheme}://user%40name:p%3Ass@db.example.com/my%20db?sslmode=require`
			const hd = new HyperdriveBinding(connectionString)
			expect(hd.port).toBe(defaultPort)
			expect(hd.connectionString).toBe(connectionString)
			expect(hd.user).toBe('user@name')
			expect(hd.password).toBe('p:ss')
			expect(hd.database).toBe('my db')
			const explicit = `${scheme}://u:p@localhost:6543/db?option=value`
			expect(new HyperdriveBinding(explicit).port).toBe(6543)
			expect(new HyperdriveBinding(explicit).connectionString).toBe(explicit)
		})

		test('malformed connection strings still fail URL validation', () => {
			expect(() => new HyperdriveBinding('not a URL')).toThrow()
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
		test('returns a socket connected to the explicit port', async () => {
			const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
			const hd = new HyperdriveBinding(`mysql://user:pass@127.0.0.1:${listener.port}/db`)
			const socket = hd.connect()
			try {
				expect(socket.readable).toBeInstanceOf(ReadableStream)
				expect(socket.writable).toBeInstanceOf(WritableStream)
				expect(socket.closed).toBeInstanceOf(Promise)
				expect(socket.opened).toBeInstanceOf(Promise)
				expect(typeof socket.close).toBe('function')
				expect(await socket.opened).toEqual({ remoteAddress: `127.0.0.1:${listener.port}` })
				socket.close()
				await socket.closed
			} finally {
				socket.close()
				listener.stop(true)
			}
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

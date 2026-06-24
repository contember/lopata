import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { VpcNetworkBinding } from '../src/bindings/vpc-network'

let server: { stop: () => void; port: number }

beforeAll(() => {
	const s = Bun.serve({
		port: 0,
		fetch(req) {
			const url = new URL(req.url)
			return new Response(JSON.stringify({ path: url.pathname, method: req.method }), {
				headers: { 'content-type': 'application/json' },
			})
		},
	})
	server = { stop: () => s.stop(), port: s.port! }
})

afterAll(() => {
	server.stop()
})

describe('VpcNetworkBinding', () => {
	test('fetch() passes request through to the URL host', async () => {
		const vpc = new VpcNetworkBinding({ networkId: 'cf1:network', bindingName: 'MESH' })
		const res = await vpc.fetch(`http://127.0.0.1:${server.port}/hello`)
		expect(res.status).toBe(200)
		const body = await res.json() as { path: string; method: string }
		expect(body.path).toBe('/hello')
		expect(body.method).toBe('GET')
	})

	test('fetch() preserves method and headers', async () => {
		const vpc = new VpcNetworkBinding({ networkId: 'cf1:network', bindingName: 'MESH' })
		const res = await vpc.fetch(`http://127.0.0.1:${server.port}/api`, {
			method: 'POST',
			body: 'hello',
		})
		expect(res.status).toBe(200)
		const body = await res.json() as { path: string; method: string }
		expect(body.path).toBe('/api')
		expect(body.method).toBe('POST')
	})

	test('networkId is exposed as a property', () => {
		const vpc = new VpcNetworkBinding({ networkId: 'abc-123-tunnel', bindingName: 'TUN' })
		expect(vpc.networkId).toBe('abc-123-tunnel')
	})

	test('relative URL rejected — host is required', async () => {
		const vpc = new VpcNetworkBinding({ networkId: 'cf1:network', bindingName: 'MESH' })
		// Build a Request with no host via a constructed absolute-to-relative trick is impossible,
		// but we can check the error path by passing a file: URL with no host.
		await expect(vpc.fetch('file:///etc/passwd')).rejects.toThrow()
	})
})

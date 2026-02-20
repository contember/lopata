/**
 * Worker that throws errors in various ways — for testing error propagation.
 */
export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url)

		if (url.pathname === '/ok') {
			return new Response('all good')
		}

		if (url.pathname === '/throw') {
			throw new Error('fetch handler exploded')
		}

		if (url.pathname === '/async-throw') {
			await scheduler.wait(5)
			throw new TypeError('async fetch handler exploded')
		}

		if (url.pathname === '/deep-throw') {
			return await levelOne()
		}

		return new Response('failing-worker: unknown path', { status: 404 })
	},

	/** RPC: throws synchronously */
	syncExplode(): string {
		throw new Error('sync RPC boom')
	},

	/** RPC: throws after an await */
	async asyncExplode(): Promise<string> {
		await scheduler.wait(5)
		throw new RangeError('async RPC boom')
	},

	/** RPC: error from a nested call chain */
	async deepExplode(): Promise<string> {
		return await rpcLevelOne()
	},

	/** RPC: succeeds (for comparison) */
	ping(): string {
		return 'pong from failing-worker'
	},
} satisfies ExportedHandler

// ── Deep call chains for stack trace testing ──

async function levelOne(): Promise<Response> {
	return await levelTwo()
}

async function levelTwo(): Promise<Response> {
	throw new Error('deep fetch error (level 2)')
}

async function rpcLevelOne(): Promise<string> {
	return await rpcLevelTwo()
}

async function rpcLevelTwo(): Promise<string> {
	throw new Error('deep RPC error (level 2)')
}

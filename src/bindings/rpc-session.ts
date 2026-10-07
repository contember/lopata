import type { RpcExecutionScope } from './rpc-stub'

export interface RpcLease {
	run<T>(callback: () => T): T
	dispose(): void
}

export interface RpcSession extends RpcExecutionScope {
	retain(): RpcLease
	finish(): void
	close(): void
	readonly closed: boolean
}

export interface RpcSessionOptions {
	run<T>(callback: () => T): T
	retain(): () => void
	isClosed?(): boolean
}

/** The initial share bridges handler return and acquisition of returned capabilities. */
export function createRpcSession(options: RpcSessionOptions): RpcSession {
	const release = options.retain()
	let references = 1
	let calls = 0
	let finished = false
	let closed = false

	function close(): void {
		if (closed) return
		closed = true
		release()
	}

	function checkOpen(): void {
		if (options.isClosed?.()) close()
		if (closed) throw new Error('RPC session is closed')
	}

	function drain(): void {
		if (references === 0 && calls === 0) close()
	}

	function run<T>(callback: () => T): T {
		checkOpen()
		calls++
		let pending = false
		try {
			const result = options.run(callback)
			if (result !== null && (typeof result === 'object' || typeof result === 'function') && 'then' in result && typeof result.then === 'function') {
				pending = true
				Promise.resolve(result).then(settle, settle)
			}
			return result
		} finally {
			if (!pending) settle()
		}
	}

	function settle(): void {
		calls--
		drain()
	}

	return {
		run,
		retain() {
			checkOpen()
			references++
			let disposed = false
			return {
				run(callback) {
					if (disposed) throw new Error('RPC stub is disposed')
					return run(callback)
				},
				dispose() {
					if (disposed) return
					disposed = true
					references--
					drain()
				},
			}
		},
		finish() {
			if (finished) return
			finished = true
			references--
			drain()
		},
		close,
		get closed() {
			if (options.isClosed?.()) close()
			return closed
		},
	}
}

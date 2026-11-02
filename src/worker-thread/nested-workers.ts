/**
 * Teardown of the dynamic workers (Worker Loader stubs) a worker thread spawned.
 *
 * Bun keeps a nested Worker running after its parent Worker is terminated, and the parent gets no
 * hook to run first. A thread that spawned a dynamic worker reports it, and main asks that thread
 * to dispose its stubs before terminating it. Threads that never spawned one are terminated at once.
 */

import { disposeWorkerStubs, onWorkerStubSpawn } from '../bindings/worker-loader'

/** Thread → main. */
export type NestedWorkersMessage = { type: 'nested-workers-spawned' } | { type: 'nested-workers-disposed' }

/** Main → thread. */
export interface DisposeNestedWorkersCommand {
	type: 'dispose-nested-workers'
}

/** How long main waits for a busy thread to dispose its dynamic workers before terminating it anyway. */
const DISPOSE_TIMEOUT_MS = 1000

/** Thread side: report the first spawned dynamic worker to main and dispose them all on request. */
export function serveNestedWorkerDisposal(scope: Worker, post: (message: NestedWorkersMessage) => void): void {
	onWorkerStubSpawn(() => post({ type: 'nested-workers-spawned' }))
	scope.addEventListener('message', (event: MessageEvent<{ type: string }>) => {
		if (event.data.type !== 'dispose-nested-workers') return
		disposeWorkerStubs()
		post({ type: 'nested-workers-disposed' })
	})
}

/** Main side: terminate `worker`, letting it dispose its dynamic workers first when it reported any. */
export function terminateWorkerThread(worker: Worker, hasNestedWorkers: boolean): void {
	if (!hasNestedWorkers) {
		worker.terminate()
		return
	}
	const timer = setTimeout(() => worker.terminate(), DISPOSE_TIMEOUT_MS)
	worker.addEventListener('message', (event: MessageEvent<{ type: string }>) => {
		if (event.data.type !== 'nested-workers-disposed') return
		clearTimeout(timer)
		worker.terminate()
	})
	try {
		worker.postMessage({ type: 'dispose-nested-workers' } satisfies DisposeNestedWorkersCommand)
	} catch {
		clearTimeout(timer)
		worker.terminate()
	}
}

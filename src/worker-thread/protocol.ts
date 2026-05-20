/**
 * Message protocol between main thread and worker-thread runtime.
 *
 * Main thread owns Bun.serve, file watcher, GenerationManager, dashboard.
 * Worker thread owns the user module graph + per-thread env. Reload =
 * terminate + respawn.
 */

export interface SerializedRequest {
	url: string
	method: string
	headers: [string, string][]
	body: ArrayBuffer | null
}

export interface SerializedResponse {
	status: number
	statusText: string
	headers: [string, string][]
	body: ArrayBuffer | null
}

export interface SerializedError {
	message: string
	stack?: string
	name?: string
}

export interface WorkerInitConfig {
	/** Absolute path to the user's worker entry. */
	modulePath: string
}

/** Main → worker */
export type WorkerCommand =
	| { type: 'init'; config: WorkerInitConfig }
	| { type: 'fetch'; id: number; request: SerializedRequest }

/** Worker → main */
export type WorkerMessage =
	| { type: 'need-init' }
	| { type: 'ready' }
	| { type: 'init-error'; error: SerializedError }
	| { type: 'fetch-result'; id: number; response: SerializedResponse }
	| { type: 'fetch-error'; id: number; error: SerializedError }

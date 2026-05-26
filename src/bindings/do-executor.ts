import type { Database } from 'bun:sqlite'
import type { ContainerConfig } from './container'
import type { DurableObjectBase, DurableObjectIdImpl, DurableObjectLimits } from './durable-object'

export interface ExecutorConfig {
	id: DurableObjectIdImpl
	db: Database
	namespaceName: string
	cls: new(ctx: any, env: unknown) => DurableObjectBase
	env: Record<string, unknown>
	dataDir?: string
	limits?: DurableObjectLimits
	containerConfig?: ContainerConfig
	onAlarmSet?: (time: number | null) => void
	/** @internal Worker-thread DO executors re-import the user module + config
	 *  inside their Bun Worker; the factory injects these paths. */
	_modulePath?: string
	_configPath?: string
}

export interface DOExecutor {
	/** Execute a fetch call on the DO instance */
	executeFetch(request: Request): Promise<Response>

	/** Execute an RPC method call */
	executeRpc(method: string, args: unknown[]): Promise<unknown>

	/** Execute an RPC property get */
	executeRpcGet(prop: string): Promise<unknown>

	/** Execute the alarm handler */
	executeAlarm(retryCount: number): Promise<void>

	/** Whether the instance has in-flight requests */
	isActive(): boolean

	/** Whether blockConcurrencyWhile is running */
	isBlocked(): boolean

	/** Count of accepted WebSockets */
	activeWebSocketCount(): number

	/** Whether the instance has been aborted */
	isAborted(): boolean

	/** Whether the underlying executor is dead (e.g. its Worker crashed). A
	 *  disposed executor is unusable — the namespace drops it and recreates a
	 *  fresh one on next access. Optional: executors that can't die report `false`. */
	isDisposed?(): boolean

	/** Hot-swap the DO class and env without disposing (preserves WebSocket connections) */
	reloadClass?(cls: new(ctx: any, env: unknown) => DurableObjectBase, env: unknown): void

	/** Kill the instance */
	dispose(): Promise<void>
}

export interface DOExecutorFactory {
	create(config: ExecutorConfig): DOExecutor
	/** Tell the factory where user code lives (only used by worker-thread DO executors). */
	configure?(modulePath: string, configPath: string): void
}

import type { Database } from 'bun:sqlite'
import type { ContainerConfig } from './container'
import type { DurableObjectBase, DurableObjectIdImpl, DurableObjectLimits } from './durable-object'

export interface ExecutorConfig {
	id: DurableObjectIdImpl
	db: Database
	namespaceName: string
	cls: new(ctx: any, env: unknown) => DurableObjectBase
	env: unknown
	dataDir?: string
	limits?: DurableObjectLimits
	containerConfig?: ContainerConfig
	onAlarmSet?: (time: number | null) => void
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

	/** Kill the instance */
	dispose(): Promise<void>
}

export interface DOExecutorFactory {
	create(config: ExecutorConfig): DOExecutor
}

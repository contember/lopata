import type { Database } from 'bun:sqlite'
import type { TestClock } from './clock'
import type { TestDurableObjectNamespace } from './durable-object'
import type { FetchMock } from './fetch-mock'
import type { TestWorkflowBinding } from './workflow'

export interface WorkerHandlers {
	fetch?(request: Request, env: Record<string, unknown>, ctx: unknown): Promise<Response> | Response
	queue?(batch: unknown, env: Record<string, unknown>, ctx: unknown): Promise<void> | void
	scheduled?(controller: unknown, env: Record<string, unknown>, ctx: unknown): Promise<void> | void
	email?(message: unknown, env: Record<string, unknown>, ctx: unknown): Promise<void> | void
	[key: string]: unknown
}

/** Worker module with a default export (class or object) plus named exports (DO/Workflow classes) */
export interface WorkerModule {
	default: (new(ctx: unknown, env: unknown) => Record<string, unknown>) | WorkerHandlers
	[key: string]: unknown
}

export interface TestEnvOptions {
	/** Worker: file path (string), inline handlers object, or module with default + named exports */
	worker?: string | WorkerHandlers | WorkerModule
	/** Binding declarations — keys become binding names in env */
	bindings?: Record<string, BindingSpec>
	/** Path to wrangler.toml/.json/.jsonc to load bindings from */
	wrangler?: string
	/** Plain string variables to add to env */
	vars?: Record<string, string>
	/** Enable test clock for time control. Pass true to create a new TestClock, or pass a TestClock instance. */
	clock?: boolean | TestClock
}

export type BindingSpec =
	| 'kv'
	| 'r2'
	| 'd1'
	| 'queue'
	| { type: 'durable-object'; className: string }
	| { type: 'workflow'; className: string }
	| { type: 'service'; service: string; entrypoint?: string }

export interface TestEnv<Env = Record<string, unknown>> {
	/** The built env object with all bindings */
	env: Env
	/** The shared in-memory database used by bindings */
	db: Database
	/** Dispatch a fetch request to the worker */
	fetch(input: string | Request, init?: RequestInit): Promise<Response>
	/** Dispatch a queue batch to the worker's queue handler */
	queue(queueName: string, messages: { body: unknown; contentType?: string }[]): Promise<void>
	/** Dispatch a scheduled event to the worker */
	scheduled(options?: { cron?: string; scheduledTime?: number }): Promise<void>
	/** Dispatch an email event to the worker */
	email(options: { from: string; to: string; raw: Uint8Array | string }): Promise<void>
	/** Get a test-friendly workflow binding wrapper */
	workflow(bindingName: string & keyof Env): TestWorkflowBinding
	/** Get a test-friendly durable object namespace wrapper */
	durableObject(bindingName: string & keyof Env): TestDurableObjectNamespace
	/** Test clock for time control (null if not enabled) */
	clock: TestClock | null
	/** Fetch mock for intercepting outgoing HTTP requests */
	fetchMock: FetchMock
	/** Advance time and fire ready DO alarms */
	advanceTime(ms: number): Promise<void>
	/** Cleanup: close DB, remove temp dirs, destroy DO namespaces */
	dispose(): void
}

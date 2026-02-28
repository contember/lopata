import type { BrowserBinding } from './bindings/browser'
import { ContainerBase, getContainer, getRandom } from './bindings/container'
import { DurableObjectBase, WebSocketRequestResponsePair } from './bindings/durable-object'
import { EmailMessage } from './bindings/email'
import type { ImageTransformOptions, OutputOptions } from './bindings/images'
import { WebSocketPair } from './bindings/websocket-pair'
import { NonRetryableError, WorkflowEntrypointBase } from './bindings/workflow'
import { globalEnv } from './env'
import { getActiveExecutionContext } from './execution-context'

/**
 * Registers virtual modules for `cloudflare:workers`, `cloudflare:workflows`,
 * `cloudflare:email`, `@cloudflare/containers`, and `@cloudflare/puppeteer`.
 *
 * Shared between `src/plugin.ts` (dev server) and `src/testing/setup.ts` (test preload).
 */
export function registerVirtualModules(build: { module: (name: string, fn: () => any) => void }) {
	build.module('cloudflare:workers', () => {
		return {
			exports: {
				DurableObject: DurableObjectBase,
				WorkflowEntrypoint: WorkflowEntrypointBase,
				WorkerEntrypoint: class WorkerEntrypoint {
					protected ctx: unknown
					protected env: unknown
					constructor(ctx: unknown, env: unknown) {
						this.ctx = ctx
						this.env = env
						;(this as any)[Symbol.for('lopata.RpcTarget')] = true
					}
				},
				WebSocketRequestResponsePair,
				WebSocketPair,
				RpcTarget: class RpcTarget {
					constructor() {
						;(this as any)[Symbol.for('lopata.RpcTarget')] = true
					}
				},
				env: globalEnv,
				waitUntil(promise: Promise<unknown>): void {
					const ctx = getActiveExecutionContext()
					if (ctx) {
						ctx.waitUntil(promise)
					}
				},
			},
			loader: 'object',
		}
	})

	build.module('@cloudflare/containers', () => {
		return {
			exports: {
				Container: ContainerBase,
				getContainer,
				getRandom,
				switchPort(request: Request, port: number): Request {
					const headers = new Headers(request.headers)
					headers.set('cf-container-target-port', port.toString())
					return new Request(request, { headers })
				},
				loadBalance: getRandom,
			},
			loader: 'object',
		}
	})

	build.module('cloudflare:email', () => {
		return {
			exports: {
				EmailMessage,
			},
			loader: 'object',
		}
	})

	build.module('cloudflare:workflows', () => {
		return {
			exports: {
				NonRetryableError,
			},
			loader: 'object',
		}
	})

	build.module('@cloudflare/puppeteer', () => {
		return {
			exports: {
				default: {
					launch: (endpoint: BrowserBinding, opts?: { keep_alive?: number }) => endpoint.launch(opts),
					connect: (endpoint: BrowserBinding, sessionId: string) => endpoint.connect(sessionId),
					sessions: (endpoint: BrowserBinding) => endpoint.sessions(),
				},
				ActiveSession: {} as any, // type-only re-export placeholder
			},
			loader: 'object',
		}
	})
}

import { createServerHotChannel, createServerModuleRunner, DevEnvironment, type Plugin } from 'vite'
import type { ModuleRunner } from 'vite/module-runner'

/**
 * Custom DevEnvironment that is NOT a RunnableDevEnvironment.
 *
 * This is critical for React Router integration: React Router's dev middleware
 * checks `isRunnableDevEnvironment(ssrEnvironment)` — if true, it tries to
 * handle SSR requests itself (loading virtual:react-router/server-build).
 * By extending DevEnvironment directly (not RunnableDevEnvironment), the
 * instanceof check returns false, React Router calls next(), and Bunflare's
 * middleware handles the request through the worker's fetch() handler.
 *
 * We still provide a `runner` getter for Bunflare's own middleware to import
 * modules through Vite's transform pipeline (JSX, HMR, etc.).
 */
class BunflareDevEnvironment extends DevEnvironment {
	private _runner: ModuleRunner | undefined

	get runner(): ModuleRunner {
		if (!this._runner) {
			this._runner = createServerModuleRunner(this)
		}
		return this._runner
	}

	override async close() {
		if (this._runner) {
			await this._runner.close()
		}
		await super.close()
	}
}

/**
 * Sets SSR environment resolve conditions for Cloudflare Workers compatibility.
 * Creates a BunflareDevEnvironment (non-runnable) so framework plugins (React Router)
 * delegate SSR handling to Bunflare's middleware.
 */
export function configPlugin(envName: string): Plugin {
	return {
		name: 'bunflare:config',
		config() {
			return {
				server: {
					watch: {
						ignored: ['**/.bunflare/**'],
					},
				},
				environments: {
					[envName]: {
						resolve: {
							externalConditions: ['workerd', 'worker'],
						},
						dev: {
							createEnvironment(name, config) {
								return new BunflareDevEnvironment(name, config, {
									hot: true,
									transport: createServerHotChannel(),
								})
							},
						},
					},
				},
			}
		},
	}
}

import { defineConfig } from 'vite'

export default defineConfig({
	server: { strictPort: true },
	plugins: [
		(await import('lopata/vite-plugin')).lopata({
			configPath: './wrangler.jsonc',
			// The workers of the CLI fixture: the main worker runs in-process under Vite, the auxiliary one in its own thread.
			auxiliaryWorkers: [{ configPath: '../cross-worker-do/mailbox/wrangler.jsonc' }],
		}),
	],
})

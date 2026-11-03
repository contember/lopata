import { defineConfig } from 'vite'

export default defineConfig({
	server: { strictPort: true },
	plugins: [
		(await import('lopata/vite-plugin')).lopata({
			configPath: './wrangler.jsonc',
			// The main worker runs in-process under Vite; the auxiliary one in its own thread.
			auxiliaryWorkers: [{ configPath: './aux/wrangler.jsonc' }],
		}),
	],
})

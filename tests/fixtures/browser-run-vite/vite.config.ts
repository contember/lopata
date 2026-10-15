import { defineConfig } from 'vite'

export default defineConfig({
	server: { strictPort: true },
	plugins: [
		(await import('lopata/vite-plugin')).lopata({
			configPath: './wrangler.jsonc',
			auxiliaryWorkers: [{ configPath: './aux/wrangler.jsonc' }],
			// The test starts Chrome and hands its HTTP DevTools endpoint over
			browser: { httpEndpoint: process.env.LOPATA_TEST_CHROME_URL },
		}),
	],
})

import { reactRouter } from '@react-router/dev/vite'
import { lopata } from 'lopata/vite-plugin'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [
		lopata({
			viteEnvironment: { name: 'ssr' },
			configPath: './wrangler.jsonc',
		}),
		reactRouter(),
	],
})

import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [
		(await import('lopata/vite-plugin')).lopata({ configPath: './wrangler.jsonc' }),
	],
})

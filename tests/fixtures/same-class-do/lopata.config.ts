import { defineConfig } from 'lopata'

export default defineConfig({
	main: './alpha/wrangler.jsonc',
	workers: [
		{ name: 'beta', config: './beta/wrangler.jsonc' },
	],
})

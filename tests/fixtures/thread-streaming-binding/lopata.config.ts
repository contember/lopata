import { defineConfig } from 'lopata'

export default defineConfig({
	main: './main/wrangler.jsonc',
	workers: [
		{ name: 'aux', config: './aux/wrangler.jsonc' },
	],
})

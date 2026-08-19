import { defineConfig } from 'lopata'

export default defineConfig({
	main: './api/wrangler.jsonc',
	workers: [
		// Two assets-only workers: no `main`, so no worker thread should be spawned.
		{ name: 'site', config: './site/wrangler.jsonc', hosts: ['site.localhost'] },
		{ name: 'spa', config: './spa/wrangler.jsonc', hosts: ['spa.localhost'] },
	],
})

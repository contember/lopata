import { defineConfig } from '../../src/lopata-config'

export default defineConfig({
	main: './wrangler.jsonc',
	workers: [
		{ name: 'echo-worker', config: './workers/echo/wrangler.jsonc', hosts: ['echo.localhost'] },
		{ name: 'failing-worker', config: './workers/failing/wrangler.jsonc', hosts: ['error.localhost'] },
	],
})

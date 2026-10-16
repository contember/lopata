import { defineConfig } from 'lopata'

export default defineConfig({
	main: './main/wrangler.jsonc',
	workers: [{ name: 'browser-aux', config: './aux/wrangler.jsonc' }],
	// The test starts Chrome and hands its HTTP DevTools endpoint over
	browser: { httpEndpoint: process.env.LOPATA_TEST_CHROME_URL },
})

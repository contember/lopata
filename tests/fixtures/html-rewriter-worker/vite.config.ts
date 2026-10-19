import { defineConfig } from 'vite'

export default defineConfig({
	// Fail loudly if the test port is taken — the default would relocate the server
	// to the next free port and leave the test polling an unrelated one.
	server: { strictPort: true },
	plugins: [
		(await import('lopata/vite-plugin')).lopata({ configPath: './wrangler.jsonc' }),
	],
})

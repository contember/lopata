import { reactRouter } from '@react-router/dev/vite'
import { defineConfig } from 'vite'

const useCf = process.env.CF === '1'

export default defineConfig({
	plugins: [
		useCf
			? (await import('@cloudflare/vite-plugin')).cloudflare({ viteEnvironment: { name: 'ssr' } })
			: (await import('lopata/vite-plugin')).lopata({ viteEnvironment: { name: 'ssr' }, configPath: './wrangler.jsonc' }),
		reactRouter(),
	],
})

import { defineConfig } from 'lopata'

export default defineConfig({
	main: './ledger/wrangler.jsonc',
	workers: [
		{ name: 'mailbox', config: './mailbox/wrangler.jsonc' },
	],
})

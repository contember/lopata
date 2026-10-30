import { GenerationManager } from '../../src/generation-manager'

const manager = new GenerationManager({
	name: 'ai-transport',
	main: `${import.meta.dir}/ai-transport-worker.ts`,
	ai: { binding: 'AI' },
	vars: { CLOUDFLARE_ACCOUNT_ID: 'fixture-account', CLOUDFLARE_API_TOKEN: 'fixture-secret' },
}, process.cwd())
await manager.reload()
const server = Bun.serve({
	port: 0,
	fetch(request) {
		const executor = manager.active?.threadExecutor
		if (!executor) throw new Error('No active AI worker')
		return executor.executeFetch(request)
	},
})
console.log(`READY ${server.port}`)

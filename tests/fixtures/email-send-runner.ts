import { GenerationManager } from '../../src/generation-manager'

const manager = new GenerationManager({
	name: 'email-send-runtime',
	main: `${import.meta.dir}/email-send-worker.ts`,
	send_email: [{ name: 'MAIL', allowed_destination_addresses: ['allowed@example.com', 'hidden@example.com'] }],
}, process.cwd())
await manager.reload()
const server = Bun.serve({
	port: 0,
	fetch(request) {
		const executor = manager.active?.threadExecutor
		if (!executor) throw new Error('No active worker')
		return executor.executeFetch(request)
	},
})
console.log(`READY ${server.port}`)

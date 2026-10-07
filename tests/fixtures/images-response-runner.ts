import { GenerationManager } from '../../src/generation-manager'

const manager = new GenerationManager({
	name: 'images-response',
	main: `${import.meta.dir}/images-response-worker.ts`,
	images: { binding: 'IMAGES' },
}, process.cwd())
await manager.reload()
const server = Bun.serve({
	port: 0,
	fetch(request) {
		const executor = manager.active?.threadExecutor
		if (!executor) throw new Error('No active image worker')
		return executor.executeFetch(request)
	},
})
console.log(`READY ${server.port}`)

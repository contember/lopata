import { createServer } from 'vite'
import { lopata } from '../../src/vite-plugin'

const flag = Bun.argv[2]
if (flag !== 'on' && flag !== 'off') throw new Error('Expected on/off flag argument')
await Bun.write(
	'wrangler.json',
	JSON.stringify({
		name: `crypto-vite-${flag}`,
		main: `${import.meta.dir}/crypto-modern-runtime-worker.ts`,
		compatibility_flags: flag === 'on' ? ['webcrypto_modern_algorithms'] : [],
	}),
)
const reservation = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 404 }) })
const port = reservation.port
await reservation.stop(true)
const server = await createServer({
	configFile: false,
	root: process.cwd(),
	server: { port, strictPort: true, fs: { allow: [process.cwd(), `${import.meta.dir}/../..`] } },
	plugins: lopata({ configPath: 'wrangler.json' }),
})
await server.listen()
const address = server.httpServer?.address()
if (!address || typeof address === 'string') throw new Error('Vite did not listen')
console.log(`READY ${address.port}`)

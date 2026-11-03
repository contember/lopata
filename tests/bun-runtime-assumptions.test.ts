import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Bun behaviour that the Worker Loader and the dynamic-workers design rely on. A Bun upgrade that
 * changes one of these fails here instead of silently changing module resolution or thread lifetime.
 * Each probe runs in its own `bun` process, so runtime plugins and the module cache stay isolated.
 */

const roots: string[] = []

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** Write `files` into a fresh directory, run `probe.ts` there and return the JSON it prints last. */
function probe(files: Record<string, string>): unknown {
	const root = mkdtempSync(join(tmpdir(), 'lopata-bun-probe-'))
	roots.push(root)
	for (const [name, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, name)), { recursive: true })
		writeFileSync(join(root, name), content)
	}
	const result = Bun.spawnSync([process.execPath, 'probe.ts'], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
	if (result.exitCode !== 0) throw new Error(`probe failed (${result.exitCode}): ${result.stderr.toString()}`)
	const last = result.stdout.toString().trim().split('\n').at(-1)
	if (last === undefined) throw new Error('probe printed nothing')
	return JSON.parse(last)
}

/** Report whether `import(specifier)` from `probe.ts` succeeds, with the error message otherwise. */
const IMPORT_OUTCOME = `
async function outcome(specifier: string) {
	try {
		const mod = await import(specifier)
		return { ok: true, value: mod.default ?? null }
	} catch (e) {
		return { ok: false, error: e instanceof Error ? e.message : String(e) }
	}
}
`

describe('Bun runtime assumptions', () => {
	test('terminating a Worker also terminates the Workers it spawned', () => {
		const result = probe({
			'child.ts': `
				import { appendFileSync } from 'node:fs'
				setInterval(() => appendFileSync(import.meta.dir + '/ticks', 'x'), 10)
				postMessage('up')
			`,
			'parent.ts': `
				const child = new Worker(new URL('./child.ts', import.meta.url).href)
				child.onmessage = () => postMessage('up')
			`,
			'probe.ts': `
				import { existsSync, readFileSync } from 'node:fs'
				const ticks = () => existsSync(import.meta.dir + '/ticks') ? readFileSync(import.meta.dir + '/ticks', 'utf8').length : 0
				const parent = new Worker(new URL('./parent.ts', import.meta.url).href)
				await new Promise(resolve => { parent.onmessage = resolve })
				await Bun.sleep(50)
				parent.terminate()
				await Bun.sleep(100)
				const before = ticks()
				await Bun.sleep(200)
				console.log(JSON.stringify({ started: before > 0, childStillRunning: ticks() > before }))
				process.exit(0)
			`,
		})
		expect(result).toEqual({ started: true, childStillRunning: false })
	})

	test('runtime plugins are per thread: a module registered in the parent is missing in a Worker', () => {
		const result = probe({
			'worker.ts': `
				try {
					await import('lopata-probe:virtual')
					postMessage({ ok: true })
				} catch (e) {
					postMessage({ ok: false, error: e instanceof Error ? e.message : String(e) })
				}
			`,
			'probe.ts': `
				Bun.plugin({ name: 'probe', setup(build) { build.module('lopata-probe:virtual', () => ({ exports: { default: 1 }, loader: 'object' })) } })
				const inMain = (await import('lopata-probe:virtual')).default
				const worker = new Worker(new URL('./worker.ts', import.meta.url).href)
				const inWorker = await new Promise(resolve => { worker.onmessage = event => resolve(event.data) })
				worker.terminate()
				console.log(JSON.stringify({ inMain, inWorker }))
			`,
		})
		expect(result).toMatchObject({ inMain: 1, inWorker: { ok: false } })
	})

	test('a bare specifier does not resolve to a file next to the importer', () => {
		const result = probe({
			'some-bare-name': `export default 'sibling'`,
			'probe.ts': `${IMPORT_OUTCOME}
				console.log(JSON.stringify(await outcome('some-bare-name')))
			`,
		})
		expect(result).toMatchObject({ ok: false, error: expect.stringContaining('Cannot find package') })
	})

	test('a runtime onResolve hook is invoked for relative specifiers but not for bare ones', () => {
		const result = probe({
			'mods/main.js': `import rel from './rel.js'\nimport bare from 'bare-probe'\nexport default rel + bare`,
			'mods/rel.js': `export default 'rel+'`,
			'mods/node_modules/bare-probe/index.js': `export default 'bare'`,
			'probe.ts': `
				const seen: string[] = []
				Bun.plugin({ name: 'probe', setup(build) { build.onResolve({ filter: /.*/ }, args => { seen.push(args.path); return undefined }) } })
				const value = (await import('./mods/main.js')).default
				console.log(JSON.stringify({ value, sawRelative: seen.includes('./rel.js'), sawBare: seen.includes('bare-probe') }))
			`,
		})
		expect(result).toEqual({ value: 'rel+bare', sawRelative: true, sawBare: false })
	})

	test('a node_modules symlink to an extensionless module loads it as JavaScript, sharing one instance with its relative path', () => {
		const root = mkdtempSync(join(tmpdir(), 'lopata-bun-probe-'))
		roots.push(root)
		writeFileSync(join(root, 'some-bare-name'), `export const instance = {}\nexport default 'extensionless'`)
		writeFileSync(
			join(root, 'main.js'),
			`import bare, { instance as a } from 'some-bare-name'\nimport { instance as b } from './some-bare-name'\nexport default { bare, same: a === b }`,
		)
		mkdirSync(join(root, 'node_modules'))
		symlinkSync(join(root, 'some-bare-name'), join(root, 'node_modules', 'some-bare-name'))
		writeFileSync(join(root, 'probe.ts'), `console.log(JSON.stringify((await import('./main.js')).default))`)
		const result = Bun.spawnSync([process.execPath, 'probe.ts'], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
		expect(result.stderr.toString()).toBe('')
		expect(JSON.parse(result.stdout.toString())).toEqual({ bare: 'extensionless', same: true })
	})

	test('a runtime onLoad hook filtered on a directory runs for files with an extension but not for extensionless ones', () => {
		const result = probe({
			'stub/main.js': `import a from './with-ext.txt'\nimport b from './no-ext'\nexport default [a, b]`,
			'stub/with-ext.txt': `export default 'with-ext'`,
			'stub/no-ext': `export default 'no-ext'`,
			'probe.ts': `
				const loaded: string[] = []
				const dir = import.meta.dir + '/stub/'
				const escaped = dir.replace(/[.*+?^\${}()|[\\]\\\\]/g, '\\\\$&')
				Bun.plugin({ name: 'probe', setup(build) {
					build.onLoad({ filter: new RegExp('^' + escaped) }, async args => {
						loaded.push(args.path.slice(dir.length))
						return { contents: await Bun.file(args.path).text(), loader: 'js' }
					})
				} })
				const value = (await import('./stub/main.js')).default
				console.log(JSON.stringify({ value, loaded: loaded.sort() }))
			`,
		})
		expect(result).toEqual({ value: ['with-ext', 'no-ext'], loaded: ['main.js', 'with-ext.txt'] })
	})

	test('a MessagePort pair handed to two Workers carries messages directly, keeping Map and ArrayBuffer', () => {
		const result = probe({
			'sender.ts': `
				onmessage = event => {
					const port: MessagePort = event.data.port
					port.postMessage({ map: new Map([['k', 1]]), bytes: new Uint8Array([1, 2, 3]).buffer })
				}
			`,
			'receiver.ts': `
				onmessage = event => {
					const port: MessagePort = event.data.port
					port.onmessage = message => {
						const { map, bytes } = message.data
						postMessage({ isMap: map instanceof Map, value: map.get('k'), isBuffer: bytes instanceof ArrayBuffer, bytes: [...new Uint8Array(bytes)] })
					}
				}
			`,
			'probe.ts': `
				const sender = new Worker(new URL('./sender.ts', import.meta.url).href)
				const receiver = new Worker(new URL('./receiver.ts', import.meta.url).href)
				const channel = new MessageChannel()
				const received = new Promise(resolve => { receiver.onmessage = event => resolve(event.data) })
				receiver.postMessage({ port: channel.port2 }, [channel.port2])
				sender.postMessage({ port: channel.port1 }, [channel.port1])
				console.log(JSON.stringify(await received))
				process.exit(0)
			`,
		})
		expect(result).toEqual({ isMap: true, value: 1, isBuffer: true, bytes: [1, 2, 3] })
	})

	test('structuredClone() copies a compiled WebAssembly.Module', () => {
		// The smallest valid module: magic number and version.
		const module = new WebAssembly.Module(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]))
		expect(structuredClone(module)).toBeInstanceOf(WebAssembly.Module)
	})

	test('Bun.Transpiler#scanImports reports static imports, re-exports, literal import() and require()', () => {
		const source = `
			import a from './a.js'
			export { b } from 'pkg-b'
			const c = await import('./c.js')
			const d = require('pkg-d')
			const e = await import(computed)
		`
		const imports = new Bun.Transpiler({ loader: 'js' }).scanImports(source)
		expect(imports.map(entry => entry.path).sort()).toEqual(['./a.js', './c.js', 'pkg-b', 'pkg-d'])
	})
})

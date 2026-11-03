import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type WorkerCode, WorkerLoaderBinding, type WorkerStub } from '../src/bindings/worker-loader'
import { removeOrphanedLoaderDirs } from '../src/bindings/worker-loader-dirs'

let tmpDir: string
let loaderDir: string
const stubs: WorkerStub[] = []

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), 'lopata-loader-fs-'))
	loaderDir = join(tmpDir, 'loader')
})

afterEach(() => {
	for (const stub of stubs.splice(0)) stub.dispose()
	rmSync(tmpDir, { recursive: true, force: true })
})

function track(stub: WorkerStub): WorkerStub {
	stubs.push(stub)
	return stub
}

function code(modules: WorkerCode['modules'], mainModule = 'main.js'): WorkerCode {
	return { compatibilityDate: '2026-03-01', mainModule, modules }
}

const HELLO = `export default { fetch() { return new Response('hello') } }`

/** A main module that appends to `file` every 10 ms from the moment it is imported. */
function tickerModule(file: string, rest = HELLO): string {
	return `import { appendFileSync } from 'node:fs'\nsetInterval(() => appendFileSync(${JSON.stringify(file)}, 'x'), 10)\n${rest}`
}

function ticks(file: string): number {
	return existsSync(file) ? readFileSync(file, 'utf8').length : 0
}

async function expectNoTicks(file: string): Promise<void> {
	await Bun.sleep(100)
	const before = ticks(file)
	await Bun.sleep(200)
	expect(ticks(file)).toBe(before)
}

/** Wait until the dynamic worker writes `file`: it does so right before it blocks. */
async function untilWritten(file: string): Promise<void> {
	const deadline = Date.now() + 5000
	while (!existsSync(file)) {
		if (Date.now() > deadline) throw new Error(`${file} was never written`)
		await Bun.sleep(10)
	}
}

/** Write `file` and then never finish: a main module stuck in init, or a handler stuck in a call. */
function blockAfterWriting(file: string): string {
	return `(await import('node:fs')).writeFileSync(${JSON.stringify(file)}, '1'); await new Promise(() => {})`
}

function outcome(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(value => value, (error: unknown) => error)
}

describe('Worker Loader stub directories', () => {
	test('a get() id is only a cache key and never becomes a path', async () => {
		const loader = new WorkerLoaderBinding(loaderDir)
		const stub = track(loader.get('../outside', () => code({ 'main.js': HELLO })))
		expect(await (await stub.getEntrypoint().fetch('http://loader/')).text()).toBe('hello')
		expect(existsSync(join(tmpDir, 'outside'))).toBe(false)
		expect(readdirSync(loaderDir)).toHaveLength(1)
	})

	test('two bindings caching the same id keep separate directories, and disposing one leaves the other intact', async () => {
		const lazyMain = `export default { async fetch(req) {
			if (new URL(req.url).pathname === '/lazy') return new Response((await import('./lazy.js')).value)
			return new Response('ready')
		} }`
		const first = new WorkerLoaderBinding(loaderDir)
		const second = new WorkerLoaderBinding(loaderDir)
		const a = track(first.get('same', () => code({ 'main.js': lazyMain, 'lazy.js': `export const value = 'a'` })))
		const b = track(second.get('same', () => code({ 'main.js': lazyMain, 'lazy.js': `export const value = 'b'` })))
		expect(await (await a.getEntrypoint().fetch('http://loader/')).text()).toBe('ready')
		expect(await (await b.getEntrypoint().fetch('http://loader/')).text()).toBe('ready')

		a.dispose()

		expect(await (await b.getEntrypoint().fetch('http://loader/lazy')).text()).toBe('b')
		expect(readdirSync(loaderDir)).toHaveLength(1)
	})
})

describe('Worker Loader module names', () => {
	const invalidNames = ['../evil.js', 'a/../../evil.js', '/abs/evil.js', 'evil.js/', 'a//b.js', './evil.js', 'a\\..\\evil.js', 'nul\0.js', '']

	for (const name of invalidNames) {
		test(`load() rejects ${JSON.stringify(name)}`, () => {
			const loader = new WorkerLoaderBinding(loaderDir)
			expect(() => loader.load(code({ 'main.js': HELLO, [name]: 'export {}' }))).toThrow(TypeError)
		})
	}

	test('load() rejects a mainModule that escapes the stub directory', () => {
		const loader = new WorkerLoaderBinding(loaderDir)
		expect(() => loader.load(code({ '../main.js': HELLO }, '../main.js'))).toThrow(TypeError)
	})

	test('get() rejects an escaping name from its code callback before writing anything', async () => {
		const loader = new WorkerLoaderBinding(loaderDir)
		const stub = track(loader.get('x', () => code({ 'main.js': HELLO, '../../escaped.js': 'export {}' })))
		expect(await outcome(stub.getEntrypoint().fetch('http://loader/'))).toBeInstanceOf(TypeError)
		expect(existsSync(join(tmpDir, 'escaped.js'))).toBe(false)
		expect(readdirSync(loaderDir)).toEqual([])
	})

	test('module names are read once, so a modules map whose keys change after validation cannot write outside the stub', async () => {
		const loader = new WorkerLoaderBinding(loaderDir)
		let reads = 0
		const modules = new Proxy<Record<string, string>>({ 'main.js': HELLO, '../../escaped.js': 'export {}' }, {
			ownKeys(target) {
				reads++
				return reads <= 2 ? ['main.js'] : Reflect.ownKeys(target)
			},
		})
		const stub = track(loader.get('changing', () => code(modules)))
		await outcome(stub.getEntrypoint().fetch('http://loader/'))
		expect(existsSync(join(tmpDir, 'escaped.js'))).toBe(false)
	})

	test('load() rejects a mainModule that is only an inherited property of the modules map', () => {
		const loader = new WorkerLoaderBinding(loaderDir)
		expect(() => loader.load(code({ 'main.js': HELLO }, 'toString'))).toThrow(/not present in modules map/)
	})
})

describe('Worker Loader cleanup', () => {
	test('a failed module write removes the partially written directory', async () => {
		const loader = new WorkerLoaderBinding(loaderDir)
		// `lib` is written as a file, so `lib/x.js` cannot be created below it.
		const stub = track(loader.load(code({ 'main.js': HELLO, 'lib': { js: 'export {}' }, 'lib/x.js': 'export {}' })))
		expect(await outcome(stub.getEntrypoint().fetch('http://loader/'))).toBeInstanceOf(Error)
		expect(readdirSync(loaderDir)).toEqual([])
	})

	test('a failed init terminates the thread and removes the directory', async () => {
		const loader = new WorkerLoaderBinding(loaderDir)
		const tickFile = join(tmpDir, 'ticks')
		const stub = track(loader.load(code({ 'main.js': tickerModule(tickFile, `throw new Error('init boom')`) })))
		expect(await outcome(stub.getEntrypoint().fetch('http://loader/'))).toBeInstanceOf(Error)
		await expectNoTicks(tickFile)
		expect(readdirSync(loaderDir)).toEqual([])
	})

	test('disposing a stub during its init rejects the waiting request', async () => {
		const loader = new WorkerLoaderBinding(loaderDir)
		const marker = join(tmpDir, 'in-init')
		const stub = track(loader.load(code({ 'main.js': `${blockAfterWriting(marker)}\n${HELLO}` })))
		const request = outcome(stub.getEntrypoint().fetch('http://loader/'))
		await untilWritten(marker)
		stub.dispose()
		const result = await Promise.race([request, Bun.sleep(2000).then(() => 'still pending')])
		expect(String(result)).toContain('WorkerStub has been disposed')
		expect(readdirSync(loaderDir)).toEqual([])
	})

	test('disposing a stub rejects its in-flight calls', async () => {
		const loader = new WorkerLoaderBinding(loaderDir)
		const marker = join(tmpDir, 'in-call')
		const stub = track(loader.load(code({ 'main.js': `export default { async fetch() { ${blockAfterWriting(marker)} } }` })))
		const request = outcome(stub.getEntrypoint().fetch('http://loader/'))
		await untilWritten(marker)
		stub.dispose()
		const result = await Promise.race([request, Bun.sleep(2000).then(() => 'still pending')])
		expect(String(result)).toContain('WorkerStub has been disposed')
	})

	test('disposing a stub rejects a fetch whose request body is still streaming, and cancels the body', async () => {
		const loader = new WorkerLoaderBinding(loaderDir)
		const stub = track(loader.load(code({ 'main.js': HELLO })))
		const pulled = Promise.withResolvers<void>()
		const cancelled = Promise.withResolvers<unknown>()
		const body = new ReadableStream<Uint8Array>({
			pull() {
				pulled.resolve()
				return new Promise(() => {})
			},
			cancel(reason) {
				cancelled.resolve(reason)
			},
		})
		const request = outcome(stub.getEntrypoint().fetch('http://loader/', { method: 'POST', body, duplex: 'half' }))
		await pulled.promise
		stub.dispose()
		const result = await Promise.race([request, Bun.sleep(2000).then(() => 'still pending')])
		expect(result).toBeInstanceOf(Error)
		expect(String(result)).toContain('WorkerStub has been disposed')
		expect(String(await cancelled.promise)).toContain('WorkerStub has been disposed')
	})

	test('disposing a stub while its code callback is pending spawns nothing', async () => {
		const loader = new WorkerLoaderBinding(loaderDir)
		const tickFile = join(tmpDir, 'ticks')
		const gate = Promise.withResolvers<void>()
		const stub = track(loader.get('pending', async () => {
			await gate.promise
			return code({ 'main.js': tickerModule(tickFile) })
		}))
		const request = outcome(stub.getEntrypoint().fetch('http://loader/'))
		stub.dispose()
		gate.resolve()
		expect(await request).toBeInstanceOf(Error)
		await expectNoTicks(tickFile)
		expect(ticks(tickFile)).toBe(0)
		expect(readdirSync(loaderDir)).toEqual([])
	})
})

describe('Worker Loader owner directories', () => {
	test('startup removes the directories of dead processes and keeps those of live ones', () => {
		const exited = Bun.spawnSync(['true'])
		const root = join(tmpDir, 'worker-loader')
		const dead = join(root, `${exited.pid}-owner`)
		const live = join(root, `${process.pid}-owner`)
		const unrelated = join(root, 'not-an-owner')
		for (const dir of [dead, live, unrelated]) mkdirSync(join(dir, 'stub'), { recursive: true })
		removeOrphanedLoaderDirs(tmpDir)
		expect(readdirSync(root).sort()).toEqual([`${process.pid}-owner`, 'not-an-owner'])
	})
})

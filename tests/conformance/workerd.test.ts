// Runs the vendored workerd API tests (./workerd, see README.md) inside `lopata dev`.
// Each module becomes its own worker in a generated multi-worker project, reachable through a
// host route; `workerd-runner.ts` invokes the module's `test` exports on request.

import type { Subprocess } from 'bun'
import { afterAll, describe } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { conformanceTest, loadKnownFailures } from './harness'
import { type WorkerdModule, workerdModules } from './workerd-manifest'
import type { RunResult } from './workerd-runner'

const VENDOR_DIR = resolve(import.meta.dir, 'workerd')
const RUNNER = resolve(import.meta.dir, 'workerd-runner.ts')
const CLI = resolve(import.meta.dir, '../../src/cli.ts')
const COMPATIBILITY_DATE = '2026-03-01'
const TEST_TIMEOUT_MS = 5_000
const STARTUP_TIMEOUT_MS = 90_000
const MODULE_CONCURRENCY = 8
// CONFORMANCE_ONLY=streams-test,url-test runs a subset while iterating on a fix.
const ONLY = process.env.CONFORMANCE_ONLY?.split(',').filter(Boolean)
const selectedModules = Object.entries(workerdModules).filter(([module]) => !ONLY || ONLY.includes(module))

function hostFor(module: string): string {
	return `${module}.conformance.localhost`
}

function wranglerConfig(module: string, spec: WorkerdModule): object {
	return {
		name: module,
		main: './entry.js',
		compatibility_date: COMPATIBILITY_DATE,
		compatibility_flags: spec.flags,
		services: (spec.selfServices ?? []).map(s => ({ binding: s.binding, service: module, entrypoint: s.entrypoint })),
		durable_objects: { bindings: (spec.durableObjects ?? []).map(d => ({ name: d.binding, class_name: d.className })) },
		migrations: spec.durableObjects ? [{ tag: 'v1', new_sqlite_classes: spec.durableObjects.map(d => d.className) }] : [],
	}
}

function generateProject(root: string): void {
	const workers: Array<{ name: string; config: string; hosts: string[] }> = []
	for (const [module, spec] of selectedModules) {
		const dir = join(root, module)
		mkdirSync(dir)
		const source = JSON.stringify(join(VENDOR_DIR, `${module}.js`))
		writeFileSync(
			join(dir, 'entry.js'),
			[
				`import * as mod from ${source}`,
				`import { wrapDefault } from ${JSON.stringify(RUNNER)}`,
				`export * from ${source}`,
				'export default wrapDefault(mod)',
				'',
			].join('\n'),
		)
		writeFileSync(join(dir, 'wrangler.json'), JSON.stringify(wranglerConfig(module, spec), null, '\t'))
		workers.push({ name: module, config: `./${module}/wrangler.json`, hosts: [hostFor(module)] })
	}
	const mainDir = join(root, '__main')
	mkdirSync(mainDir)
	writeFileSync(join(mainDir, 'entry.js'), "export default { fetch() { return new Response('conformance') } }\n")
	writeFileSync(join(mainDir, 'wrangler.json'), JSON.stringify({ name: '__main', main: './entry.js', compatibility_date: COMPATIBILITY_DATE }))
	writeFileSync(join(root, 'lopata.config.ts'), `export default ${JSON.stringify({ main: './__main/wrangler.json', workers }, null, '\t')}\n`)
}

function freePort(): number {
	const server = Bun.serve({ port: 0, fetch: () => new Response() })
	const port = server.port
	server.stop(true)
	if (port === undefined) throw new Error('could not allocate a port')
	return port
}

function logTail(root: string): string {
	return ['lopata.out.log', 'lopata.err.log']
		.map(name => {
			let text = ''
			try {
				text = readFileSync(join(root, name), 'utf8')
			} catch {}
			return `--- ${name} ---\n${text.slice(-4_000)}`
		})
		.join('\n')
}

async function waitForServer(base: string, server: Subprocess, root: string): Promise<void> {
	const deadline = Date.now() + STARTUP_TIMEOUT_MS
	while (Date.now() < deadline) {
		if (server.exitCode !== null) throw new Error(`lopata dev exited with code ${server.exitCode}\n${logTail(root)}`)
		try {
			const res = await fetch(base)
			if (res.ok) return
		} catch {}
		await Bun.sleep(250)
	}
	throw new Error(`lopata dev did not start within ${STARTUP_TIMEOUT_MS} ms\n${logTail(root)}`)
}

/**
 * Case names of a module that failed to load: its exports except classes and `default`, which cannot be told apart from
 * handler objects without running the module. A module left with none reports a single `(load)` case, so it is still counted.
 */
function staticTestNames(module: string): string[] {
	const source = readFileSync(join(VENDOR_DIR, `${module}.js`), 'utf8')
	const classes = new Set([...source.matchAll(/^export\s+class\s+(\w+)/gm)].map(m => m[1]))
	const names = new Bun.Transpiler({ loader: 'js' }).scan(source).exports.filter(name => name !== 'default' && !classes.has(name))
	return names.length ? names : ['(load)']
}

function parseNames(raw: unknown): string[] | null {
	if (!Array.isArray(raw) || !raw.every(name => typeof name === 'string')) return null
	return raw
}

function parseRunResult(raw: unknown): RunResult {
	if (typeof raw !== 'object' || raw === null || !('ok' in raw) || typeof raw.ok !== 'boolean') {
		throw new Error(`unexpected runner response: ${JSON.stringify(raw)}`)
	}
	return { ok: raw.ok, error: 'error' in raw && typeof raw.error === 'string' ? raw.error : undefined }
}

const root = mkdtempSync(join(tmpdir(), 'lopata-conformance-'))
generateProject(root)
const port = freePort()
const base = `http://127.0.0.1:${port}`
// CONFORMANCE_KEEP=1 keeps the generated project and the lopata logs for debugging.
// Bind the address the harness polls; `localhost` may resolve to ::1 only.
const server = Bun.spawn(['bun', CLI, 'dev', '--port', String(port), '--listen', '127.0.0.1'], {
	cwd: root,
	stdout: Bun.file(join(root, 'lopata.out.log')),
	stderr: Bun.file(join(root, 'lopata.err.log')),
})

async function shutdown(): Promise<void> {
	server.kill()
	await server.exited
	if (process.env.CONFORMANCE_KEEP === '1') console.log(`conformance project kept in ${root}`)
	else rmSync(root, { recursive: true, force: true })
}

// afterAll does not run when the module's top-level await throws, so a failed startup cleans up itself.
process.on('exit', () => server.kill())
afterAll(shutdown)
try {
	await waitForServer(base, server, root)
} catch (err) {
	await shutdown()
	throw err
}

async function callModule(module: string, path: string): Promise<Response> {
	return fetch(`${base}${path}`, { headers: { host: hostFor(module) }, signal: AbortSignal.timeout(TEST_TIMEOUT_MS) })
}

async function listTests(module: string): Promise<{ names: string[]; loadError?: string }> {
	try {
		const res = await callModule(module, '/__conformance/list')
		const body = await res.text()
		const names = res.ok ? parseNames(JSON.parse(body)) : null
		if (names) return { names }
		return { names: staticTestNames(module), loadError: `listing failed with HTTP ${res.status}: ${body.slice(0, 300)}` }
	} catch (err) {
		return { names: staticTestNames(module), loadError: `listing failed: ${err}` }
	}
}

interface ModuleRun {
	module: string
	area: string
	results: Map<string, RunResult>
}

async function runTest(module: string, name: string): Promise<RunResult> {
	try {
		const res = await callModule(module, `/__conformance/run?test=${encodeURIComponent(name)}`)
		const body = await res.text()
		if (!res.ok) return { ok: false, error: `runner returned HTTP ${res.status}: ${body.slice(0, 300)}` }
		try {
			return parseRunResult(JSON.parse(body))
		} catch (err) {
			return { ok: false, error: `unreadable runner response (${err}): ${body.slice(0, 300)}` }
		}
	} catch (err) {
		return { ok: false, error: `runner request failed: ${err}` }
	}
}

// Tests inside a module run in order, as under `workerd test`; modules are separate workers and run concurrently.
async function runModule(module: string, area: string): Promise<ModuleRun> {
	const { names, loadError } = await listTests(module)
	const results = new Map<string, RunResult>()
	for (const name of names) {
		results.set(name, loadError ? { ok: false, error: `module did not load (${loadError})` } : await runTest(module, name))
	}
	return { module, area, results }
}

// Modules with Durable Objects run one at a time, in a lane of their own: lopata keys DO storage by class name and two modules
// declare the same class, so running them concurrently would race on shared storage.
async function runAll(): Promise<ModuleRun[]> {
	const parallel = selectedModules.filter(([, spec]) => !spec.durableObjects)
	const serial = selectedModules.filter(([, spec]) => spec.durableObjects)
	const runs: ModuleRun[] = []
	const lanes = Array.from({ length: MODULE_CONCURRENCY }, async () => {
		for (let next = parallel.shift(); next; next = parallel.shift()) runs.push(await runModule(next[0], next[1].area))
	})
	lanes.push((async () => {
		for (const [module, spec] of serial) runs.push(await runModule(module, spec.area))
	})())
	await Promise.all(lanes)
	return runs.sort((a, b) => a.module.localeCompare(b.module))
}

const known = loadKnownFailures('workerd')
const runs = await runAll()
const areas = [...new Set(runs.map(r => r.area))].sort()

for (const area of areas) {
	describe(area, () => {
		for (const run of runs.filter(r => r.area === area)) {
			for (const [name, result] of run.results) {
				conformanceTest(known, `${run.module}/${name}`, () => {
					if (!result.ok) throw new Error(result.error)
				})
			}
		}
	})
}

import type { Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const FIXTURE_DIR = resolve(import.meta.dir, 'fixtures/agents-week-worker')
const CLI_PATH = resolve(import.meta.dir, '../src/cli.ts')

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			await fetch(url)
			return
		} catch {
			await new Promise(r => setTimeout(r, 200))
		}
	}
	throw new Error(`Server ${url} did not become ready in ${timeoutMs}ms`)
}

function cleanup() {
	try {
		rmSync(resolve(FIXTURE_DIR, '.lopata'), { recursive: true, force: true })
	} catch {}
}

describe('Agents Week bindings (worker-thread runtime)', () => {
	let proc: Subprocess
	const PORT = 18801
	const base = `http://localhost:${PORT}`

	beforeAll(async () => {
		cleanup()
		proc = Bun.spawn(['bun', CLI_PATH, 'dev', '--port', String(PORT)], {
			cwd: FIXTURE_DIR,
			stdout: 'pipe',
			stderr: 'pipe',
		})
		await waitForServer(`${base}/ping`, 15_000)
	}, 20_000)

	afterAll(() => {
		proc?.kill()
		cleanup()
	})

	test('flagship returns the default for an unknown flag', async () => {
		const res = await fetch(`${base}/flagship`)
		expect(await res.json()).toEqual({ value: true, reason: 'DEFAULT' })
	})

	test('vpc network passes a fetch through to an absolute URL', async () => {
		const target = encodeURIComponent(`${base}/ping`)
		const res = await fetch(`${base}/vpc?target=${target}`)
		expect(await res.text()).toBe('pong')
	})

	test('worker loader spawns a dynamic Worker and fetches it', async () => {
		const res = await fetch(`${base}/worker-loader`)
		expect(await res.text()).toBe('dynamic-worker-ok')
	})

	test('ai search namespace binding surfaces in the worker env', async () => {
		const res = await fetch(`${base}/ai-search`)
		expect(await res.text()).toBe('function')
	})

	test('artifacts repo round-trips a git push + clone over HTTP', async () => {
		const repo = await (await fetch(`${base}/artifacts/create`)).json() as {
			id: string
			remote: string
			token: string
		}
		expect(repo.id).toBeTruthy()
		expect(repo.remote).toContain(`:${PORT}/__artifacts/git/${repo.id}.git`)
		expect(repo.token).toMatch(/^art_/)

		// The git smart-HTTP info/refs endpoint (served by main's Bun.serve, backed by
		// `git http-backend`) authenticates against the same SQLite the worker thread
		// wrote the repo + token into.
		const refs = await fetch(`${base}/__artifacts/git/${repo.id}.git/info/refs?service=git-upload-pack`, {
			headers: { Authorization: 'Basic ' + btoa(`artifacts:${repo.token}`) },
		})
		expect(refs.status).toBe(200)
		expect(refs.headers.get('content-type')).toContain('git-upload-pack')

		// Full git roundtrip through the live dev server: push a commit (exercises the
		// write/receive-pack auth path) and clone it back (read/upload-pack). create()
		// returns the token separately, so embed it into the remote URL as Basic auth.
		const authRemote = repo.remote.replace('://', `://artifacts:${repo.token}@`)
		const work = mkdtempSync(join(tmpdir(), 'lopata-aw-push-'))
		const dest = mkdtempSync(join(tmpdir(), 'lopata-aw-clone-'))
		try {
			await runGit(['init', '-b', 'main', work])
			await Bun.write(join(work, 'README.md'), 'hello from agents-week e2e\n')
			await runGit(['-C', work, 'add', 'README.md'])
			await runGit(['-C', work, '-c', 'user.email=test@lopata.local', '-c', 'user.name=Tester', 'commit', '-m', 'initial'])
			await runGit(['-C', work, 'push', authRemote, 'main'])
			await runGit(['clone', authRemote, dest])
			expect(existsSync(join(dest, 'README.md'))).toBe(true)
		} finally {
			rmSync(work, { recursive: true, force: true })
			rmSync(dest, { recursive: true, force: true })
		}
	}, 30_000)
})

async function runGit(args: string[]): Promise<void> {
	const proc = Bun.spawn(['git', ...args], {
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
	})
	const exit = await proc.exited
	if (exit !== 0) {
		const stderr = await new Response(proc.stderr).text()
		throw new Error(`git ${args.join(' ')} failed: ${stderr}`)
	}
}

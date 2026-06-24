import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArtifactsBinding, ArtifactsRepo } from '../src/bindings/artifacts'
import { handleArtifactsGitRequest } from '../src/bindings/artifacts-git-http'
import { runMigrations } from '../src/db'

let db: Database
let tmpDir: string
let artifactsDir: string
let binding: ArtifactsBinding

beforeEach(() => {
	db = new Database(':memory:')
	runMigrations(db)
	tmpDir = mkdtempSync(join(tmpdir(), 'lopata-artifacts-'))
	artifactsDir = join(tmpDir, 'artifacts')
	mkdirSync(artifactsDir, { recursive: true })
	binding = new ArtifactsBinding(db, 'default', artifactsDir, 'http://localhost:8787/__artifacts/git')
})

afterEach(() => {
	db.close()
	rmSync(tmpDir, { recursive: true, force: true })
})

describe('ArtifactsBinding — metadata', () => {
	test('create() initializes bare repo on disk + DB row + plaintext token', async () => {
		const result = await binding.create('my-repo')
		expect(result.name).toBe('my-repo')
		expect(result.defaultBranch).toBe('main')
		expect(result.token).toMatch(/^art_[0-9a-f]{64}$/)
		expect(result.remote).toContain(`/__artifacts/git/${result.id}.git`)
		expect(existsSync(join(artifactsDir, `${result.id}.git`))).toBe(true)
		expect(existsSync(join(artifactsDir, `${result.id}.git`, 'HEAD'))).toBe(true)
	})

	test('create() rejects duplicate names in same namespace', async () => {
		await binding.create('dup')
		await expect(binding.create('dup')).rejects.toThrow(/already exists/)
	})

	test('create() accepts setDefaultBranch option', async () => {
		const result = await binding.create('custom-branch', { setDefaultBranch: 'develop' })
		expect(result.defaultBranch).toBe('develop')
	})

	test('rejects invalid names', async () => {
		await expect(binding.create('../evil')).rejects.toThrow(/Invalid/)
		await expect(binding.create('.hidden')).rejects.toThrow(/Invalid/)
		await expect(binding.create('')).rejects.toThrow(/Invalid/)
	})

	test('get() returns a repo handle', async () => {
		const created = await binding.create('to-get')
		const handle = await binding.get('to-get')
		expect(handle).toBeInstanceOf(ArtifactsRepo)
		expect(handle.id).toBe(created.id)
		expect(handle.name).toBe('to-get')
	})

	test('get() throws for missing repo', async () => {
		await expect(binding.get('nope')).rejects.toThrow(/not found/)
	})

	test('list() paginates results', async () => {
		for (let i = 0; i < 5; i++) {
			await binding.create(`repo-${i}`)
		}
		const page1 = await binding.list({ limit: 2 })
		expect(page1.repos).toHaveLength(2)
		expect(page1.cursor).not.toBeNull()

		const page2 = await binding.list({ limit: 2, cursor: page1.cursor! })
		expect(page2.repos).toHaveLength(2)
	})

	test('delete() removes DB rows + disk repo', async () => {
		const created = await binding.create('to-delete')
		const dir = join(artifactsDir, `${created.id}.git`)
		expect(existsSync(dir)).toBe(true)
		expect(await binding.delete('to-delete')).toBe(true)
		expect(existsSync(dir)).toBe(false)
		expect(await binding.delete('to-delete')).toBe(false)
	})

	test('namespace isolation — repo in one namespace not visible in another', async () => {
		await binding.create('shared-name')
		const other = new ArtifactsBinding(db, 'other-ns', artifactsDir, 'http://localhost:8787/__artifacts/git')
		await expect(other.get('shared-name')).rejects.toThrow(/not found/)
		// Can create with same name in other namespace
		await other.create('shared-name')
	})

	test('fork() creates a new repo cloned from source', async () => {
		const src = await binding.create('source')
		// Write a test commit directly into the source bare repo
		const srcDir = join(artifactsDir, `${src.id}.git`)
		await seedCommit(srcDir)

		const srcHandle = await binding.get('source')
		const forked = await srcHandle.fork('source-fork')
		expect(forked.name).toBe('source-fork')
		expect(forked.id).not.toBe(src.id)
		expect(existsSync(join(artifactsDir, `${forked.id}.git`))).toBe(true)
	})
})

describe('ArtifactsBinding — tokens', () => {
	test('createToken() stores a new plaintext token', async () => {
		const created = await binding.create('tok-test')
		const repo = await binding.get('tok-test')
		const tok = await repo.createToken('read')
		expect(tok.plaintext).toMatch(/^art_/)
		expect(tok.scope).toBe('read')
		expect(tok.expiresAt).toBeNull()

		// The create() already issued a token, so we now have 2 active tokens
		const list = await repo.listTokens()
		expect(list.total).toBe(2)
		expect(list.tokens).toHaveLength(2)
		expect(list.tokens[1]!.scope).toBe('read')
	})

	test('createToken with ttl sets expiresAt', async () => {
		await binding.create('ttl-test')
		const repo = await binding.get('ttl-test')
		const tok = await repo.createToken('write', 3600)
		expect(tok.expiresAt).not.toBeNull()
		const expiry = new Date(tok.expiresAt!).getTime()
		expect(expiry).toBeGreaterThan(Date.now())
	})

	test('revokeToken removes token from active list', async () => {
		await binding.create('revoke-test')
		const repo = await binding.get('revoke-test')
		const tok = await repo.createToken('read')
		expect(await repo.revokeToken(tok.id)).toBe(true)
		const list = await repo.listTokens()
		expect(list.tokens.find(t => t.id === tok.id)).toBeUndefined()
	})

	test('revokeToken by plaintext also works', async () => {
		await binding.create('revoke-plain')
		const repo = await binding.get('revoke-plain')
		const tok = await repo.createToken('read')
		expect(await repo.revokeToken(tok.plaintext)).toBe(true)
	})
})

describe('Artifacts git HTTP backend', () => {
	test('info/refs advertises upload-pack for an empty repo', async () => {
		const created = await binding.create('empty-repo')
		const req = new Request(
			`http://localhost:8787/__artifacts/git/${created.id}.git/info/refs?service=git-upload-pack`,
			{
				headers: {
					Authorization: 'Basic ' + btoa(`artifacts:${created.token}`),
				},
			},
		)
		const resp = await handleArtifactsGitRequest(req, { db, artifactsDir })
		expect(resp).not.toBeNull()
		expect(resp!.status).toBe(200)
		expect(resp!.headers.get('content-type')).toContain('application/x-git-upload-pack-advertisement')
		const body = await resp!.text()
		expect(body).toContain('# service=git-upload-pack')
	})

	test('rejects request without auth', async () => {
		const created = await binding.create('auth-repo')
		const req = new Request(
			`http://localhost:8787/__artifacts/git/${created.id}.git/info/refs?service=git-upload-pack`,
		)
		const resp = await handleArtifactsGitRequest(req, { db, artifactsDir })
		expect(resp!.status).toBe(401)
		expect(resp!.headers.get('www-authenticate')).toContain('Basic')
	})

	test('rejects request with bad token', async () => {
		const created = await binding.create('bad-tok')
		const req = new Request(
			`http://localhost:8787/__artifacts/git/${created.id}.git/info/refs?service=git-upload-pack`,
			{ headers: { Authorization: 'Basic ' + btoa('x:wrong') } },
		)
		const resp = await handleArtifactsGitRequest(req, { db, artifactsDir })
		expect(resp!.status).toBe(401)
	})

	test('rejects write (receive-pack advertise) with read-only token', async () => {
		const created = await binding.create('scope-test')
		const repo = await binding.get('scope-test')
		const readTok = await repo.createToken('read')
		const req = new Request(
			`http://localhost:8787/__artifacts/git/${created.id}.git/info/refs?service=git-receive-pack`,
			{ headers: { Authorization: 'Basic ' + btoa(`x:${readTok.plaintext}`) } },
		)
		const resp = await handleArtifactsGitRequest(req, { db, artifactsDir })
		expect(resp!.status).toBe(401)
	})

	test('rejects unknown repo id', async () => {
		const req = new Request(
			`http://localhost:8787/__artifacts/git/nonexistent-id.git/info/refs?service=git-upload-pack`,
		)
		const resp = await handleArtifactsGitRequest(req, { db, artifactsDir })
		expect(resp!.status).toBe(404)
	})

	test('returns null for non-artifacts paths', async () => {
		const req = new Request('http://localhost:8787/__dashboard/index.html')
		const resp = await handleArtifactsGitRequest(req, { db, artifactsDir })
		expect(resp).toBeNull()
	})
})

describe('Artifacts end-to-end git clone', () => {
	test('seeded repo can be cloned over HTTP', async () => {
		const created = await binding.create('e2e-repo')
		const srcDir = join(artifactsDir, `${created.id}.git`)
		await seedCommit(srcDir)

		// Spin up a Bun server that serves the artifacts endpoint
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				return (await handleArtifactsGitRequest(req, { db, artifactsDir })) ?? new Response('not found', { status: 404 })
			},
		})
		try {
			const cloneDir = join(tmpDir, 'clone-target')
			const remote = `http://artifacts:${created.token}@127.0.0.1:${server.port}/__artifacts/git/${created.id}.git`
			const proc = Bun.spawn(['git', 'clone', remote, cloneDir], {
				stdout: 'pipe',
				stderr: 'pipe',
				env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
			})
			const exit = await proc.exited
			if (exit !== 0) {
				const stderr = await new Response(proc.stderr).text()
				throw new Error(`git clone failed: ${stderr}`)
			}
			expect(existsSync(join(cloneDir, 'README.md'))).toBe(true)
			const readme = await Bun.file(join(cloneDir, 'README.md')).text()
			expect(readme).toBe('hello from lopata artifacts\n')
		} finally {
			server.stop(true)
		}
	}, 30_000)
})

/** Seed a bare repo with a single commit containing README.md. */
async function seedCommit(bareDir: string): Promise<void> {
	// Create a working copy, add a commit, push to the bare repo
	const work = mkdtempSync(join(tmpdir(), 'lopata-seed-'))
	try {
		await runGit(['init', '-b', 'main', work])
		await Bun.write(join(work, 'README.md'), 'hello from lopata artifacts\n')
		await runGit(['-C', work, 'add', 'README.md'])
		await runGit([
			'-C',
			work,
			'-c',
			'user.email=test@lopata.local',
			'-c',
			'user.name=Tester',
			'commit',
			'-m',
			'initial',
		])
		await runGit(['-C', work, 'push', bareDir, 'main'])
	} finally {
		rmSync(work, { recursive: true, force: true })
	}
}

async function runGit(args: string[]): Promise<void> {
	const proc = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'pipe' })
	const exit = await proc.exited
	if (exit !== 0) {
		const stderr = await new Response(proc.stderr).text()
		throw new Error(`git ${args.join(' ')} failed: ${stderr}`)
	}
}

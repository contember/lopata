/**
 * Local implementation of the Cloudflare Artifacts binding.
 *
 * Artifacts on Cloudflare is a control-plane API (create/fork/delete repos,
 * issue tokens) + a Git-over-HTTPS endpoint for content access. The binding
 * only exposes the control plane; actual blob/tree/commit I/O happens via a
 * regular Git client against the returned `remote` URL.
 *
 * In local dev we mirror this split:
 *   - Repo metadata and tokens live in SQLite (`artifacts_repos`, `artifacts_tokens`).
 *   - Each repo is a bare Git repository on disk at `.lopata/artifacts/<repo-id>.git`.
 *   - The lopata dev server exposes `/__artifacts/git/<repo-id>.git/*` backed by
 *     `git http-backend` (see `artifacts-git-http.ts`).
 */
import { randomUUIDv7 } from 'bun'
import type { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export type ArtifactsTokenScope = 'read' | 'write'

export interface CreateRepoOpts {
	readOnly?: boolean
	description?: string
	setDefaultBranch?: string
}

export interface CreateRepoResult {
	id: string
	name: string
	description: string | null
	defaultBranch: string
	remote: string
	token: string
}

export interface TokenResult {
	id: string
	plaintext: string
	scope: ArtifactsTokenScope
	expiresAt: string | null
}

export interface ListReposOpts {
	limit?: number
	cursor?: string
}

export interface RepoListResult {
	repos: { id: string; name: string; remote: string; defaultBranch: string; description: string | null }[]
	cursor: string | null
}

export interface TokenListResult {
	total: number
	tokens: { id: string; scope: ArtifactsTokenScope; expiresAt: string | null; createdAt: string }[]
}

export interface ImportParams {
	source: { url: string; branch?: string; depth?: number }
	target: { name: string; opts?: CreateRepoOpts }
}

export interface ForkOpts {
	description?: string
	readOnly?: boolean
	defaultBranchOnly?: boolean
}

interface RepoRow {
	id: string
	namespace: string
	name: string
	description: string | null
	default_branch: string
	read_only: number
	forked_from: string | null
	created_at: number
}

interface TokenRow {
	id: string
	repo_id: string
	plaintext: string
	scope: string
	expires_at: number | null
	created_at: number
	revoked_at: number | null
}

const VALID_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

function assertValidName(name: string) {
	if (!VALID_NAME.test(name)) {
		throw new Error(`Invalid repo name "${name}" — must match ${VALID_NAME}`)
	}
}

function tsToIso(ts: number | null): string | null {
	return ts == null ? null : new Date(ts).toISOString()
}

export class ArtifactsBinding {
	private readonly db: Database
	private readonly namespace: string
	private readonly artifactsDir: string
	private readonly remoteBase: string
	private readonly gitBinary: string

	constructor(
		db: Database,
		namespace: string,
		artifactsDir: string,
		remoteBase: string,
		gitBinary = 'git',
	) {
		this.db = db
		this.namespace = namespace
		this.artifactsDir = artifactsDir
		this.remoteBase = remoteBase.replace(/\/$/, '')
		this.gitBinary = gitBinary
		mkdirSync(this.artifactsDir, { recursive: true })
	}

	private repoDir(id: string): string {
		return join(this.artifactsDir, `${id}.git`)
	}

	private buildRemote(id: string, token?: string): string {
		const url = new URL(`${this.remoteBase}/${id}.git`)
		if (token) {
			url.username = 'artifacts'
			url.password = token
		}
		return url.toString()
	}

	async create(name: string, opts: CreateRepoOpts = {}): Promise<CreateRepoResult> {
		assertValidName(name)
		const existing = this.db
			.query<RepoRow, [string, string]>('SELECT * FROM artifacts_repos WHERE namespace = ? AND name = ?')
			.get(this.namespace, name)
		if (existing) {
			throw new Error(`Artifacts repo "${name}" already exists in namespace "${this.namespace}"`)
		}

		const id = randomUUIDv7()
		const defaultBranch = opts.setDefaultBranch ?? 'main'
		const description = opts.description ?? null
		const readOnly = opts.readOnly ? 1 : 0

		const dir = this.repoDir(id)
		await initBareRepo(this.gitBinary, dir, defaultBranch)

		this.db.run(
			`INSERT INTO artifacts_repos (id, namespace, name, description, default_branch, read_only, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[id, this.namespace, name, description, defaultBranch, readOnly, Date.now()],
		)

		const token = this.issueToken(id, 'write')

		return {
			id,
			name,
			description,
			defaultBranch,
			remote: this.buildRemote(id),
			token: token.plaintext,
		}
	}

	async get(name: string): Promise<ArtifactsRepo> {
		const row = this.db
			.query<RepoRow, [string, string]>('SELECT * FROM artifacts_repos WHERE namespace = ? AND name = ?')
			.get(this.namespace, name)
		if (!row) {
			throw new Error(`Artifacts repo "${name}" not found in namespace "${this.namespace}"`)
		}
		return new ArtifactsRepo(this, row, this.buildRemote(row.id))
	}

	async list(opts: ListReposOpts = {}): Promise<RepoListResult> {
		const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000)
		const cursor = opts.cursor ? Number.parseInt(opts.cursor, 10) : 0
		const rows = this.db
			.query<RepoRow, [string, number, number]>(
				'SELECT * FROM artifacts_repos WHERE namespace = ? AND created_at >= ? ORDER BY created_at ASC LIMIT ?',
			)
			.all(this.namespace, cursor, limit + 1)

		let nextCursor: string | null = null
		const page = rows.length > limit ? rows.slice(0, limit) : rows
		if (rows.length > limit) {
			nextCursor = String(rows[limit]!.created_at)
		}

		return {
			repos: page.map(r => ({
				id: r.id,
				name: r.name,
				remote: this.buildRemote(r.id),
				defaultBranch: r.default_branch,
				description: r.description,
			})),
			cursor: nextCursor,
		}
	}

	async import(params: ImportParams): Promise<CreateRepoResult> {
		const { source, target } = params
		assertValidName(target.name)
		if (!/^https?:\/\//.test(source.url) && !source.url.startsWith('git@')) {
			throw new Error(`Artifacts import: unsupported source URL "${source.url}"`)
		}

		const existing = this.db
			.query<RepoRow, [string, string]>('SELECT * FROM artifacts_repos WHERE namespace = ? AND name = ?')
			.get(this.namespace, target.name)
		if (existing) {
			throw new Error(`Artifacts repo "${target.name}" already exists in namespace "${this.namespace}"`)
		}

		const id = randomUUIDv7()
		const dir = this.repoDir(id)

		const args = ['clone', '--bare']
		if (source.depth) args.push('--depth', String(source.depth))
		if (source.branch) args.push('--branch', source.branch, '--single-branch')
		args.push(source.url, dir)

		const proc = Bun.spawn([this.gitBinary, ...args], { stdout: 'pipe', stderr: 'pipe' })
		const exit = await proc.exited
		if (exit !== 0) {
			const stderr = await new Response(proc.stderr).text()
			try {
				rmSync(dir, { recursive: true, force: true })
			} catch {}
			throw new Error(`git clone failed (${exit}): ${stderr}`)
		}

		// Determine default branch from the cloned repo's HEAD
		const defaultBranch = await readDefaultBranch(this.gitBinary, dir) ?? source.branch ?? 'main'
		const description = target.opts?.description ?? null
		const readOnly = target.opts?.readOnly ? 1 : 0

		this.db.run(
			`INSERT INTO artifacts_repos (id, namespace, name, description, default_branch, read_only, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[id, this.namespace, target.name, description, defaultBranch, readOnly, Date.now()],
		)

		const token = this.issueToken(id, 'write')
		return {
			id,
			name: target.name,
			description,
			defaultBranch,
			remote: this.buildRemote(id),
			token: token.plaintext,
		}
	}

	async delete(name: string): Promise<boolean> {
		const row = this.db
			.query<RepoRow, [string, string]>('SELECT * FROM artifacts_repos WHERE namespace = ? AND name = ?')
			.get(this.namespace, name)
		if (!row) return false
		this.db.run('DELETE FROM artifacts_tokens WHERE repo_id = ?', [row.id])
		this.db.run('DELETE FROM artifacts_repos WHERE id = ?', [row.id])
		const dir = this.repoDir(row.id)
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
		return true
	}

	/** @internal — also called by `ArtifactsRepo.fork()` */
	async _forkRepo(source: RepoRow, newName: string, opts: ForkOpts = {}): Promise<CreateRepoResult> {
		assertValidName(newName)
		const existing = this.db
			.query<RepoRow, [string, string]>('SELECT * FROM artifacts_repos WHERE namespace = ? AND name = ?')
			.get(this.namespace, newName)
		if (existing) {
			throw new Error(`Artifacts repo "${newName}" already exists in namespace "${this.namespace}"`)
		}

		const id = randomUUIDv7()
		const srcDir = this.repoDir(source.id)
		const dstDir = this.repoDir(id)

		const cloneArgs = ['clone', '--bare']
		if (opts.defaultBranchOnly) cloneArgs.push('--single-branch', '--branch', source.default_branch)
		cloneArgs.push(srcDir, dstDir)

		const proc = Bun.spawn([this.gitBinary, ...cloneArgs], { stdout: 'pipe', stderr: 'pipe' })
		const exit = await proc.exited
		if (exit !== 0) {
			const stderr = await new Response(proc.stderr).text()
			try {
				rmSync(dstDir, { recursive: true, force: true })
			} catch {}
			throw new Error(`git clone (fork) failed (${exit}): ${stderr}`)
		}

		const description = opts.description ?? null
		const readOnly = opts.readOnly ? 1 : 0
		this.db.run(
			`INSERT INTO artifacts_repos (id, namespace, name, description, default_branch, read_only, forked_from, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			[id, this.namespace, newName, description, source.default_branch, readOnly, source.id, Date.now()],
		)

		const token = this.issueToken(id, 'write')
		return {
			id,
			name: newName,
			description,
			defaultBranch: source.default_branch,
			remote: this.buildRemote(id),
			token: token.plaintext,
		}
	}

	/** @internal — called by `ArtifactsRepo.createToken()`, `ArtifactsBinding.create()`. */
	issueToken(repoId: string, scope: ArtifactsTokenScope, ttlSeconds?: number): TokenResult {
		const id = randomUUIDv7()
		const plaintext = generateTokenString()
		const createdAt = Date.now()
		const expiresAt = ttlSeconds ? createdAt + ttlSeconds * 1000 : null
		this.db.run(
			`INSERT INTO artifacts_tokens (id, repo_id, plaintext, scope, expires_at, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			[id, repoId, plaintext, scope, expiresAt, createdAt],
		)
		return {
			id,
			plaintext,
			scope,
			expiresAt: tsToIso(expiresAt),
		}
	}

	/** @internal */
	listTokens(repoId: string): TokenListResult {
		const rows = this.db
			.query<TokenRow, [string]>(
				'SELECT * FROM artifacts_tokens WHERE repo_id = ? AND revoked_at IS NULL ORDER BY created_at ASC',
			)
			.all(repoId)
		const tokens = rows.map(r => ({
			id: r.id,
			scope: r.scope as ArtifactsTokenScope,
			expiresAt: tsToIso(r.expires_at),
			createdAt: new Date(r.created_at).toISOString(),
		}))
		return { total: tokens.length, tokens }
	}

	/** @internal */
	revokeTokenById(repoId: string, tokenOrId: string): boolean {
		// Accept either the plaintext token or the id
		const now = Date.now()
		const info = this.db.run(
			'UPDATE artifacts_tokens SET revoked_at = ? WHERE repo_id = ? AND revoked_at IS NULL AND (id = ? OR plaintext = ?)',
			[now, repoId, tokenOrId, tokenOrId],
		)
		return info.changes > 0
	}
}

export class ArtifactsRepo {
	private readonly binding: ArtifactsBinding
	private readonly row: RepoRow
	readonly remote: string

	constructor(binding: ArtifactsBinding, row: RepoRow, remote: string) {
		this.binding = binding
		this.row = row
		this.remote = remote
	}

	get id(): string {
		return this.row.id
	}

	get name(): string {
		return this.row.name
	}

	get defaultBranch(): string {
		return this.row.default_branch
	}

	get description(): string | null {
		return this.row.description
	}

	async createToken(scope: ArtifactsTokenScope = 'write', ttl?: number): Promise<TokenResult> {
		return this.binding.issueToken(this.row.id, scope, ttl)
	}

	async listTokens(): Promise<TokenListResult> {
		return this.binding.listTokens(this.row.id)
	}

	async revokeToken(tokenOrId: string): Promise<boolean> {
		return this.binding.revokeTokenById(this.row.id, tokenOrId)
	}

	async fork(name: string, opts: ForkOpts = {}): Promise<CreateRepoResult> {
		return this.binding._forkRepo(this.row, name, opts)
	}
}

// ─── helpers ─────────────────────────────────────────────────────────

function generateTokenString(): string {
	// 32 bytes → 64 hex chars
	const bytes = crypto.getRandomValues(new Uint8Array(32))
	return 'art_' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

async function initBareRepo(gitBinary: string, dir: string, defaultBranch: string): Promise<void> {
	mkdirSync(dir, { recursive: true })
	const proc = Bun.spawn(
		[gitBinary, 'init', '--bare', '--initial-branch', defaultBranch, dir],
		{ stdout: 'pipe', stderr: 'pipe' },
	)
	const exit = await proc.exited
	if (exit !== 0) {
		const stderr = await new Response(proc.stderr).text()
		try {
			rmSync(dir, { recursive: true, force: true })
		} catch {}
		throw new Error(`git init --bare failed (${exit}): ${stderr}`)
	}
	// Allow HTTP access without explicit "git config http.receivepack true"
	const cfg = Bun.spawn(
		[gitBinary, '-C', dir, 'config', 'http.receivepack', 'true'],
		{ stdout: 'pipe', stderr: 'pipe' },
	)
	await cfg.exited
}

async function readDefaultBranch(gitBinary: string, dir: string): Promise<string | null> {
	const proc = Bun.spawn(
		[gitBinary, '-C', dir, 'symbolic-ref', '--short', 'HEAD'],
		{ stdout: 'pipe', stderr: 'pipe' },
	)
	const exit = await proc.exited
	if (exit !== 0) return null
	const out = (await new Response(proc.stdout).text()).trim()
	return out || null
}

/**
 * Git HTTP protocol handler for the Artifacts binding.
 *
 * Proxies `/__artifacts/git/<repo-id>.git/<path>` requests to the `git http-backend`
 * CGI binary. Authentication is via HTTP Basic (username ignored, password = token
 * from `artifacts_tokens`). Read operations (`git-upload-pack`) accept any non-revoked
 * token; write operations (`git-receive-pack`) require a `write`-scoped token.
 *
 * Repos marked read-only (`read_only = 1`) reject write requests regardless of scope.
 */
import type { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

interface RepoRow {
	id: string
	read_only: number
}

interface TokenRow {
	scope: string
	expires_at: number | null
	revoked_at: number | null
}

const GIT_PATH_RE = /^\/__artifacts\/git\/([^/]+)\.git(\/.*)?$/

export interface ArtifactsGitHandlerOptions {
	db: Database
	artifactsDir: string
	gitBinary?: string
	/** When true (tests), skip token validation. */
	skipAuth?: boolean
}

export async function handleArtifactsGitRequest(
	request: Request,
	opts: ArtifactsGitHandlerOptions,
): Promise<Response | null> {
	const url = new URL(request.url)
	const match = url.pathname.match(GIT_PATH_RE)
	if (!match) return null

	const repoId = match[1]!
	const subPath = match[2] ?? '/'
	const repo = opts.db
		.query<RepoRow, [string]>('SELECT id, read_only FROM artifacts_repos WHERE id = ?')
		.get(repoId)
	if (!repo) {
		return new Response('Not found', { status: 404 })
	}

	const repoDir = join(opts.artifactsDir, `${repoId}.git`)
	if (!existsSync(repoDir)) {
		return new Response('Repo directory missing', { status: 500 })
	}

	// Decide if this is a write request
	const isWrite = isWriteRequest(request.method, subPath, url.searchParams.get('service'))
	if (isWrite && repo.read_only) {
		return new Response('Repo is read-only', { status: 403 })
	}

	if (!opts.skipAuth) {
		const authResult = authenticate(request, opts.db, repoId, isWrite)
		if (!authResult.ok) {
			return new Response(authResult.message, {
				status: 401,
				headers: {
					'WWW-Authenticate': 'Basic realm="Artifacts"',
				},
			})
		}
	}

	return proxyToGitHttpBackend(request, subPath, repoDir, opts.gitBinary ?? 'git')
}

function isWriteRequest(method: string, subPath: string, service: string | null): boolean {
	if (method === 'POST' && subPath === '/git-receive-pack') return true
	if (method === 'GET' && subPath === '/info/refs' && service === 'git-receive-pack') return true
	return false
}

interface AuthResult {
	ok: boolean
	message: string
}

function authenticate(request: Request, db: Database, repoId: string, writeNeeded: boolean): AuthResult {
	const authHeader = request.headers.get('authorization')
	if (!authHeader) {
		return { ok: false, message: 'Authentication required' }
	}
	let token: string | null = null
	if (authHeader.startsWith('Bearer ')) {
		token = authHeader.slice(7).trim()
	} else if (authHeader.startsWith('Basic ')) {
		try {
			const decoded = atob(authHeader.slice(6).trim())
			const colonIdx = decoded.indexOf(':')
			token = colonIdx === -1 ? decoded : decoded.slice(colonIdx + 1)
		} catch {
			return { ok: false, message: 'Invalid Basic auth encoding' }
		}
	}
	if (!token) {
		return { ok: false, message: 'Missing token' }
	}
	const row = db
		.query<TokenRow, [string, string]>(
			'SELECT scope, expires_at, revoked_at FROM artifacts_tokens WHERE repo_id = ? AND plaintext = ?',
		)
		.get(repoId, token)
	if (!row) {
		return { ok: false, message: 'Invalid token' }
	}
	if (row.revoked_at != null) {
		return { ok: false, message: 'Token revoked' }
	}
	if (row.expires_at != null && row.expires_at < Date.now()) {
		return { ok: false, message: 'Token expired' }
	}
	if (writeNeeded && row.scope !== 'write') {
		return { ok: false, message: 'Token lacks write scope' }
	}
	return { ok: true, message: 'ok' }
}

async function proxyToGitHttpBackend(
	request: Request,
	subPath: string,
	repoDir: string,
	gitBinary: string,
): Promise<Response> {
	const url = new URL(request.url)

	// CGI env variables required by git http-backend
	const env: Record<string, string> = {
		// Point GIT_PROJECT_ROOT at the repo parent so PATH_INFO can be "/<id>.git/..."
		// But easier: point directly and use PATH_TRANSLATED + GIT_HTTP_EXPORT_ALL.
		// We use PATH_TRANSLATED which tells http-backend exactly which repo dir to serve.
		PATH_TRANSLATED: `${repoDir}${subPath}`,
		GIT_HTTP_EXPORT_ALL: '1',
		REQUEST_METHOD: request.method,
		QUERY_STRING: url.search.startsWith('?') ? url.search.slice(1) : url.search,
		CONTENT_TYPE: request.headers.get('content-type') ?? '',
		REMOTE_USER: 'artifacts',
		REMOTE_ADDR: '127.0.0.1',
		// Let git detect encoding
		HTTP_CONTENT_ENCODING: request.headers.get('content-encoding') ?? '',
		HTTP_USER_AGENT: request.headers.get('user-agent') ?? 'lopata-artifacts',
	}

	const proc = Bun.spawn([gitBinary, 'http-backend'], {
		env,
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'pipe',
	})

	// Pipe request body into the CGI's stdin (if any)
	if (request.body) {
		request.body.pipeTo(
			new WritableStream({
				async write(chunk) {
					proc.stdin.write(chunk)
				},
				close() {
					proc.stdin.end()
				},
				abort() {
					proc.stdin.end()
				},
			}),
		).catch(() => {})
	} else {
		proc.stdin.end()
	}

	// Read full stdout (git http-backend writes CGI-formatted response: headers + body)
	const stdoutBytes = new Uint8Array(await new Response(proc.stdout).arrayBuffer())
	const exitCode = await proc.exited
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text()
		return new Response(`git http-backend failed (${exitCode}): ${stderr}`, { status: 500 })
	}

	return parseCgiResponse(stdoutBytes)
}

function parseCgiResponse(raw: Uint8Array): Response {
	// Find header/body separator: \r\n\r\n or \n\n
	let headerEnd = indexOfDouble(raw, 0x0d, 0x0a) // \r\n\r\n
	let separatorLen = 4
	if (headerEnd === -1) {
		headerEnd = indexOfDouble(raw, 0x0a, 0x0a) // \n\n
		separatorLen = 2
	}

	let headerBytes: Uint8Array
	let body: Uint8Array
	if (headerEnd === -1) {
		headerBytes = new Uint8Array(0)
		body = raw
	} else {
		headerBytes = raw.slice(0, headerEnd)
		body = raw.slice(headerEnd + separatorLen)
	}

	const headers = new Headers()
	let status = 200
	let statusText = 'OK'
	const headerText = new TextDecoder().decode(headerBytes)
	for (const line of headerText.split(/\r?\n/)) {
		if (!line) continue
		const colon = line.indexOf(':')
		if (colon === -1) continue
		const key = line.slice(0, colon).trim().toLowerCase()
		const value = line.slice(colon + 1).trim()
		if (key === 'status') {
			const m = value.match(/^(\d+)\s*(.*)$/)
			if (m) {
				status = Number.parseInt(m[1]!, 10)
				statusText = m[2] ?? ''
			}
		} else {
			headers.append(key, value)
		}
	}

	return new Response(body, { status, statusText, headers })
}

function indexOfDouble(buf: Uint8Array, a: number, b: number): number {
	// Find position of a,b,a,b (4-byte) or a,a (2-byte) pattern — caller chose pattern length.
	// For \r\n\r\n: a=\r=0x0d, b=\n=0x0a, need 4 bytes
	// For \n\n: a=\n=0x0a, b=\n=0x0a, need 2 bytes; simpler to special-case
	if (a === b) {
		for (let i = 0; i + 1 < buf.length; i++) {
			if (buf[i] === a && buf[i + 1] === b) return i
		}
		return -1
	}
	for (let i = 0; i + 3 < buf.length; i++) {
		if (buf[i] === a && buf[i + 1] === b && buf[i + 2] === a && buf[i + 3] === b) return i
	}
	return -1
}
